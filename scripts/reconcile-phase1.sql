-- reconcile-phase1.sql
-- 双轨对账：生成器新视图 report_store_sales_drill_v vs Phase 1 手写 report_region_breakdown_v
-- 同 target_id、同层级，SUM(sale) 应一致（diff < 1元容差）
-- 用法：docker exec deploy-postgres-1 psql -U postgres -d insforge -f scripts/reconcile-phase1.sql

WITH old AS (
  SELECT target_id, SUM(sale_actual) AS old_total
  FROM report_region_breakdown_v
  WHERE level = 'store' AND sale_actual IS NOT NULL
  GROUP BY target_id
),
new AS (
  SELECT target_id, SUM(sale_amount) AS new_total
  FROM report_store_sales_drill_v
  WHERE level = 'store'
  GROUP BY target_id
)
SELECT
  COALESCE(o.target_id, n.target_id) AS target_id,
  o.old_total,
  n.new_total,
  ABS(COALESCE(o.old_total, 0) - COALESCE(n.new_total, 0)) AS diff,
  CASE WHEN ABS(COALESCE(o.old_total, 0) - COALESCE(n.new_total, 0)) < 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM old o
FULL OUTER JOIN new n ON o.target_id = n.target_id
ORDER BY diff DESC;
-- 期望：所有行 verdict=PASS（diff<1元）
