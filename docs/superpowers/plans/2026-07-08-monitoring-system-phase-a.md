# 监控告警体系 Phase A 实施计划（基础设施 + service_down + token_expire）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起监控告警引擎骨架（规则表 + 告警状态表 + 扫描循环 + 生命周期/降噪 + 主/兜底通知通道），并落地两个最高价值检查：`service_down`（应用级探活 + InsForge 宕机兜底）和 `token_expire`（JWT exp 临过期预警）。

**Architecture:** 复用 `web/lib/scheduler.ts` 的 node-cron 注册「监控扫描」桶；evaluator 是 `(rule, deps) => Promise<EvalResult>` 纯函数（依赖注入便于单测）；告警生命周期（active/resolved/suppress/recovery）走 `monitor_alerts` 表 upsert；主通道复用 `functions/wecom-notify`，InsForge-down 时 web 直连企微 `message/send` 兜底。

**Tech Stack:** Next.js 16 (web)、`@insforge/sdk`、node-cron、PostgreSQL（PostgREST）、vitest（新增，纯逻辑单测）、Tailwind。

**部署：** 全是 web+db 改动 → 走 GHA（`git push origin main`）。**前置 ops**：确认 web 容器有 `WECOM_OPS_SECRET`/`WECOM_OPS_AGENT_ID`/`WECOM_CORP_ID`（兜底通道用；通讯录回调已用前两者，确认第三个）。

**Phase B（后续计划，不在本计划内）：** `collect_fail`/`request_fail`(+埋点)/`data_freshness`/`contact_sync`/`data_integrity` 五个 evaluator + `/admin/monitor` 只读大盘 + 对应种子规则。复用本计划建立的 evaluator 注册表与 store 抽象。

**文件结构：**
- 新建 DB：`database/migrations/018_collect_logs_fix.sql`、`019_monitor_tables.sql`、`020_monitor_seed_rules.sql`
- 新建 web 核心：`web/lib/monitor/{types,jwt,lifecycle,store,notify,notify-direct,probe,engine}.ts`、`web/lib/monitor/evaluators/{service-down,token-expire,index}.ts`
- 新建 web 路由：`web/app/api/health/route.ts`
- 新建测试：`web/lib/monitor/__tests__/*.test.ts`、`web/lib/monitor/evaluators/__tests__/*.test.ts`
- 改：`web/package.json`、`web/lib/scheduler.ts`
- 配置：`web/vitest.config.ts`

---

## Task 1: 引入 vitest 单测框架

**Files:**
- Modify: `web/package.json`
- Create: `web/vitest.config.ts`
- Create: `web/lib/monitor/__tests__/sanity.test.ts`

- [ ] **Step 1: 安装 vitest**

Run:
```bash
cd web && npm install -D vitest --registry=https://registry.npmmirror.com
```
Expected: `added N packages`，`web/package.json` 的 `devDependencies` 出现 `vitest`。

- [ ] **Step 2: 加 test 脚本**

