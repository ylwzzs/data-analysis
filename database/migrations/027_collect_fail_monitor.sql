-- 027_collect_fail_monitor.sql
-- 1) 统一 3120 采集任务命名（乐檬-3120-xxxx，与 64188 一致）
-- 2) 补 collect_fail 监控规则（此前无 evaluator + 无规则，采集失败从不告警）
-- 幂等（migrate.sh 每次部署重跑全部迁移）：UPDATE 幂等；INSERT 用 (check_type,target) 唯一索引 ON CONFLICT。

-- ① 3120 任务改名
UPDATE collect_tasks SET name = '乐檬-3120-商品档案采集',   updated_at = NOW() WHERE id = 'a0000000-0000-0000-0000-000000000002';
UPDATE collect_tasks SET name = '乐檬-3120-销售订单明细采集', updated_at = NOW() WHERE id = '999ad6d7-2edd-4b36-9e77-8b86d837dce5';

-- ② 商品档案（每日、重要）：连续 1 次失败即告警
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled) VALUES
 ('采集失败·乐檬-3120-商品档案采集', 'collect_fail', 'a0000000-0000-0000-0000-000000000002', '{"consecutive":1,"window":5}'::jsonb, 'high',
  '连续 {consecutive_count} 次失败（最近状态 {last_status}）：{last_error}', 1800, true),
 ('采集失败·乐檬-64188-商品档案采集', 'collect_fail', 'c0000000-0000-0000-0000-000000000003', '{"consecutive":1,"window":5}'::jsonb, 'high',
  '连续 {consecutive_count} 次失败（最近状态 {last_status}）：{last_error}', 1800, true)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold = EXCLUDED.threshold, severity = EXCLUDED.severity, template = EXCLUDED.template, enabled = TRUE;

-- ③ 销售明细（每 5 分钟、容忍瞬态）：连续 3 次失败才告警
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled) VALUES
 ('采集失败·乐檬-3120-销售订单明细', 'collect_fail', '999ad6d7-2edd-4b36-9e77-8b86d837dce5', '{"consecutive":3,"window":6}'::jsonb, 'medium',
  '连续 {consecutive_count} 次失败（最近状态 {last_status}）：{last_error}', 1800, true),
 ('采集失败·乐檬-64188-销售订单明细', 'collect_fail', 'c0000000-0000-0000-0000-000000000002', '{"consecutive":3,"window":6}'::jsonb, 'medium',
  '连续 {consecutive_count} 次失败（最近状态 {last_status}）：{last_error}', 1800, true)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold = EXCLUDED.threshold, severity = EXCLUDED.severity, template = EXCLUDED.template, enabled = TRUE;
