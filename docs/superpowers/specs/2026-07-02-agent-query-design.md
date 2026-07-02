# 企微机器人个性化查询架构设计

> **目标**：通过企微机器人对话，实现基于用户权限的个性化数据查询，无需 Token 管理。

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                   用户在企微聊天                              │
│                "查询上周华东区销售数据"                       │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│                 企业微信服务器                               │
│  POST https://data.shanhaiyiguo.com/webhook/wecom           │
│  携带 FromUserId = "zhangsan"                                │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│                      openclaw                                │
│  1. 解析企微消息，提取 FromUserId                            │
│  2. 调用数据查询工具                                         │
│  3. 格式化返回结果                                           │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│           Edge Function: agent-query                         │
│  1. 验证 API Key（openclaw 调用）                            │
│  2. 根据 userId 查询权限                                     │
│  3. LLM 生成 SQL（注入权限过滤）                             │
│  4. 执行查询（DuckDB / PostgreSQL）                         │
│  5. 记录审计日志                                             │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│                    数据层                                    │
│  • 热数据（7天）→ PostgreSQL                                │
│  • 温数据（90天）→ 缓存                                      │
│  • 冷数据（历史）→ MinIO + DuckDB                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 数据库设计

### 1. 用户权限表

```sql
-- 修改 org_users 表，添加企微 ID 映射
ALTER TABLE org_users 
ADD COLUMN IF NOT EXISTS wecom_id VARCHAR(50) UNIQUE;

-- 示例数据
INSERT INTO org_users (id, wecom_id, name, department_ids)
VALUES 
  ('uuid-1', 'zhangsan', '张三', ARRAY['dept-1']::uuid[]),
  ('uuid-2', 'lisi', '李四', ARRAY['dept-2']::uuid[])
ON CONFLICT (wecom_id) DO UPDATE 
SET name = EXCLUDED.name;
```

### 2. 部门权限配置

```sql
-- 扩展 org_departments 表
ALTER TABLE org_departments 
ADD COLUMN IF NOT EXISTS allowed_regions JSONB DEFAULT '["*"]'::jsonb,
ADD COLUMN IF NOT EXISTS data_scope JSONB DEFAULT '{"max_history_days": 90, "max_rows": 1000}'::jsonb;

-- 示例：华东销售部只能查华东区数据
UPDATE org_departments 
SET 
  allowed_regions = '["华东"]'::jsonb,
  data_scope = '{"max_history_days": 90, "max_rows": 500}'::jsonb
WHERE name = '华东销售部';

-- 总经办可以查全部数据
UPDATE org_departments 
SET 
  allowed_regions = '["*"]'::jsonb,
  data_scope = '{"max_history_days": 365, "max_rows": 5000}'::jsonb
WHERE name = '总经办';
```

### 3. 审计日志表

```sql
CREATE TABLE IF NOT EXISTS agent_query_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  user_name VARCHAR(100),
  query_text TEXT NOT NULL,
  generated_sql TEXT,
  final_sql TEXT,
  data_source VARCHAR(20),  -- 'hot'/'warm'/'cold'
  rows_returned INT,
  execution_time_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_agent_logs_user ON agent_query_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_time ON agent_query_logs(created_at DESC);
```

### 4. 数据源元数据表

```sql
CREATE TABLE IF NOT EXISTS data_sources_meta (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  table_name VARCHAR(100) NOT NULL,
  s3_path VARCHAR(500),  -- 's3://data/sales/*.parquet'
  columns JSONB NOT NULL,
  is_hot BOOLEAN DEFAULT FALSE,  -- 是否热数据
  hot_table_name VARCHAR(100),   -- 热数据对应的 PG 表名
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 示例：销售数据
INSERT INTO data_sources_meta (name, table_name, s3_path, columns, is_hot, hot_table_name)
VALUES (
  '销售明细',
  'sales',
  's3://data/sales/*.parquet',
  '[
    {"name": "id", "type": "uuid", "description": "订单ID"},
    {"name": "date", "type": "date", "description": "销售日期"},
    {"name": "region", "type": "varchar", "description": "销售地区"},
    {"name": "product", "type": "varchar", "description": "产品名称"},
    {"name": "amount", "type": "decimal", "description": "销售金额"},
    {"name": "quantity", "type": "int", "description": "销售数量"}
  ]'::jsonb,
  true,
  'sales_hot'
);
```