Modify `web/package.json`，在 `scripts` 里加两行（紧跟 `"lint": "eslint"` 之后）：
```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: 写 vitest 配置（node 环境，排除 playwright 的 tests/ 目录）**

Create `web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    exclude: ['tests/**', 'node_modules/**'],
  },
});
```

- [ ] **Step 4: 写一个 sanity 测试确认能跑**

Create `web/lib/monitor/__tests__/sanity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('sanity', () => {
  it('vitest runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: 跑测试**

Run: `cd web && npx vitest run`
Expected: `1 passed`，退出码 0。

- [ ] **Step 6: 类型检查不回归**

Run: `cd web && npx tsc --noEmit`
Expected: 无新增报错（vitest 自带类型，应通过）。

- [ ] **Step 7: 提交**

```bash
git add web/package.json web/package-lock.json web/vitest.config.ts web/lib/monitor/__tests__/sanity.test.ts
git commit -m "test(web): 引入 vitest 单测框架"
```

---

## Task 2: 修复 collect_logs 写读不匹配（前置 bug）

**Files:**
- Create: `database/migrations/018_collect_logs_fix.sql`

> 背景：`scheduler.ts:339/342`、`collect-lemeng/route.ts:195/198` 向 `collect_logs` 写 `duration_ms`/`response_summary`，但实际表无此二列 → PostgREST 静默拒绝，监控页耗时列恒空。

- [ ] **Step 1: 写迁移（幂等，事务包裹）**

Create `database/migrations/018_collect_logs_fix.sql`:
```sql
-- 修复 collect_logs 写读不匹配：代码已写 duration_ms / response_summary，但表无此二列
BEGIN;
ALTER TABLE collect_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE collect_logs ADD COLUMN IF NOT EXISTS response_summary JSONB;
COMMENT ON COLUMN collect_logs.duration_ms IS '单次采集耗时(毫秒)';
COMMENT ON COLUMN collect_logs.response_summary IS '采集结果结构化摘要(jsonb)';
COMMIT;
```

- [ ] **Step 2: 本地校验语法（若有本地 postgres 容器；否则跳过，GHA 会跑）**

Run（可选，需本地 dev 栈）:
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 -f /path/to/018_collect_logs_fix.sql
```
Expected（若跑）: `ALTER TABLE` ×2，无报错。

- [ ] **Step 3: 提交**

```bash
git add database/migrations/018_collect_logs_fix.sql
git commit -m "fix(db): collect_logs 补 duration_ms/response_summary 列"
```

---

## Task 3: 建监控表（monitor_rules / monitor_alerts / external_request_logs / monitor_state）

**Files:**
- Create: `database/migrations/019_monitor_tables.sql`

- [ ] **Step 1: 写建表迁移（幂等 + COMMENT + GRANT + DISABLE RLS，遵循 MIGRATION_TEMPLATE）**

Create `database/migrations/019_monitor_tables.sql`:
```sql
-- 监控告警体系 v1 表（架构文档 §8.1，spec docs/superpowers/specs/2026-07-08-monitoring-system-design.md）

-- 规则定义
CREATE TABLE IF NOT EXISTS monitor_rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  check_type VARCHAR(50) NOT NULL,
  target TEXT,
  threshold JSONB NOT NULL DEFAULT '{}'::jsonb,
  severity VARCHAR(20) NOT NULL DEFAULT 'high',
  touser TEXT,
  template TEXT,
  suppress_window_seconds INTEGER NOT NULL DEFAULT 1800,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_monitor_rules_check_type ON monitor_rules(check_type) WHERE enabled = TRUE;

-- 告警状态/事件（alert_key 唯一 → 同问题一行）
CREATE TABLE IF NOT EXISTS monitor_alerts (
  id SERIAL PRIMARY KEY,
  alert_key TEXT NOT NULL UNIQUE,
  rule_id INTEGER NOT NULL REFERENCES monitor_rules(id) ON DELETE CASCADE,
  check_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_notify_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  context JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_monitor_alerts_status ON monitor_alerts(status);

-- 请求级埋点（request_fail 数据源，Phase B 用；先建好供 callLemengApi 写）
CREATE TABLE IF NOT EXISTS external_request_logs (
  id BIGSERIAL PRIMARY KEY,
  source_id INTEGER,
  endpoint TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  http_status INTEGER,
  ok BOOLEAN NOT NULL,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ext_req_ts ON external_request_logs(ts);

-- evaluator 跨轮运行态
CREATE TABLE IF NOT EXISTS monitor_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE monitor_rules IS '监控告警规则定义';
COMMENT ON TABLE monitor_alerts IS '告警状态/事件（alert_key 唯一，active/resolved）';
COMMENT ON TABLE external_request_logs IS '外部 API 请求级埋点（request_fail 数据源）';
COMMENT ON TABLE monitor_state IS 'evaluator 跨轮运行态键值';
COMMENT ON COLUMN monitor_alerts.alert_key IS '问题唯一标识，如 token:src_3120 / svc:duckdb';

ALTER TABLE monitor_rules DISABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_alerts DISABLE ROW LEVEL SECURITY;
ALTER TABLE external_request_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_state DISABLE ROW LEVEL SECURITY;

GRANT SELECT ON monitor_rules, monitor_alerts TO anon, authenticated;
GRANT SELECT ON external_request_logs TO authenticated;
-- 写仅给服务端 service-role（INSFORGE_API_KEY），不对 anon 开
```

- [ ] **Step 2: 提交**

```bash
git add database/migrations/019_monitor_tables.sql
git commit -m "feat(db): 监控告警体系 v1 表（rules/alerts/request_logs/state）"
```

---

## Task 4: 共享类型 `monitor/types.ts`

**Files:**
- Create: `web/lib/monitor/types.ts`

- [ ] **Step 1: 写类型定义**

Create `web/lib/monitor/types.ts`:
```ts
// 监控告警体系共享类型（架构 §8.1）

// v1 支持的检查类型；Phase B 会扩展后三类
export type CheckType =
  | 'service_down'
  | 'token_expire'
  | 'collect_fail'
  | 'request_fail'
  | 'data_freshness'
  | 'data_integrity'
  | 'contact_sync';

export type Severity = 'critical' | 'high' | 'medium';

// monitor_rules 行
export interface MonitorRule {
  id: number;
  name: string;
  check_type: CheckType;
  target: string | null;
  threshold: Record<string, any>;
  severity: Severity;
  touser: string | null;
  template: string | null;
  suppress_window_seconds: number;
  enabled: boolean;
}

// evaluator 产出
export interface EvalResult {
  firing: boolean;
  alert_key: string;
  context: Record<string, any>; // 供模板渲染
}

// evaluator 依赖注入（engine 提供真实实现，测试提供 fake）
export interface EvalDeps {
  now: Date;
  probe: (url: string, opts?: { timeoutMs?: number; method?: string }) => Promise<ProbeOutcome>;
  getCredentialToken: (sourceId: number) => Promise<string | null>;
}

export interface ProbeOutcome {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

// evaluator 签名
export type Evaluator = (rule: MonitorRule, deps: EvalDeps) => Promise<EvalResult>;
```

- [ ] **Step 2: 类型检查**

Run: `cd web && npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add web/lib/monitor/types.ts
git commit -m "feat(monitor): 共享类型定义"
```

---

## Task 5: JWT 解码工具 `monitor/jwt.ts`（token_expire 用）

**Files:**
- Create: `web/lib/monitor/jwt.ts`
- Create: `web/lib/monitor/__tests__/jwt.test.ts`

- [ ] **Step 1: 写失败测试**

Create `web/lib/monitor/__tests__/jwt.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { decodeJwtPayload } from '../jwt';

describe('decodeJwtPayload', () => {
  it('解出 payload 各字段', () => {
    // payload {"company_id":3120,"exp":1800000000} → base64url
    const payload = Buffer.from(JSON.stringify({ company_id: 3120, exp: 1800000000 })).toString('base64url');
    const token = `header.${payload}.sig`;
    expect(decodeJwtPayload(token)).toEqual({ company_id: 3120, exp: 1800000000 });
  });

  it('带 Bearer 前缀也能解', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 123 })).toString('base64url');
    expect(decodeJwtPayload(`Bearer a.${payload}.b`)?.exp).toBe(123);
  });

  it('非法 token 返回 null', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/monitor/__tests__/jwt.test.ts`
Expected: FAIL（`decodeJwtPayload is not a function` / 模块不存在）。

- [ ] **Step 3: 实现**

Create `web/lib/monitor/jwt.ts`:
```ts
// JWT payload 解码（不验签，仅读 claim；复用 collect.ts:16 的 base64url 解码模式）
export function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const raw = token.startsWith('Bearer ') ? token.slice(7) : token;
    const parts = raw.split('.');
    if (parts.length < 2) return null;
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/'); // base64url → base64
    while (p.length % 4) p += '=';                          // 补 padding
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/monitor/__tests__/jwt.test.ts`
Expected: `3 passed`。

- [ ] **Step 5: 提交**

```bash
git add web/lib/monitor/jwt.ts web/lib/monitor/__tests__/jwt.test.ts
git commit -m "feat(monitor): JWT payload 解码工具"
```

---

## Task 6: 告警生命周期纯函数 `monitor/lifecycle.ts`

**Files:**
- Create: `web/lib/monitor/lifecycle.ts`
- Create: `web/lib/monitor/__tests__/lifecycle.test.ts`

> 三个纯决策函数：`shouldNotify`（suppress 窗口）、`isRecovery`、`renderTemplate`。DB 写入由 store/engine 负责。

- [ ] **Step 1: 写失败测试**

Create `web/lib/monitor/__tests__/lifecycle.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { shouldNotify, isRecovery, renderTemplate } from '../lifecycle';

describe('shouldNotify', () => {
  const now = new Date('2026-07-08T10:00:00Z');
  it('从未通知过 → true', () => {
    expect(shouldNotify({ last_notify_at: null } as any, { suppress_window_seconds: 1800 } as any, now)).toBe(true);
  });
  it('窗口内已通知 → false', () => {
    expect(shouldNotify({ last_notify_at: '2026-07-08T09:50:00Z' } as any, { suppress_window_seconds: 1800 } as any, now)).toBe(false);
  });
  it('超过窗口 → true', () => {
    expect(shouldNotify({ last_notify_at: '2026-07-08T09:00:00Z' } as any, { suppress_window_seconds: 1800 } as any, now)).toBe(true);
  });
});

describe('isRecovery', () => {
  it('曾 active 且本次不 firing → 恢复', () => {
    expect(isRecovery({ status: 'active' } as any, { firing: false } as any)).toBe(true);
  });
  it('曾 active 且仍 firing → 非恢复', () => {
    expect(isRecovery({ status: 'active' } as any, { firing: true } as any)).toBe(false);
  });
  it('无 active 行 → 非恢复', () => {
    expect(isRecovery(null, { firing: false } as any)).toBe(false);
  });
});

describe('renderTemplate', () => {
  it('占位符替换', () => {
    expect(renderTemplate('乐檬-{brand} 剩 {remain_hours}h', { brand: '3120', remain_hours: 24 })).toBe('乐檬-3120 剩 24h');
  });
  it('无模板时给默认', () => {
    expect(renderTemplate(null, { x: 1 }, '默认')).toBe('默认');
  });
  it('缺失字段保留原占位符不崩', () => {
    expect(renderTemplate('{a}/{b}', { a: '1' })).toBe('1/{b}');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/monitor/__tests__/lifecycle.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `web/lib/monitor/lifecycle.ts`:
```ts
import type { MonitorRule } from './types';

export interface ActiveAlert {
  status: string;
  last_notify_at: string | null;
}

// 是否到该发通知（suppress 窗口外，或从未发过）
export function shouldNotify(alert: ActiveAlert | null, rule: Pick<MonitorRule, 'suppress_window_seconds'>, now: Date): boolean {
  if (!alert || !alert.last_notify_at) return true;
  const last = new Date(alert.last_notify_at).getTime();
  return now.getTime() - last >= rule.suppress_window_seconds * 1000;
}

// active → 恢复判定
export function isRecovery(active: ActiveAlert | null, result: { firing: boolean }): boolean {
  return !!active && active.status === 'active' && !result.firing;
}

// 模板渲染：{key} → context[key]；缺失字段保留 {key}
export function renderTemplate(
  template: string | null | undefined,
  context: Record<string, any>,
  fallback = ''
): string {
  if (!template) return fallback;
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in context ? String(context[key]) : m));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/monitor/__tests__/lifecycle.test.ts`
Expected: `9 passed`。

- [ ] **Step 5: 提交**

```bash
git add web/lib/monitor/lifecycle.ts web/lib/monitor/__tests__/lifecycle.test.ts
git commit -m "feat(monitor): 告警生命周期纯函数(shouldNotify/isRecovery/renderTemplate)"
```

---

## Task 7: Store 抽象 `monitor/store.ts`（DB 读写，依赖注入）

**Files:**
- Create: `web/lib/monitor/store.ts`
- Create: `web/lib/monitor/__tests__/store.test.ts`

> `MonitorStore` 接口 + `SdkStore`（真实，用 @insforge/sdk）。测试用内存实现验证契约。

- [ ] **Step 1: 写失败测试（用 MemoryStore 验证接口契约）**

Create `web/lib/monitor/__tests__/store.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../store';

describe('MonitorStore 契约 (MemoryStore)', () => {
  it('upsert 新增 alert', async () => {
    const s = new MemoryStore();
    await s.upsertAlert({ alert_key: 'svc:duckdb', rule_id: 1, check_type: 'service_down', severity: 'critical', context: { a: 1 } });
    const a = await s.getActiveAlert('svc:duckdb');
    expect(a?.status).toBe('active');
    expect(a?.occurrence_count).toBe(1);
  });

  it('upsert 已存在 alert：occurrence_count++ 且更新 context', async () => {
    const s = new MemoryStore();
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: { n: 1 } });
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: { n: 2 } });
    const a = await s.getActiveAlert('k');
    expect(a?.occurrence_count).toBe(2);
    expect(a?.context.n).toBe(2);
  });

  it('markNotified 更新 last_notify_at', async () => {
    const s = new MemoryStore();
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: {} });
    await s.markNotified('k', new Date('2026-07-08T10:00:00Z'));
    const a = await s.getActiveAlert('k');
    expect(a?.last_notify_at).toBe('2026-07-08T10:00:00Z');
  });

  it('resolve 置 resolved + resolved_at', async () => {
    const s = new MemoryStore();
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: {} });
    await s.resolveAlert('k', new Date('2026-07-08T11:00:00Z'));
    const a = await s.getActiveAlert('k');
    expect(a).toBeNull(); // active 查不到了
  });

  it('loadRules 按 check_type 过滤 enabled', async () => {
    const s = new MemoryStore();
    s._seedRules([
      { id: 1, name: 'r1', check_type: 'service_down', target: 'duckdb', threshold: {}, severity: 'high', touser: null, template: null, suppress_window_seconds: 1800, enabled: true },
      { id: 2, name: 'r2', check_type: 'service_down', target: 'web', threshold: {}, severity: 'high', touser: null, template: null, suppress_window_seconds: 1800, enabled: false },
    ]);
    const rules = await s.loadRules(['service_down']);
    expect(rules).toHaveLength(1);
    expect(rules[0].target).toBe('duckdb');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/monitor/__tests__/store.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现（接口 + MemoryStore + SdkStore）**

Create `web/lib/monitor/store.ts`:
```ts
import type { CheckType, MonitorRule, Severity } from './types';

export interface AlertRow {
  alert_key: string;
  rule_id: number;
  check_type: CheckType;
  severity: Severity;
  context?: Record<string, any>;
}

export interface ActiveAlertRow {
  id: number;
  alert_key: string;
  rule_id: number;
  check_type: CheckType;
  severity: Severity;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  last_notify_at: string | null;
  resolved_at: string | null;
  context: Record<string, any>;
}

// 读写抽象（engine 依赖它；测试用 MemoryStore，生产用 SdkStore）
export interface MonitorStore {
  loadRules(checkTypes: CheckType[]): Promise<MonitorRule[]>;
  getActiveAlert(alertKey: string): Promise<ActiveAlertRow | null>;
  upsertAlert(row: AlertRow): Promise<void>;
  markNotified(alertKey: string, at: Date): Promise<void>;
  resolveAlert(alertKey: string, at: Date): Promise<void>;
}

// ===== 内存实现（测试用）=====
export class MemoryStore implements MonitorStore {
  private alerts = new Map<string, ActiveAlertRow & { seq: number }>();
  private rules: MonitorRule[] = [];
  private seq = 0;

  _seedRules(rules: MonitorRule[]) { this.rules = rules; }
  async loadRules(checkTypes: CheckType[]) {
    return this.rules.filter(r => r.enabled && checkTypes.includes(r.check_type));
  }
  async getActiveAlert(alertKey: string) {
    const a = this.alerts.get(alertKey);
    return a && a.status === 'active' ? a : null;
  }
  async upsertAlert(row: AlertRow) {
    const existing = this.alerts.get(row.alert_key);
    if (existing && existing.status === 'active') {
      existing.occurrence_count++;
      existing.last_seen_at = new Date().toISOString();
      existing.context = row.context ?? existing.context;
    } else {
      this.alerts.set(row.alert_key, {
        id: ++this.seq, alert_key: row.alert_key, rule_id: row.rule_id, check_type: row.check_type,
        severity: row.severity, status: 'active', first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(), occurrence_count: 1, last_notify_at: null,
        resolved_at: null, context: row.context ?? {}, seq: this.seq,
      });
    }
  }
  async markNotified(alertKey: string, at: Date) {
    const a = this.alerts.get(alertKey);
    if (a) a.last_notify_at = at.toISOString();
  }
  async resolveAlert(alertKey: string, at: Date) {
    const a = this.alerts.get(alertKey);
    if (a) { a.status = 'resolved'; a.resolved_at = at.toISOString(); }
  }
}

// ===== 生产实现（@insforge/sdk → PostgREST）=====
export class SdkStore implements MonitorStore {
  constructor(private client: any) {}

  async loadRules(checkTypes: CheckType[]): Promise<MonitorRule[]> {
    const { data, error } = await this.client.database
      .from('monitor_rules')
      .select('id, name, check_type, target, threshold, severity, touser, template, suppress_window_seconds, enabled')
      .eq('enabled', true)
      .in('check_type', checkTypes);
    if (error) throw new Error(`loadRules: ${error.message}`);
    return (data ?? []) as MonitorRule[];
  }

  async getActiveAlert(alertKey: string): Promise<ActiveAlertRow | null> {
    const { data, error } = await this.client.database
      .from('monitor_alerts')
      .select('*')
      .eq('alert_key', alertKey)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw new Error(`getActiveAlert: ${error.message}`);
    return (data as ActiveAlertRow) ?? null;
  }

  async upsertAlert(row: AlertRow): Promise<void> {
    // select-then-update/insert：保证 occurrence_count 自增（与 MemoryStore 行为一致）
    const existing = await this.getActiveAlert(row.alert_key);
    if (existing) {
      const { error } = await this.client.database
        .from('monitor_alerts')
        .update({
          occurrence_count: existing.occurrence_count + 1,
          last_seen_at: new Date().toISOString(),
          context: row.context ?? existing.context,
        })
        .eq('alert_key', row.alert_key)
        .eq('status', 'active');
      if (error) throw new Error(`upsertAlert update: ${error.message}`);
    } else {
      const { error } = await this.client.database
        .from('monitor_alerts')
        .insert([{
          alert_key: row.alert_key,
          rule_id: row.rule_id,
          check_type: row.check_type,
          severity: row.severity,
          context: row.context ?? {},
        }]);
      if (error) throw new Error(`upsertAlert insert: ${error.message}`);
    }
  }

  async markNotified(alertKey: string, at: Date): Promise<void> {
    const { error } = await this.client.database
      .from('monitor_alerts')
      .update({ last_notify_at: at.toISOString() })
      .eq('alert_key', alertKey)
      .eq('status', 'active');
    if (error) throw new Error(`markNotified: ${error.message}`);
  }

  async resolveAlert(alertKey: string, at: Date): Promise<void> {
    const { error } = await this.client.database
      .from('monitor_alerts')
      .update({ status: 'resolved', resolved_at: at.toISOString() })
      .eq('alert_key', alertKey)
      .eq('status', 'active');
    if (error) throw new Error(`resolveAlert: ${error.message}`);
  }
}
```

> 注：MemoryStore 与 SdkStore 都用「已有 active → count++ + 覆盖 context，否则 insert」语义，store.test 用 MemoryStore 验证该契约；两种实现行为一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/monitor/__tests__/store.test.ts`
Expected: `5 passed`。

- [ ] **Step 5: 类型检查**

Run: `cd web && npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add web/lib/monitor/store.ts web/lib/monitor/__tests__/store.test.ts
git commit -m "feat(monitor): MonitorStore 抽象 + 内存/SDK 双实现"
```

---

## Task 8: 通知分发 `monitor/notify.ts`（主通道 + 模板渲染）

**Files:**
- Create: `web/lib/monitor/notify.ts`
- Create: `web/lib/monitor/__tests__/notify.test.ts`

> 组装标题/正文（用 lifecycle.renderTemplate），解析收件人（`@default` → env），调 `notifyWecom`。InsForge-down 兜底放 Task 9，本任务只做主通道 + 收件人解析 + 一个注入点让 engine 决定是否走兜底。

- [ ] **Step 1: 写失败测试（mock notifyWecom）**

Create `web/lib/monitor/__tests__/notify.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock notify 模块的主通道
vi.mock('../../notify', () => ({
  notifyWecom: vi.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

import { notifyWecom } from '../../notify';
import { dispatchAlert } from '../notify';
import type { MonitorRule, EvalResult } from '../types';

beforeEach(() => vi.clearAllMocks());

const rule = (over: Partial<MonitorRule> = {}): MonitorRule => ({
  id: 1, name: 'r', check_type: 'service_down', target: 'duckdb', threshold: {},
  severity: 'high', touser: '@default', template: '{svc} 不可达', suppress_window_seconds: 1800, enabled: true,
  ...over,
});

describe('dispatchAlert', () => {
  it('用模板渲染并通过主通道发送', async () => {
    const res: EvalResult = { firing: true, alert_key: 'svc:duckdb', context: { svc: 'duckdb' } };
    await dispatchAlert(rule(), res, { recovered: false });
    expect(notifyWecom).toHaveBeenCalledTimes(1);
    const [title, content] = (notifyWecom as any).mock.calls[0];
    expect(title).toContain('🔴');       // 默认严重度图标
    expect(content).toContain('duckdb 不可达');
  });

  it('recovered 时标题用 ✅', async () => {
    await dispatchAlert(rule(), { firing: false, alert_key: 'svc:duckdb', context: { svc: 'duckdb' } }, { recovered: true });
    const [title] = (notifyWecom as any).mock.calls[0];
    expect(title).toContain('✅');
  });

  it('touser=@default 展开为 env', async () => {
    process.env.NOTIFY_DEFAULT_TUSERS = 'ZhangDuo';
    await dispatchAlert(rule({ touser: '@default' }), { firing: true, alert_key: 'k', context: {} }, { recovered: false });
    // 收件人解析不阻塞发送（notifyWecom 不收 touser，仅标题/正文）；这里只断言不抛错
    expect(notifyWecom).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/monitor/__tests__/notify.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `web/lib/monitor/notify.ts`:
```ts
import { notifyWecom } from '../notify';
import { renderTemplate } from './lifecycle';
import type { MonitorRule, EvalResult, Severity } from './types';

const SEVERITY_ICON: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡' };

// 解析收件人（@default → env NOTIFY_DEFAULT_TUSERS）；当前 wecom-notify 用默认收件人，
// 此函数暂作记录/日志，留待 Phase B 按 touser 分发
export function resolveTouser(touser: string | null | undefined): string {
  if (!touser || touser === '@default') return process.env.NOTIFY_DEFAULT_TUSERS || '';
  return touser;
}

export interface DispatchOpts {
  recovered?: boolean;
}

// 组装标题/正文，走主通道 notifyWecom
export async function dispatchAlert(rule: MonitorRule, result: EvalResult, opts: DispatchOpts = {}): Promise<void> {
  const icon = opts.recovered ? '✅' : SEVERITY_ICON[rule.severity] ?? '🔴';
  const verb = opts.recovered ? '已恢复' : '告警';
  const title = `${icon} [${rule.severity}] ${rule.name} ${verb}`;
  const content = renderTemplate(rule.template, result.context, `${rule.check_type}: ${result.alert_key}`);
  const touser = resolveTouser(rule.touser);
  console.log(`[monitor] dispatch → ${touser || '(default)'}: ${title}`);
  await notifyWecom(title, content);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/monitor/__tests__/notify.test.ts`
Expected: `3 passed`。

- [ ] **Step 5: 提交**

```bash
git add web/lib/monitor/notify.ts web/lib/monitor/__tests__/notify.test.ts
git commit -m "feat(monitor): 主通道通知分发(模板渲染+收件人解析)"
```

---

## Task 9: InsForge-down 兜底通道 `monitor/notify-direct.ts`

**Files:**
- Create: `web/lib/monitor/notify-direct.ts`
- Create: `web/lib/monitor/__tests__/notify-direct.test.ts`

> web 用 `WECOM_OPS_SECRET`/`WECOM_OPS_AGENT_ID`/`WECOM_CORP_ID` 直连企微 `message/send`，绕开 InsForge。仅 `service_down` 探到 insforge 不可达时用。

- [ ] **Step 1: 写失败测试（mock fetch）**

Create `web/lib/monitor/__tests__/notify-direct.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { notifyWecomDirect } from '../notify-direct';

beforeEach(() => {
  fetchMock.mockReset();
  process.env.WECOM_CORP_ID = 'corp1';
  process.env.WECOM_OPS_SECRET = 'sec1';
  process.env.WECOM_OPS_AGENT_ID = '1000009';
  process.env.NOTIFY_DEFAULT_TUSERS = 'ZhangDuo';
});
afterEach(() => { delete process.env.WECOM_CORP_ID; delete process.env.WECOM_OPS_SECRET; delete process.env.WECOM_OPS_AGENT_ID; });

describe('notifyWecomDirect', () => {
  it('先取 token 再发 message/send', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'TOK', errcode: 0 }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ errcode: 0, errmsg: 'ok' }) } as any);

    await notifyWecomDirect('标题', '正文');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenUrl = fetchMock.mock.calls[0][0];
    expect(tokenUrl).toContain('gettoken');
    expect(tokenUrl).toContain('corpid=corp1');
    expect(tokenUrl).toContain('corpsecret=sec1');
    const sendOpts = fetchMock.mock.calls[1][1];
    const body = JSON.parse(sendOpts.body);
    expect(body.agentid).toBe('1000009');
    expect(body.touser).toBe('ZhangDuo');
    expect(body.text.content).toBe('标题\n正文');
  });

  it('gettoken 失败时抛错且不发 send', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: '', errcode: 40013, errmsg: 'invalid' }) } as any);
    await expect(notifyWecomDirect('t', 'c')).rejects.toThrow(/access_token/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/monitor/__tests__/notify-direct.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `web/lib/monitor/notify-direct.ts`:
```ts
// InsForge-down 兜底：web 直连企微 message/send，绕开 functions/wecom-notify（架构 §8.1 / spec §6.2）
// 仅当 service_down 探到 insforge 不可达时由 engine 调用。
const QYAPI = 'https://qyapi.weixin.qq.com/cgi-bin';

async function getAccessToken(): Promise<string> {
  const corpid = process.env.WECOM_CORP_ID;
  const corpsecret = process.env.WECOM_OPS_SECRET;
  if (!corpid || !corpsecret) throw new Error('notifyWecomDirect: missing WECOM_CORP_ID/WECOM_OPS_SECRET');
  const url = `${QYAPI}/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(corpsecret)}`;
  const resp = await fetch(url);
  const data = await resp.json() as any;
  if (!data.access_token) throw new Error(`notifyWecomDirect: gettoken failed ${data.errcode} ${data.errmsg}`);
  return data.access_token as string;
}

export async function notifyWecomDirect(title: string, content: string): Promise<void> {
  const agentid = process.env.WECOM_OPS_AGENT_ID;
  const touser = process.env.NOTIFY_DEFAULT_TUSERS || '';
  if (!agentid) throw new Error('notifyWecomDirect: missing WECOM_OPS_AGENT_ID');
  const token = await getAccessToken();
  const url = `${QYAPI}/message/send?access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser,
      msgtype: 'text',
      agentid,
      text: { content: `${title}\n${content}` },
    }),
  });
  const data = await resp.json() as any;
  if (data.errcode !== 0) throw new Error(`notifyWecomDirect: send failed ${data.errcode} ${data.errmsg}`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/monitor/__tests__/notify-direct.test.ts`
Expected: `2 passed`。

- [ ] **Step 5: 提交**

```bash
git add web/lib/monitor/notify-direct.ts web/lib/monitor/__tests__/notify-direct.test.ts
git commit -m "feat(monitor): InsForge-down 兜底通道(web 直连企微)"
```

---

## Task 10: 探活工具 `monitor/probe.ts`

**Files:**
- Create: `web/lib/monitor/probe.ts`
- Create: `web/lib/monitor/__tests__/probe.test.ts`

- [ ] **Step 1: 写失败测试（mock fetch + AbortController 超时）**

Create `web/lib/monitor/__tests__/probe.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probe } from '../probe';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
beforeEach(() => fetchMock.mockReset());

