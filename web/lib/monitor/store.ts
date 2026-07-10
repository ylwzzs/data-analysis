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
    // 查任意状态的告警（不只 active）：恢复(resolved)后再次失败须"重开"为 active，
    // 否则 insert 会撞 alert_key 唯一约束（duplicate key）。与 MemoryStore 覆盖语义一致。
    const { data, error: qErr } = await this.client.database
      .from('monitor_alerts')
      .select('*')
      .eq('alert_key', row.alert_key)
      .maybeSingle();
    if (qErr) throw new Error(`upsertAlert get: ${qErr.message}`);
    const existing = (data as ActiveAlertRow | null) ?? null;
    const nowIso = new Date().toISOString();

    if (existing && existing.status === 'active') {
      const { error } = await this.client.database
        .from('monitor_alerts')
        .update({
          occurrence_count: existing.occurrence_count + 1,
          last_seen_at: nowIso,
          context: row.context ?? existing.context,
        })
        .eq('alert_key', row.alert_key)
        .eq('status', 'active');
      if (error) throw new Error(`upsertAlert update: ${error.message}`);
    } else if (existing) {
      // resolved → 重开 active：重置计数/时间、清 last_notify_at 触发再通知
      const { error } = await this.client.database
        .from('monitor_alerts')
        .update({
          status: 'active',
          occurrence_count: 1,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
          resolved_at: null,
          last_notify_at: null,
          context: row.context ?? existing.context,
        })
        .eq('alert_key', row.alert_key);
      if (error) throw new Error(`upsertAlert reopen: ${error.message}`);
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
