-- 015_agent_query_perms_and_rls.sql
-- 智能问数鉴权架构落地（架构文档 docs/architecture.md §4.2）
-- 三件事：
--   1. org_departments 加权限底座列：branch_nums（门店行级）+ can_see_cost（成本列级）
--   2. get_user_perms(p_wecom_id) RPC：聚合用户部门权限，供网关 / wecom-oauth 解析 perms
--   3. 汇总表启用 RLS（行级 branch_nums，claim 缺失放行=零爆炸半径）+ execute_sql_rls RPC（agent 查 PG 用，SECURITY INVOKER 走 RLS）
-- 幂等设计，可重复执行。

-- ============================================
-- 1. org_departments 权限底座列
-- ============================================
ALTER TABLE org_departments
ADD COLUMN IF NOT EXISTS branch_nums JSONB DEFAULT '["*"]'::jsonb;

ALTER TABLE org_departments
ADD COLUMN IF NOT EXISTS can_see_cost BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN org_departments.branch_nums IS '可访问门店号列表（智能问数行级权限底座），["*"]=全门店；区域/人员维度后填，映射到门店集合';
COMMENT ON COLUMN org_departments.can_see_cost IS '是否可见成本/毛利敏感列（智能问数列级权限）';

-- ============================================
-- 2. get_user_perms(p_wecom_id) RPC
--    聚合用户所属部门的 branch_nums（并集，"*"通配）+ can_see_cost（任一部门 true 即 true）
--    SECURITY DEFINER：网关用 service key（anon role）调用，需越权读权限配置
--    返回 {user_id, user_name, branch_nums:[..], can_see_cost:bool}
--    MVP 无映射时 branch_nums 默认 ["*"]（全量占位，架构文档 §4.2 line 388）
-- ============================================
CREATE OR REPLACE FUNCTION get_user_perms(p_wecom_id VARCHAR)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name VARCHAR;
  v_dept_ids JSONB;
  v_branch_nums TEXT[];
  v_can_see BOOLEAN;
BEGIN
  SELECT name, department_ids INTO v_name, v_dept_ids
  FROM org_users WHERE wecom_id = p_wecom_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'user_not_found', 'user_id', p_wecom_id);
  END IF;

  -- 聚合部门权限（department_ids 是 JSONB 数组，展开后匹配 org_departments.id）
  SELECT
    CASE WHEN bool_or(d.branch_nums ? '*') THEN ARRAY['*']
         ELSE array_remove(array_agg(DISTINCT elem.el), NULL)
    END,
    bool_or(d.can_see_cost)
  INTO v_branch_nums, v_can_see
  FROM org_departments d
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(d.branch_nums, '[]'::jsonb)) AS elem(el)
  WHERE v_dept_ids IS NOT NULL
    AND d.id IN (SELECT jsonb_array_elements_text(v_dept_ids));

  -- MVP 占位：用户无部门或部门无门店配置 → 全量 ["*"]（区域/人员映射后填）
  IF v_branch_nums IS NULL OR array_length(v_branch_nums, 1) IS NULL THEN
    v_branch_nums := ARRAY['*'];
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_wecom_id,
    'user_name', v_name,
    'branch_nums', to_jsonb(v_branch_nums),
    'can_see_cost', COALESCE(v_can_see, FALSE)
  );
END;
$$;

COMMENT ON FUNCTION get_user_perms IS '按企微 wecom_id 聚合智能问数权限（branch_nums + can_see_cost）';

-- ============================================
-- 3a. 汇总表启用 RLS（行级 branch_nums）
--     策略：claim 缺失（旧 token / 未改造调用方）→ 放行（零爆炸半径）
--           claim 含 "*" → 全放行
--           否则 branch_num 精确匹配
-- ============================================
ALTER TABLE report_daily_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_daily_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_weekly_trend ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS report_rls_branch_nums ON report_daily_sales;
CREATE POLICY report_rls_branch_nums ON report_daily_sales
  FOR SELECT TO authenticated
  USING (
    current_setting('request.jwt.claims.branch_nums', true) IS NULL
    OR current_setting('request.jwt.claims.branch_nums', true)::jsonb ? '*'
    OR branch_num = ANY(
      ARRAY(SELECT jsonb_array_elements_text(current_setting('request.jwt.claims.branch_nums', true)::jsonb))
    )
  );

DROP POLICY IF EXISTS report_rls_branch_nums ON report_daily_category;
CREATE POLICY report_rls_branch_nums ON report_daily_category
  FOR SELECT TO authenticated
  USING (
    current_setting('request.jwt.claims.branch_nums', true) IS NULL
    OR current_setting('request.jwt.claims.branch_nums', true)::jsonb ? '*'
    OR branch_num = ANY(
      ARRAY(SELECT jsonb_array_elements_text(current_setting('request.jwt.claims.branch_nums', true)::jsonb))
    )
  );

DROP POLICY IF EXISTS report_rls_branch_nums ON report_weekly_trend;
CREATE POLICY report_rls_branch_nums ON report_weekly_trend
  FOR SELECT TO authenticated
  USING (
    current_setting('request.jwt.claims.branch_nums', true) IS NULL
    OR current_setting('request.jwt.claims.branch_nums', true)::jsonb ? '*'
    OR branch_num = ANY(
      ARRAY(SELECT jsonb_array_elements_text(current_setting('request.jwt.claims.branch_nums', true)::jsonb))
    )
  );

-- ============================================
-- 3b. execute_sql_rls(query TEXT) RPC
--     agent 网关查 PG 汇总表用。SECURITY INVOKER → 以调用者（authenticated）身份执行，
--     request.jwt.claims.* 由 PostgREST 注入 → RLS 自动按 branch_nums 过滤。
--     与 006 的 execute_sql（SECURITY DEFINER，绕过 RLS，已弃用）区别在此。
--     SQL 白名单：仅 SELECT，禁 read_parquet/DDL/DML（网关已前置校验，此处兜底）
-- ============================================
CREATE OR REPLACE FUNCTION execute_sql_rls(p_query TEXT)
RETURNS SETOF JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  u TEXT;
BEGIN
  u := UPPER(TRIM(p_query));
  IF u NOT LIKE 'SELECT%' THEN
    RETURN NEXT jsonb_build_object('error', 'only_select_allowed');
    RETURN;
  END IF;
  IF u LIKE '%INSERT%' OR u LIKE '%UPDATE%' OR u LIKE '%DELETE%'
     OR u LIKE '%DROP%' OR u LIKE '%TRUNCATE%' OR u LIKE '%ALTER%'
     OR u LIKE '%CREATE%' OR u LIKE '%GRANT%' OR u LIKE '%READ_PARQUET%' THEN
    RETURN NEXT jsonb_build_object('error', 'forbidden_statement');
    RETURN;
  END IF;
  -- 包一层 to_jsonb：把任意列结构的结果行统一成 JSONB（匹配 RETURNS SETOF JSONB）。
  -- p_query 已过白名单（仅 SELECT），拼接安全。
  RETURN QUERY EXECUTE 'SELECT to_jsonb(q) FROM (' || p_query || ') AS q';
END;
$$;

COMMENT ON FUNCTION execute_sql_rls IS 'agent 网关查 PG 汇总表（SECURITY INVOKER，走 RLS）';

-- ============================================
-- 4. 权限授予
-- ============================================
GRANT EXECUTE ON FUNCTION get_user_perms(VARCHAR) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION execute_sql_rls(TEXT) TO authenticated;

DO $$ BEGIN RAISE NOTICE 'Migration 015_agent_query_perms_and_rls applied'; END $$;