describe('probe', () => {
  it('200 → ok', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as any);
    const r = await probe('http://x/health');
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('非 200 → not ok 带 status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as any);
    const r = await probe('http://x/health');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });

  it('抛错 → not ok 带 error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await probe('http://x/health');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/monitor/__tests__/probe.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `web/lib/monitor/probe.ts`:
```ts
import type { ProbeOutcome } from './types';

// 应用级探活：fetch + 超时（AbortController），永不抛——失败返回 { ok:false, error }
export async function probe(url: string, opts: { timeoutMs?: number; method?: string } = {}): Promise<ProbeOutcome> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: opts.method ?? 'GET', signal: controller.signal });
    return { ok: resp.ok, status: resp.status, latencyMs: Date.now() - start };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - start, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/monitor/__tests__/probe.test.ts`
Expected: `3 passed`。

- [ ] **Step 5: 提交**

```bash
git add web/lib/monitor/probe.ts web/lib/monitor/__tests__/probe.test.ts
git commit -m "feat(monitor): 应用级探活工具(超时+不抛)"
```

---

## Task 11: `service_down` evaluator

**Files:**
- Create: `web/lib/monitor/evaluators/service-down.ts`
- Create: `web/lib/monitor/evaluators/__tests__/service-down.test.ts`

- [ ] **Step 1: 写失败测试**

Create `web/lib/monitor/evaluators/__tests__/service-down.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { evalServiceDown } from '../service-down';
import type { MonitorRule, EvalDeps, ProbeOutcome } from '../../types';

const rule = (target: string): MonitorRule => ({
  id: 1, name: `svc-${target}`, check_type: 'service_down', target, threshold: {},
  severity: 'critical', touser: '@default', template: '{svc} 不可达({detail})',
  suppress_window_seconds: 1800, enabled: true,
});

const deps = (ok: boolean, extra: Partial<ProbeOutcome> = {}): EvalDeps => ({
  now: new Date('2026-07-08T10:00:00Z'),
  probe: async () => ({ ok, latencyMs: 5, status: ok ? 200 : undefined, ...extra } as ProbeOutcome),
  getCredentialToken: async () => null,
});

describe('evalServiceDown', () => {
  it('探活成功 → 不 firing', async () => {
    const r = await evalServiceDown(rule('duckdb'), deps(true));
    expect(r.firing).toBe(false);
    expect(r.alert_key).toBe('svc:duckdb');
  });

  it('探活失败 → firing + context', async () => {
    const r = await evalServiceDown(rule('duckdb'), deps(false, { error: 'ECONNREFUSED' }));
    expect(r.firing).toBe(true);
    expect(r.alert_key).toBe('svc:duckdb');
    expect(r.context).toMatchObject({ svc: 'duckdb', detail: 'ECONNREFUSED' });
  });

  it('未知服务名 → firing，context 标 unknown', async () => {
    const r = await evalServiceDown(rule('mars'), deps(false));
    expect(r.firing).toBe(true);
    expect(r.context.svc).toBe('mars');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/monitor/evaluators/__tests__/service-down.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `web/lib/monitor/evaluators/service-down.ts`:
```ts
import type { Evaluator, MonitorRule, EvalDeps, EvalResult } from '../types';

// 服务名 → 探活配置（URL 是基础设施，固化在代码；rule.target 选服务）
export const SERVICE_PROBES: Record<string, { url: string; method?: string }> = {
  web: { url: 'http://localhost:3000/api/health' },
  duckdb: { url: 'http://duckdb:9000/health' },
  insforge: { url: 'http://insforge:7130/api/health' },
  postgres: { url: 'pg:select1' }, // 特殊：engine/probe 层转 SELECT 1，见下方处理
  deno: { url: 'http://deno:7133/health' },
  openclaw: { url: 'http://openclaw:18789/healthz' },
};

export const evalServiceDown: Evaluator = async (rule: MonitorRule, deps: EvalDeps): Promise<EvalResult> => {
  const svc = rule.target ?? 'unknown';
  const cfg = SERVICE_PROBES[svc];

  // postgres 用 SELECT 1 经 SDK/store？此处简化：engine 注入的 probe 不适合 SQL；
  // 用 insforge 健康间接覆盖（postgres 挂 → insforge 也探不到）。
  if (!cfg || svc === 'postgres') {
    const probeCfg = SERVICE_PROBES['insforge'];
    const r = await deps.probe(probeCfg.url, { method: probeCfg.method });
    return { firing: !r.ok, alert_key: `svc:${svc}`, context: { svc, detail: r.error ?? `status ${r.status}`, latency_ms: r.latencyMs } };
  }

  const r = await deps.probe(cfg.url, { method: cfg.method });
  return {
    firing: !r.ok,
    alert_key: `svc:${svc}`,
    context: { svc, detail: r.error ?? (r.status ? `status ${r.status}` : 'unreachable'), latency_ms: r.latencyMs },
  };
};
```

> postgres 简化说明：直接探活 PG 需独立连接串。Phase A 以「postgres 挂 → insforge/duckdb 探活连带失败」间接覆盖；如需独立探活，Phase B 加 `pg-probe`（engine 注入 store.client 跑 `SELECT 1`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/monitor/evaluators/__tests__/service-down.test.ts`
Expected: `3 passed`。

- [ ] **Step 5: 提交**

```bash
git add web/lib/monitor/evaluators/service-down.ts web/lib/monitor/evaluators/__tests__/service-down.test.ts
git commit -m "feat(monitor): service_down evaluator"
```

---

## Task 12: `token_expire` evaluator

**Files:**
- Create: `web/lib/monitor/evaluators/token-expire.ts`
- Create: `web/lib/monitor/evaluators/__tests__/token-expire.test.ts`

- [ ] **Step 1: 写失败测试**

Create `web/lib/monitor/evaluators/__tests__/token-expire.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { evalTokenExpire } from '../token-expire';
import type { MonitorRule, EvalDeps } from '../../types';

const now = new Date('2026-07-08T10:00:00Z'); // epoch ms = 1751971200000

// 造一个 exp 在 now 之后 N 小时的 token
const tokenWithExp = (expSec: number) => {
  const payload = Buffer.from(JSON.stringify({ company_id: 3120, exp: expSec })).toString('base64url');
  return `h.${payload}.s`;
};

const rule = (beforeHours: number, sourceId: number): MonitorRule => ({
  id: 1, name: 'token', check_type: 'token_expire', target: String(sourceId), threshold: { before_hours: beforeHours },
  severity: 'critical', touser: '@default', template: '乐檬-{brand} token 剩 {remain_hours}h',
  suppress_window_seconds: 3600, enabled: true,
});

const deps = (token: string | null): EvalDeps => ({
  now,
  probe: async () => ({ ok: true, latencyMs: 1 }),
  getCredentialToken: async () => token,
});

describe('evalTokenExpire', () => {
  it('剩 2h，阈值 24h → firing', async () => {
    const exp = Math.floor(now.getTime() / 1000) + 2 * 3600;
    const r = await evalTokenExpire(rule(24, 3120), deps(tokenWithExp(exp)));
    expect(r.firing).toBe(true);
    expect(r.alert_key).toBe('token:3120');
    expect(r.context.remain_hours).toBeCloseTo(2, 0);
    expect(r.context.brand).toBe(3120);
  });

  it('剩 48h，阈值 24h → 不 firing', async () => {
    const exp = Math.floor(now.getTime() / 1000) + 48 * 3600;
    const r = await evalTokenExpire(rule(24, 3120), deps(tokenWithExp(exp)));
    expect(r.firing).toBe(false);
  });

  it('无凭证 → 不 firing（context 标 missing），不误报', async () => {
    const r = await evalTokenExpire(rule(24, 3120), deps(null));
    expect(r.firing).toBe(false);
    expect(r.context.missing).toBe(true);
  });

  it('token 无法解码 exp → 不 firing，context 标 undecodable', async () => {
    const r = await evalTokenExpire(rule(24, 3120), deps('not-a-jwt'));
    expect(r.firing).toBe(false);
    expect(r.context.undecodable).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/monitor/evaluators/__tests__/token-expire.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `web/lib/monitor/evaluators/token-expire.ts`:
```ts
import type { Evaluator, MonitorRule, EvalDeps, EvalResult } from '../types';
import { decodeJwtPayload } from '../jwt';

export const evalTokenExpire: Evaluator = async (rule: MonitorRule, deps: EvalDeps): Promise<EvalResult> => {
  const sourceId = Number(rule.target);
  const beforeHours = Number(rule.threshold?.before_hours ?? 24);
  const alertKey = `token:${sourceId}`;

  const token = await deps.getCredentialToken(sourceId);
  if (!token) return { firing: false, alert_key: alertKey, context: { missing: true, source_id: sourceId } };

  const payload = decodeJwtPayload(token);
  const exp = payload?.exp as number | undefined;
  if (!exp) return { firing: false, alert_key: alertKey, context: { undecodable: true, source_id: sourceId } };

  const remainHours = (exp - Math.floor(deps.now.getTime() / 1000)) / 3600;
  return {
    firing: remainHours < beforeHours,
    alert_key: alertKey,
    context: { source_id: sourceId, brand: payload.company_id ?? sourceId, remain_hours: Math.round(remainHours), exp_at: exp },
  };
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/monitor/evaluators/__tests__/token-expire.test.ts`
Expected: `4 passed`。

- [ ] **Step 5: 提交**

```bash
git add web/lib/monitor/evaluators/token-expire.ts web/lib/monitor/evaluators/__tests__/token-expire.test.ts
git commit -m "feat(monitor): token_expire evaluator(JWT exp 解码)"
```

---

## Task 13: evaluator 注册表 `evaluators/index.ts`

**Files:**
- Create: `web/lib/monitor/evaluators/index.ts`

- [ ] **Step 1: 实现（注册 Phase A 两个；Phase B 在此追加）**

Create `web/lib/monitor/evaluators/index.ts`:
```ts
import type { CheckType, Evaluator } from '../types';
import { evalServiceDown } from './service-down';
import { evalTokenExpire } from './token-expire';

// check_type → evaluator 注册表。Phase A 注册两个；Phase B 追加其余五种。
export const EVALUATORS: Partial<Record<CheckType, Evaluator>> = {
  service_down: evalServiceDown,
  token_expire: evalTokenExpire,
};
```

- [ ] **Step 2: 类型检查**

Run: `cd web && npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add web/lib/monitor/evaluators/index.ts
git commit -m "feat(monitor): evaluator 注册表"
```

---

## Task 14: 扫描引擎 `monitor/engine.ts`

**Files:**
- Create: `web/lib/monitor/engine.ts`
- Create: `web/lib/monitor/__tests__/engine.test.ts`

> `runScan(store, checkTypes, deps)`：load rules → 逐条 evaluator（per-rule try/catch）→ 读 active → 决策（shouldNotify / isRecovery）→ upsert/resolve + dispatch。InsForge-down 兜底：当某 firing 的 alert_key == `svc:insforge`，主通道 dispatch 之外额外走 `notifyWecomDirect`。

- [ ] **Step 1: 写失败测试（用 MemoryStore + fake evaluator + fake deps）**

Create `web/lib/monitor/__tests__/engine.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../notify', () => ({ notifyWecom: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../notify-direct', () => ({ notifyWecomDirect: vi.fn().mockResolvedValue(undefined) }));

import { runScan } from '../engine';
import { MemoryStore } from '../store';
import { EVALUATORS } from '../evaluators';
import type { MonitorRule, EvalDeps, Evaluator } from '../types';

const baseRule = (over: Partial<MonitorRule> = {}): MonitorRule => ({
  id: 1, name: 'r', check_type: 'service_down', target: 'duckdb', threshold: {},
  severity: 'high', touser: '@default', template: '{svc} down', suppress_window_seconds: 1800, enabled: true, ...over,
});

const fakeDeps = (): EvalDeps => ({ now: new Date('2026-07-08T10:00:00Z'), probe: async () => ({ ok: false, latencyMs: 1, error: 'x' }), getCredentialToken: async () => null });

describe('runScan', () => {
  it('firing → 写 active + 发通知', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule()]);
    const notify = (await import('../../notify')).notifyWecom as any;
    notify.mockClear();

    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS);

    const a = await store.getActiveAlert('svc:duckdb');
    expect(a?.status).toBe('active');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('suppress 窗口内不重复发（但 occurrence_count 仍 ++）', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule()]);
    const notify = (await import('../../notify')).notifyWecom as any;
    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS);
    notify.mockClear();
    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS); // 立刻第二轮

    const a = await store.getActiveAlert('svc:duckdb');
    expect(a?.occurrence_count).toBe(2);
    expect(notify).not.toHaveBeenCalled(); // 窗口内不发
  });

  it('firing 转 false → resolve + 发恢复通知', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule()]);
    const notify = (await import('../../notify')).notifyWecom as any;
    // 第一轮 firing
    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS);
    notify.mockClear();
    // 第二轮不 firing（probe ok）
    const okDeps = { ...fakeDeps(), probe: async () => ({ ok: true, latencyMs: 1 }) };
    await runScan(store, ['service_down'], okDeps, EVALUATORS);

    expect(await store.getActiveAlert('svc:duckdb')).toBeNull();
    const [title] = notify.mock.calls[0];
    expect(title).toContain('✅');
  });

  it('svc:insforge firing → 额外走兜底通道 notifyWecomDirect', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule({ id: 2, name: 'svc-insforge', target: 'insforge' })]);
    const direct = (await import('../notify-direct')).notifyWecomDirect as any;
    direct.mockClear();

    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS);

    expect(direct).toHaveBeenCalledTimes(1);
  });

  it('evaluator 抛错 → 不拖垮扫描，记 evaluator_error', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule()]);
    const throwingEval: Evaluator = async () => { throw new Error('boom'); };
    const throwingRegistry = { service_down: throwingEval } as any;

    await expect(runScan(store, ['service_down'], fakeDeps(), throwingRegistry)).resolves.not.toThrow();
    // console.error 记录即可；不写表（避免 evaluator 错误污染告警流）
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/monitor/__tests__/engine.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `web/lib/monitor/engine.ts`:
```ts
import type { CheckType, EvalDeps, EvalResult, Evaluator, MonitorRule } from './types';
import type { MonitorStore } from './store';
import { shouldNotify, isRecovery } from './lifecycle';
import { dispatchAlert } from './notify';
import { notifyWecomDirect } from './notify-direct';

const INSFORGE_ALERT_KEY = 'svc:insforge';

// 一轮扫描：load rules → 逐条 eval → 生命周期/降噪 → dispatch
// registry 注入（默认正式 EVALUATORS），便于测试
export async function runScan(
  store: MonitorStore,
  checkTypes: CheckType[],
  deps: EvalDeps,
  registry: Partial<Record<CheckType, Evaluator>>,
): Promise<void> {
  const rules = await store.loadRules(checkTypes);
  for (const rule of rules) {
    const evaluator = registry[rule.check_type];
    if (!evaluator) {
      console.warn(`[monitor] 无 ${rule.check_type} evaluator，跳过规则 ${rule.name}`);
      continue;
    }
    try {
      const result = await evaluator(rule, deps);
      await applyResult(store, rule, result, deps.now);
    } catch (e: any) {
      // per-rule 隔离：单条规则崩不拖垮整轮
      console.error(`[monitor] evaluator 异常 rule=${rule.name}(${rule.check_type}):`, e?.message ?? e);
    }
  }
}

async function applyResult(store: MonitorStore, rule: MonitorRule, result: EvalResult, now: Date): Promise<void> {
  const active = await store.getActiveAlert(result.alert_key);

  if (result.firing) {
    await store.upsertAlert({
      alert_key: result.alert_key,
      rule_id: rule.id,
      check_type: rule.check_type,
      severity: rule.severity,
      context: result.context,
    });
    const updated = await store.getActiveAlert(result.alert_key);
    if (shouldNotify(updated, rule, now)) {
      try {
        await dispatchAlert(rule, result, { recovered: false });
        // InsForge-down 兜底：额外直连
        if (result.alert_key === INSFORGE_ALERT_KEY) {
          await notifyWecomDirect(`🔴 [critical] ${rule.name} 告警`, `${result.alert_key} 不可达`);
        }
        await store.markNotified(result.alert_key, now);
      } catch (e: any) {
        console.error(`[monitor] dispatch 失败 ${result.alert_key}:`, e?.message ?? e);
      }
    }
  } else if (isRecovery(active, result)) {
    await store.resolveAlert(result.alert_key, now);
    try {
      await dispatchAlert(rule, result, { recovered: true });
    } catch (e: any) {
      console.error(`[monitor] recovery dispatch 失败 ${result.alert_key}:`, e?.message ?? e);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/monitor/__tests__/engine.test.ts`
