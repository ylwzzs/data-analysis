-- 002_seed.sql
-- 业务表 anon 访问权限 + 字段扩展 + 种子数据
-- 前端通过 anon_key 经 PostgREST 匿名读取，需 GRANT 给 anon role

-- data_sources 扩展字段（匹配前端 DataSource 展示：最后同步、行数）
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS last_sync TIMESTAMP;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS row_count INT;

-- 允许 anon role 读取业务表（PostgREST 匿名访问）
GRANT SELECT ON data_sources, data_files, reports, org_users, org_departments, data_permissions, query_logs TO anon;

-- 报表种子数据（metrics JSONB 对齐前端 Metric[]: name/value/change/trend）
INSERT INTO reports (name, description, metrics, updated_at) VALUES
('销售日报', '每日销售数据汇总', '[{"name":"销售额","value":"¥125,000","change":"+12%","trend":"up"},{"name":"订单数","value":"328","change":"+8%","trend":"up"}]'::jsonb, '2026-06-29 10:30:00'),
('运营周报', '每周运营数据分析', '[{"name":"新增用户","value":"1,250","change":"-3%","trend":"down"},{"name":"活跃用户","value":"8,500","change":"+5%","trend":"up"}]'::jsonb, '2026-06-28 18:00:00');

-- 数据源种子数据
INSERT INTO data_sources (name, description, api_endpoint, auth_type, schedule, enabled, last_sync, row_count) VALUES
('销售系统', '订单与销售额数据', 'https://api.example.com/sales', 'api_key', '每日 02:00', true, '2026-06-29 02:00:00', 12580),
('运营平台', '用户与活动数据', 'https://api.example.com/ops', 'oauth', '每小时', true, '2026-06-29 14:00:00', 85230),
('财务系统', '收支与发票数据', 'https://api.example.com/finance', 'basic', '每日 03:00', false, '2026-06-28 03:00:00', 4320);
