-- 068_metric_rename.sql
-- 四个考核指标改名(公式/metric_code不变,只改显示名): sale→门店零售, delivery→门店配送, outbound_amt→总仓出库金额, outbound_profit→总仓出库毛利
-- 前端 label/METRIC_NAME 已改; 本迁移同步 DB metric_definitions.name(智能问数 metric_name 显示用)
-- purchase(拿货目标)不在考核4指标, 不改
-- 幂等: UPDATE

UPDATE metric_definitions SET name='门店零售' WHERE metric_code='sale';
UPDATE metric_definitions SET name='门店配送' WHERE metric_code='delivery';
UPDATE metric_definitions SET name='总仓出库金额' WHERE metric_code='outbound_amt';
UPDATE metric_definitions SET name='总仓出库毛利' WHERE metric_code='outbound_profit';

DO $$ BEGIN RAISE NOTICE 'Migration 068_metric_rename completed'; END $$;