Expected: `5 passed`。

> 说明：engine 这一层用 MemoryStore 测试，其 `upsertAlert` 已自增 occurrence_count（store.test 验证），故 suppress 用例期望 occurrence_count=2 成立。生产 SdkStore 用同一语义（Task 7 已实现 select-then-update/insert 自增），行为一致。

- [ ] **Step 5: 全量测试回归**

Run: `cd web && npx vitest run`
Expected: 全部 PASS（sanity + jwt + lifecycle + store + notify + notify-direct + probe + service-down + token-expire + engine）。

- [ ] **Step 6: 提交**

```bash
git add web/lib/monitor/engine.ts web/lib/monitor/__tests__/engine.test.ts
git commit -m "feat(monitor): 扫描引擎(生命周期/降噪/恢复/InsForge兜底)"
```

---

## Task 15: web `/api/health` 端点（service_down 探活 web 用）

**Files:**
- Create: `web/app/api/health/route.ts`

- [ ] **Step 1: 实现最小存活探针**

Create `web/app/api/health/route.ts`:
```ts
import { NextResponse } from 'next/server';

// web 应用存活探针（service_down 监控用）。仅 liveness；依赖深度检查归 service_down 各 evaluator。
export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'web' });
}
```

- [ ] **Step 2: 类型检查**