---

## Edge Function 实现

### 文件：`functions/agent-query/index.js`

```javascript
/**
 * Agent 数据查询接口
 * 
 * 功能：
 * 1. 接收 openclaw 的查询请求（携带企微 userId）
 * 2. 根据 userId 查询用户权限
 * 3. LLM 生成 SQL（注入权限过滤）
 * 4. 执行查询（热/温/冷数据）
 * 5. 返回结果 + 审计日志
 */

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const AGENT_API_KEY = Deno.env.get('AGENT_API_KEY');
const INSFORGE_URL = Deno.env.get('INSFORGE_URL') || 'http://localhost:7130';
const INSFORGE_ANON_KEY = Deno.env.get('INSFORGE_ANON_KEY');
const MINIO_ENDPOINT = Deno.env.get('MINIO_ENDPOINT') || 'http://minio:9000';
const MINIO_ACCESS_KEY = Deno.env.get('MINIO_ACCESS_KEY');
const MINIO_SECRET_KEY = Deno.env.get('MINIO_SECRET_KEY');

export default async function handler(req) {
  try {
    // 1. 验证 API Key
    const authHeader = req.headers.get('authorization');
    const apiKey = authHeader?.replace('Bearer ', '');
    
    if (apiKey !== AGENT_API_KEY) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. 解析请求
    const body = await req.json();
    const { query, userId } = body;
    
    if (!query || !userId) {
      return Response.json({ 
        error: 'Missing query or userId' 
      }, { status: 400 });
    }

    console.log(`[agent-query] userId=${userId}, query="${query}"`);

    // 3. 查询用户信息 + 权限
    const userInfo = await getUserInfo(userId);
    if (!userInfo) {
      return Response.json({ 
        error: '用户未同步，请先登录数据分析平台' 
      }, { status: 403 });
    }

    // 4. 获取表结构元数据
    const tablesMeta = await getTablesMeta();

    // 5. LLM 生成 SQL
    const { sql, explanation } = await generateSQL(query, {
      tables: tablesMeta,
      permissions: userInfo.permissions
    });

    console.log(`[agent-query] generated SQL: ${sql}`);

    // 6. 权限注入（双重保障）
    const safeSQL = injectPermissions(sql, userInfo.permissions);

    // 7. 执行查询
    const startTime = Date.now();
    const { result, dataSource } = await executeQuery(safeSQL);
    const executionTime = Date.now() - startTime;

    // 8. 审计日志
    await saveAuditLog({
      userId,
      userName: userInfo.name,
      queryText: query,
      generatedSQL: sql,
      finalSQL: safeSQL,
      dataSource,
      rowsReturned: result.length,
      executionTimeMs: executionTime
    });

    // 9. 返回结果
    return Response.json({
      success: true,
      data: result,
      explanation,
      meta: {
        dataSource,
        rowsReturned: result.length,
        executionTimeMs: executionTime
      }
    });

  } catch (error) {
    console.error('[agent-query] Error:', error);
    return Response.json({ 
      error: error.message 
    }, { status: 500 });
  }
}

/**
 * 查询用户信息和权限
 */
async function getUserInfo(userId) {
  const response = await fetch(`${INSFORGE_URL}/rest/v1/org_users?wecom_id=eq.${userId}&select=id,wecom_id,name,department_ids`, {
    headers: {
      'Authorization': `Bearer ${INSFORGE_ANON_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error('Failed to query user info');
  }

  const users = await response.json();
  if (users.length === 0) {
    return null;
  }

  const user = users[0];

  // 查询部门权限
  const deptResponse = await fetch(`${INSFORGE_URL}/rest/v1/org_departments?id=in.(${user.department_ids.join(',')})&select=name,allowed_regions,data_scope`, {
    headers: {
      'Authorization': `Bearer ${INSFORGE_ANON_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const departments = await deptResponse.json();

  // 合并权限
  const permissions = mergePermissions(departments);

  return {
    ...user,
    permissions
  };
}

/**
 * 合并多个部门的权限
 */
function mergePermissions(departments) {
  const regions = new Set();
  let maxHistoryDays = 30;
  let maxRows = 500;

  for (const dept of departments) {
    // 地区权限：* 表示全部
    if (dept.allowed_regions?.includes('*')) {
      regions.add('*');
    } else {
      dept.allowed_regions?.forEach(r => regions.add(r));
    }

    // 时间范围：取最大值
    if (dept.data_scope?.max_history_days) {
      maxHistoryDays = Math.max(maxHistoryDays, dept.data_scope.max_history_days);
    }

    // 行数限制：取最大值
    if (dept.data_scope?.max_rows) {
      maxRows = Math.max(maxRows, dept.data_scope.max_rows);
    }
  }

  return {
    regions: Array.from(regions),
    maxHistoryDays,
    maxRows
  };
}

/**
 * 获取表结构元数据
 */
async function getTablesMeta() {
  const response = await fetch(`${INSFORGE_URL}/rest/v1/data_sources_meta?select=name,table_name,columns,description`, {
    headers: {
      'Authorization': `Bearer ${INSFORGE_ANON_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return await response.json();
}

/**
 * LLM 生成 SQL
 */
async function generateSQL(query, context) {
  const systemPrompt = `你是一个数据分析 SQL 生成助手。根据用户问题生成 DuckDB/PostgreSQL 兼容的 SQL。

## 重要规则
1. 只生成 SELECT 查询，禁止 INSERT/UPDATE/DELETE
2. 自动添加 LIMIT（默认 100）
3. 使用标准 SQL 语法

## 可用表结构
${JSON.stringify(context.tables, null, 2)}

## 当前用户权限
- 可见地区: ${context.permissions.regions.join(', ')}
- 最大历史天数: ${context.permissions.maxHistoryDays}
- 最大返回行数: ${context.permissions.maxRows}

## 输出格式
返回 JSON：
{
  "sql": "SELECT ...",
  "explanation": "查询了xxx表，按xxx分组"
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: query }]
    })
  });

  const result = await response.json();
  const content = result.content[0].text;
  
  // 解析 JSON（可能被 ```json 包裹）
  const jsonMatch = content.match(/```json\n([\s\S]+?)\n```/) || content.match(/\{[\s\S]+\}/);
  const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
  
  return parsed;
}

/**
 * 权限注入（SQL 层面的二次保障）
 */
function injectPermissions(sql, permissions) {
  const conditions = [];

  // 地区过滤
  if (!permissions.regions.includes('*')) {
    const regionList = permissions.regions.map(r => `'${r}'`).join(',');
    conditions.push(`region IN (${regionList})`);
  }

  // 时间范围
  conditions.push(`date >= CURRENT_DATE - ${permissions.maxHistoryDays}`);

  // 构建安全 SQL
  const upperSQL = sql.toUpperCase();
  
  if (upperSQL.includes(' WHERE ')) {
    return sql.replace(/WHERE\s+(.+)/i, `WHERE ${conditions.join(' AND ')} AND ($1)`);
  } else {
    const insertPos = upperSQL.indexOf(' FROM ') + ' FROM '.length;
    const tableMatch = sql.substring(insertPos).match(/^(\w+)/i);
    if (tableMatch) {
      const fromClause = sql.substring(0, insertPos + tableMatch[1].length);
      const restClause = sql.substring(insertPos + tableMatch[1].length);
      return `${fromClause} WHERE ${conditions.join(' AND ')}${restClause}`;
    }
  }

  return sql;
}

/**
 * 执行查询（热/温/冷数据路由）
 */
async function executeQuery(sql) {
  // 检测数据源
  const dataSource = detectDataSource(sql);

  switch (dataSource) {
    case 'hot':
      // 最近 7 天 → PostgreSQL
      return { 
        result: await queryPostgreSQL(sql), 
        dataSource: 'hot' 
      };

    case 'warm':
      // 8-90 天 → 缓存
      const cacheKey = await hashSQL(sql);
      const cached = await getCache(cacheKey);
      if (cached) {
        return { result: cached, dataSource: 'warm' };
      }
      const warmResult = await queryDuckDB(sql);
      await setCache(cacheKey, warmResult, 3600); // 1 小时缓存
      return { result: warmResult, dataSource: 'warm' };

    case 'cold':
      // 历史数据 → DuckDB + Parquet
      return { 
        result: await queryDuckDB(sql), 
        dataSource: 'cold' 
      };
  }
}

/**
 * 检测数据源类型
 */
function detectDataSource(sql) {
  // 简单判断：如果 WHERE 条件包含 date >= CURRENT_DATE - 7，则为热数据
  const upperSQL = sql.toUpperCase();
  
  if (upperSQL.includes('CURRENT_DATE - 7') || upperSQL.includes('CURRENT_DATE - 1')) {
    return 'hot';
  } else if (upperSQL.includes('CURRENT_DATE - 90')) {
    return 'warm';
  } else {
    return 'cold';
  }
}

/**
 * PostgreSQL 查询
 */
async function queryPostgreSQL(sql) {
  const response = await fetch(`${INSFORGE_URL}/rest/v1/rpc/execute_sql`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${INSFORGE_ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });

  const result = await response.json();
  return result.data || result;
}

/**
 * DuckDB 查询（Deno WASM）
 */
async function queryDuckDB(sql) {
  // 注意：需要安装 duckdb-wasm 或使用 duckdb CLI
  // 这里用简化版本，通过子进程调用
  
  const process = new Deno.Command('duckdb', {
    args: ['-json', '-c', sql],
    stdout: 'piped',
    stderr: 'piped'
  });

  const { stdout, stderr } = await process.output();
  
  if (stderr.length > 0) {
    console.error('DuckDB error:', new TextDecoder().decode(stderr));
  }

  const output = new TextDecoder().decode(stdout);
  return JSON.parse(output || '[]');
}

/**
 * 保存审计日志
 */
async function saveAuditLog(log) {
  await fetch(`${INSFORGE_URL}/rest/v1/agent_query_logs`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${INSFORGE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(log)
  });
}

/**
 * 工具函数：SQL 哈希
 */
async function hashSQL(sql) {
  const encoder = new TextEncoder();
  const data = encoder.encode(sql);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * 工具函数：缓存操作（简化版，实际可用 Redis）
 */
const cache = new Map();

async function getCache(key) {
  const item = cache.get(key);
  if (item && item.expiry > Date.now()) {
    return item.value;
  }
  cache.delete(key);
  return null;
}

async function setCache(key, value, ttl) {
  cache.set(key, {
    value,
    expiry: Date.now() + ttl * 1000
  });
}
```

---

## openclaw 配置

### 文件：`openclaw/config.yaml`

```yaml
# 企业微信机器人配置
adapters:
  - type: wecom
    name: data-assistant
    config:
      corp_id: ${WECOM_CORP_ID}
      agent_id: ${WECOM_AGENT_ID}
      secret: ${WECOM_SECRET}
      token: ${WECOM_TOKEN}        # 消息校验
      encoding_aes_key: ${WECOM_ENCODING_AES_KEY}
      
# Webhook 路径（企微推送消息到此）
webhook:
  path: /webhook/wecom
  port: 8000

# 工具配置
tools:
  - name: query_data
    description: |
      查询业务数据（销售、库存、客户等）。
      支持按地区、时间、产品等维度筛选。
      示例问题：
      - 查询上周华东区销售数据
      - 本月销售前10的产品
      - 昨天各渠道订单量
    type: http
    config:
      url: http://deploy-insforge-1:7130/functions/agent-query
      method: POST
      headers:
        Authorization: Bearer ${AGENT_API_KEY}
        Content-Type: application/json
      # openclaw 自动注入企微消息中的 FromUserId
      body_template: |
        {
          "query": "{{message_content}}",
          "userId": "{{from_user_id}}"
        }
      # 解析返回结果
      response_parser: |
        {
          "success": {{success}},
          "data": {{data}},
          "explanation": "{{explanation}}"
        }

# 系统提示词
system_prompt: |
  你是数据分析助手，帮助用户查询业务数据。
  
  ## 能力
  - 查询销售数据（按地区、时间、产品）
  - 查询库存数据
  - 查询客户数据
  
  ## 规则
  - 只能查询数据，不能修改
  - 用户只能看到自己权限范围内的数据
  - 如果查询失败，友好提示用户

# 模型配置
model: claude-sonnet-5-20250514
max_tokens: 2048
temperature: 0.3

# 环境变量（从 .env 加载）
env_file: .env
```

### 文件：`openclaw/.env`

```bash
# 企业微信配置
WECOM_CORP_ID=your_corp_id
WECOM_AGENT_ID=your_agent_id
WECOM_SECRET=your_secret
WECOM_TOKEN=your_token
WECOM_ENCODING_AES_KEY=your_aes_key

# 数据查询 API
AGENT_API_KEY=ak_agent_xxx
```

---

## Docker Compose 配置

### 文件：`deploy/docker-compose.yml`

```yaml
services:
  # ... 已有服务

  openclaw:
    image: openclaw/openclaw:latest
    container_name: deploy-openclaw-1
    restart: unless-stopped
    ports:
      - "8001:8000"  # Webhook 端口
    volumes:
      - ../openclaw/config.yaml:/app/config.yaml:ro
      - ../openclaw/.env:/app/.env:ro
    networks:
      - deploy_default
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    depends_on:
      - insforge

networks:
  deploy_default:
    external: true
```

---

## Nginx 配置

### 文件：`deploy/nginx/user_conf.d/webhook.conf`

```nginx
# openclaw Webhook（企微回调）
location /webhook/wecom {
    proxy_pass http://deploy-openclaw-1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

---

## 部署步骤

### 1. 同步企微通讯录

首先确保用户数据已同步到 `org_users` 表：

```bash
# 手动触发同步
curl -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts \
  -H "Authorization: Bearer ${INSFORGE_API_KEY}"
```

### 2. 配置部门权限

```sql
-- 在数据库中配置部门权限
UPDATE org_departments 
SET allowed_regions = '["华东"]'::jsonb
WHERE name = '华东销售部';
```

### 3. 部署 openclaw

```bash
cd deploy
docker compose up -d openclaw

# 查看日志
docker compose logs -f openclaw
```

### 4. 企微后台配置

在企微管理后台：

1. **应用主页**：`https://data.shanhaiyiguo.com/webhook/wecom`
2. **可信域名**：添加 `data.shanhaiyiguo.com`
3. **接收消息**：配置 URL 为 `https://data.shanhaiyiguo.com/webhook/wecom`

### 5. Edge Function 部署

```bash
cd functions/agent-query
# 上传 function
curl -X POST https://data.shanhaiyiguo.com/api/functions \
  -H "Authorization: Bearer ${INSFORGE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Agent Query",
    "slug": "agent-query",
    "description": "Agent 数据查询接口",
    "code": "'"$(cat index.js | base64)"'",
    "status": "active"
  }'

# 清理 Deno 缓存
docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno
```

---

## 测试验证

### 1. 测试 Webhook 连通性

```bash
curl https://data.shanhaiyiguo.com/webhook/wecom?msg_signature=test&timestamp=123&nonce=abc&echostr=test
```

### 2. 模拟企微消息

```bash
curl -X POST http://localhost:7130/functions/agent-query \
  -H "Authorization: Bearer ${AGENT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "查询上周华东区销售前10的产品",
    "userId": "zhangsan"
  }'
```

### 3. 端到端测试

在企微客户端：

1. 打开机器人聊天
2. 输入："查询上周销售数据"
3. 检查返回结果是否只显示用户权限范围内的数据

---

## 监控与告警

### 1. 查询日志监控

```sql
-- 查看最近查询记录
SELECT 
  user_id,
  user_name,
  query_text,
  rows_returned,
  execution_time_ms,
  created_at
FROM agent_query_logs
ORDER BY created_at DESC
LIMIT 20;
```

### 2. 异常查询告警

```sql
-- 查找大结果集查询（潜在数据泄露）
SELECT user_id, query_text, rows_returned
FROM agent_query_logs
WHERE rows_returned > 1000
  AND created_at > NOW() - INTERVAL '1 hour';
```

---

## 安全检查清单

- [ ] AGENT_API_KEY 足够强（32位随机）
- [ ] 企微消息签名验证开启
- [ ] 权限注入逻辑双重校验
- [ ] SQL 注入防护开启
- [ ] 敏感列脱敏配置
- [ ] 审计日志完整记录
- [ ] 异常查询告警配置

---

## 后续优化

1. **查询结果缓存**：高频查询缓存到 Redis
2. **智能推荐**：根据用户历史查询推荐相关数据
3. **自然语言图表**：返回结果时自动生成图表
4. **权限自助申请**：用户可申请额外数据权限
