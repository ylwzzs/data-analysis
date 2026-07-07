-- 016_retail_query_user_perms.sql
-- 智能问数权限：在部门制之上加「按人 override」层。
-- 动机：YangWei 这类人在企微通讯录但不在任何已同步部门里（bot 可见范围只到总经办），
--   部门制拉不到他；且给他部门设权限会波及同事（不是"单独开")。
--   per-user override 独立于部门/同步，只授权具体个人。
-- 优先级：get_user_perms 先查 retail_query_user_perms，命中即用；否则走原部门聚合（向后兼容）。
-- 表不加 RLS/GRANT：get_user_perms 是 SECURITY DEFINER（以 owner 身份读），按人表只经 RPC 可读，不对 PostgREST 直接暴露。
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION。

BEGIN;

-- ① 按人权限 override 表
CREATE TABLE IF NOT EXISTS retail_query_user_perms (
  wecom_id      VARCHAR PRIMARY KEY,
  user_name     VARCHAR,
  branch_nums   JSONB   NOT NULL DEFAULT '["*"]'::jsonb,
  can_see_cost  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE retail_query_user_perms IS '智能问数按人权限 override（优先于部门聚合；用于不在已同步部门里的个人授权）';

-- ② 改 get_user_perms：先查按人表，命中即返；否则走原部门聚合逻辑（不变）
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
  vpu_branch JSONB;
  vpu_cost BOOLEAN;
  vpu_name VARCHAR;
BEGIN
  -- ① 按人 override（优先）：命中即用，独立于部门/通讯录同步
  SELECT branch_nums, can_see_cost, user_name
  INTO vpu_branch, vpu_cost, vpu_name
  FROM retail_query_user_perms
  WHERE wecom_id = p_wecom_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'user_id', p_wecom_id,
      'user_name', COALESCE(vpu_name, p_wecom_id),
      'branch_nums', vpu_branch,
      'can_see_cost', COALESCE(vpu_cost, FALSE)
    );
  END IF;

  -- ② 部门聚合（原逻辑，向后兼容）
  SELECT name, department_ids INTO v_name, v_dept_ids
  FROM org_users WHERE wecom_id = p_wecom_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'user_not_found', 'user_id', p_wecom_id);
  END IF;

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
COMMENT ON FUNCTION get_user_perms IS '智能问数权限：先查按人 override 表(retail_query_user_perms)，未命中再按部门聚合 branch_nums + can_see_cost';

COMMIT;