Run: `cd web && npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add web/app/api/health/route.ts
git commit -m "feat(web): /api/health 存活探针"
```

---

## Task 16: scheduler 注册监控扫描桶 + 生产 deps 组装

**Files:**
- Modify: `web/lib/scheduler.ts`
- Create: `web/lib/monitor/runtime.ts`

> 注册 4 个 cron 桶（Phase A 只前两个桶有 evaluator，后两个桶 loadRules 返回空→空跑无副作用，Phase B 填）。生产 deps：probe/getCredentialToken 用真实 fetch + SDK。

- [ ] **Step 1: 写 runtime（生产 deps + store + 启动各桶）**

Create `web/lib/monitor/runtime.ts`:
```ts
import { createClient } from '@insforge/sdk';
import type { CheckType, EvalDeps } from './types';
import { SdkStore } from './store';
import { runScan } from './engine';
import { EVALUATORS } from './evaluators';
import { probe as probeFn } from './probe';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

function newClient() {
  return createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
}

function buildDeps(): EvalDeps {
  const client = newClient();
  return {
    now: new Date(),
    probe: (url, opts) => probeFn(url, opts),
    getCredentialToken: async (sourceId) => {
      const { data, error } = await client.database
        .from('auth_credentials')
        .select('credential_data')
        .eq('source_id', sourceId)
        .maybeSingle();
      if (error || !data?.credential_data) return null;
      try {
        const cred = JSON.parse(data.credential_data);
        return cred.token ?? null;
      } catch {
        return null;
      }
    },
  };
}

// 各扫描桶（Phase A：service_down/token_expire 生效；后两桶 Phase B 填）
export async function runServiceDownBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['service_down'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] service_down bucket 异常:', e?.message ?? e);
  }
}

export async function runCollectTokenBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['collect_fail', 'request_fail', 'token_expire'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] collect/token bucket 异常:', e?.message ?? e);
  }
}

export async function runHourlyBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['data_freshness', 'contact_sync'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] hourly bucket 异常:', e?.message ?? e);
  }
}

export async function runDailyBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['data_integrity'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] daily bucket 异常:', e?.message ?? e);
  }
}
```

