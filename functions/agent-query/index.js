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

module.exports = async function(req) {
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
};

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
      await setCache(cacheKey, warmResult, 3600);
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
 * DuckDB 查询（简化版，返回空数组）
 * TODO: 集成 DuckDB WASM 或 CLI
 */
async function queryDuckDB(sql) {
  console.log('[agent-query] DuckDB query:', sql);
  // 暂时返回空数组，待后续集成
  return [];
}

/**
 * 保存审计日志
 */
async function saveAuditLog(log) {
  try {
    await fetch(`${INSFORGE_URL}/rest/v1/agent_query_logs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INSFORGE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(log)
    });
  } catch (error) {
    console.error('[agent-query] Failed to save audit log:', error);
  }
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
 * 工具函数：缓存操作
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