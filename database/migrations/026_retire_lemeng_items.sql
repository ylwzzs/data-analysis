-- 026_retire_lemeng_items.sql
-- lemeng_items 已被 dim_item 取代（数据已采入 dim_item，collect-items 已改写目标）。
-- 撤销写权限、降级只读兜底；保留表以便回滚，观察确认无误后再单独 DROP。
-- 幂等：REVOKE / COMMENT 可重复执行。

REVOKE INSERT, UPDATE, DELETE ON lemeng_items FROM anon, authenticated;
COMMENT ON TABLE lemeng_items IS 'DEPRECATED 2026-07-10: 已由 dim_item 取代，只读兜底，待确认后 DROP';