- [ ] **Step 2: scheduler 注册 4 个桶（仿 registerContactSyncJob）**

Modify `web/lib/scheduler.ts`：在文件顶部 import 区加：
```ts
import { runServiceDownBucket, runCollectTokenBucket, runHourlyBucket, runDailyBucket } from './monitor/runtime';
```

在 `ensureSchedulerInitialized()` 内、`registerContactSyncJob();`（第 47 行）之后加一行：
```ts
  registerMonitorJobs();
```

在 `registerContactSyncJob` 函数之后新增函数（紧贴其下）：
```ts
/**
 * 注册监控扫描桶（架构 §8.1）。4 个节奏：
 *   每分钟 service_down；每5分钟 collect_fail/request_fail/token_expire；
 *   每小时 data_freshness/contact_sync；每日 data_integrity。
 * Phase A 仅前两桶有 evaluator，后两桶空跑（loadRules 空），Phase B 填。
 */
function registerMonitorJobs() {
  const specs: Array<[string, string, () => Promise<void>]> = [
    ['__monitor_service', '* * * * *', runServiceDownBucket],
    ['__monitor_collect_token', '*/5 * * * *', runCollectTokenBucket],
    ['__monitor_hourly', '0 * * * *', runHourlyBucket],
    ['__monitor_daily', '0 3 * * *', runDailyBucket],
  ];
  for (const [key, expr, fn] of specs) {
    if (scheduledJobs.has(key)) continue;
    if (!cron.validate(expr)) continue;
    const job = cron.schedule(expr, async () => {
      if (runningTasks.has(key)) return;
      runningTasks.add(key);
      try { await fn(); } finally { runningTasks.delete(key); }
    }, { timezone: 'Asia/Shanghai' });
    scheduledJobs.set(key, job);
    console.log(`[scheduler] 注册监控桶 ${key} (${expr})`);
  }
}
```

- [ ] **Step 3: 类型检查 + build 冒烟**

Run: `cd web && npx tsc --noEmit`
Expected: 通过。

Run: `cd web && npx next build 2>&1 | tail -20`
Expected: 构建成功（或与基线一致的既有告警，无新增报错）。

- [ ] **Step 4: 全量单测回归（确认 scheduler 改动不破坏既有测试）**

Run: `cd web && npx vitest run`
Expected: 全部 PASS（store/engine 用 MemoryStore，不受 scheduler/runtime 影响）。

- [ ] **Step 5: 提交**

```bash
git add web/lib/monitor/runtime.ts web/lib/scheduler.ts
git commit -m "feat(monitor): scheduler 注册监控扫描桶 + 生产 deps/runtime"
```

---

## Task 17: 种子规则迁移（service_down ×6 + token_expire）

**Files:**
- Create: `database/migrations/020_monitor_seed_rules.sql`

- [ ] **Step 1: 写种子（幂等 INSERT ... ON CONFLICT）**

Create `database/migrations/020_monitor_seed_rules.sql`:
```sql
-- 监控告警体系 v1 种子规则（service_down ×6 + token_expire 占位；token_expire 按数据源补 target）
BEGIN;

-- service_down：6 个服务，每服务一条规则（target=服务名）
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, touser, template, suppress_window_seconds, enabled)
VALUES
  ('web 存活', 'service_down', 'web', '{}'::jsonb, 'critical', '@default', '🔴 [{severity}] web 不可达({detail})', 300, true),
  ('duckdb 存活', 'service_down', 'duckdb', '{}'::jsonb, 'critical', '@default', '🔴 [{severity}] DuckDB 不可达({detail})，影响采集/查询', 300, true),
  ('insforge 存活', 'service_down', 'insforge', '{}'::jsonb, 'critical', '@default', '🔴 [{severity}] InsForge 不可达({detail})，告警通道可能受影响', 300, true),
  ('postgres 存活', 'service_down', 'postgres', '{}'::jsonb, 'critical', '@default', '🔴 [{severity}] PostgreSQL 不可达({detail})', 300, true),
  ('deno 存活', 'service_down', 'deno', '{}'::jsonb, 'high', '@default', '🔴 [{severity}] Deno(edge function) 不可达({detail})', 300, true),
  ('openclaw 存活', 'service_down', 'openclaw', '{}'::jsonb, 'high', '@default', '🔴 [{severity}] OpenClaw 不可达({detail})，影响问数 bot', 300, true)
ON CONFLICT DO NOTHING;

-- token_expire：临过期前 24h 预警。target=数据源 id（部署后按实际乐檬数据源 id 补/改）。
-- 这里先插一条 target=NULL 的模板（disabled），运维确认数据源 id 后 enabled=true 并填 target。
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, touser, template, suppress_window_seconds, enabled)
VALUES
  ('乐檬 token 临过期', 'token_expire', NULL, '{"before_hours":24}'::jsonb, 'critical', '@default', '🔴 [{severity}] 乐檬-{brand} token 将在 {remain_hours}h 后过期，请尽快更新', 3600, false)
ON CONFLICT DO NOTHING;

COMMIT;
```

- [ ] **Step 2: 提交**

```bash
git add database/migrations/020_monitor_seed_rules.sql
git commit -m "feat(db): 监控种子规则(service_down×6 + token_expire 模板)"
```

---

## Task 18: 部署前置 env 核查

**Files:** （仅核查，不改代码；若缺则补 `deploy/.env` + compose env_file）

- [ ] **Step 1: 确认 web 容器有兜底通道所需 env**

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-web-1 printenv | grep -E 'WECOM_CORP_ID|WECOM_OPS_SECRET|WECOM_OPS_AGENT_ID|NOTIFY_DEFAULT_TUSERS|AGENT_API_KEY'"
```
Expected: 四个变量都有值。`WECOM_OPS_AGENT_ID` 若缺失 → 补进 `deploy/.env` 的 `WECOM_OPS_AGENT_ID=1000009`（App B agent id，从企微后台「同步/通知应用」取），并在 `deploy/docker-compose*.yml` 的 web 服务 `environment:` / `env_file` 注入。

- [ ] **Step 2: 缺则补 + 重启 web（若 Step 1 有缺）**

按 CLAUDE.md 流程：改 `deploy/.env` + compose 后重启 web。这是 deploy 配置改动，本计划不动手实现，记录为部署前置条件。

---

## Task 19: 全量回归 + 部署 + 端到端验证

- [ ] **Step 1: 全量单测 + 类型检查**

Run:
```bash
cd web && npx vitest run && npx tsc --noEmit
```
Expected: 全 PASS，无类型报错。

- [ ] **Step 2: 部署（web+db 走 GHA）**

Run:
```bash
git push origin main
gh run watch <run-id>
```
Expected: GHA 5 步全绿（migrate 跑 018/019/020；web 镜像重建）。

- [ ] **Step 3: 验证表已建 + 种子规则在**

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT check_type, target, enabled FROM monitor_rules ORDER BY id;\""
```
Expected: 6 条 service_down（enabled=true）+ 1 条 token_expire（enabled=false）。

- [ ] **Step 4: 验证监控桶已注册（web 日志）**

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker logs deploy-web-1 --tail 200 2>&1 | grep -E '注册监控桶|monitor'"
```
Expected: 4 行 `注册监控桶 __monitor_*`。

- [ ] **Step 5: 手动制造 service_down 告警（端到端）**

临时停掉一个非关键服务（如 openclaw），等 1 分钟扫描桶触发：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker compose -f /opt/data-analytics-platform/deploy/docker-compose.prod.yml stop openclaw"
# 等 ~70s，查告警
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT alert_key, status, occurrence_count, last_notify_at FROM monitor_alerts;\""
# 企微 App B 应收到「OpenClaw 不可达」通知
# 验证后恢复
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker compose -f /opt/data-analytics-platform/deploy/docker-compose.prod.yml start openclaw"
# 等 ~70s，该 alert_key 应转 resolved 且企微收到「✅ 已恢复」
```
Expected: 停服 → monitor_alerts 出现 `svc:openclaw` active + 企微收到告警；恢复 → status=resolved + 企微收到恢复通知。

- [ ] **Step 6: InsForge 兜底通道验证（谨慎）**

> 可选、低风险方式：临时把 `service-down.ts` 的 insforge probe URL 改成不存在的端口触发兜底，或临时 `docker compose stop insforge`（会影响全站，慎用）。验证 `notifyWecomDirect` 走通后立即恢复。**若不便验证，留 Phase B 一并验**，不阻塞本计划交付。

- [ ] **Step 7: collect_logs 修复验证**

触发一次采集，查 collect_logs：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT id, task_id, status, duration_ms FROM collect_logs ORDER BY id DESC LIMIT 5;\""
```
Expected: `duration_ms` 有非空值（修复生效）。

---

## Phase A 完成标准

- [ ] vitest 全绿（10 个测试文件）
- [ ] `tsc --noEmit` 通过
- [ ] GHA 部署成功（018/019/020 迁移跑通）
- [ ] 4 个监控桶在 web 日志可见
- [ ] 端到端：停/启一个服务 → 企微收到告警 + 恢复通知，monitor_alerts 状态正确
- [ ] collect_logs.duration_ms 有值

## Phase B（后续计划，本计划不实现）

- `collect_fail` evaluator + `request_fail` evaluator + `callLemengApi` 写 `external_request_logs` 埋点
- `data_freshness` / `contact_sync`（webhook route 写 monitor_state）/ `data_integrity` evaluator
- `/admin/monitor` 只读大盘（client 组件 + `/api/admin/monitor` 路由查 monitor_alerts/rules）+ 侧边栏入口
- 对应种子规则迁移
- 复用本计划的 store/engine/evaluator 注册表/lifecycle/notify 全部基础设施
