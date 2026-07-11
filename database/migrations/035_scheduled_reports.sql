-- 035_scheduled_reports.sql
-- C4: 定时应用绑定（OpenClaw cron_job_id → run_as=创建者）。plugin 透传 cronSessionKey，agent-query 反查 run_as。
CREATE TABLE IF NOT EXISTS scheduled_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wecom_id TEXT NOT NULL,          -- 创建者（=run_as）
  cron_job_id TEXT NOT NULL,             -- OpenClaw cron job id（反查键）
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('template','sql')),
  template_key TEXT,                     -- mode=template：daily_sales_brief/weekly/category_rank
  query_intent TEXT,                     -- mode=sql：自然语言意图
  delivery_to TEXT NOT NULL,             -- 推送目标企微 userid（push_report 强制读）
  run_as TEXT NOT NULL,                  -- = owner_wecom_id（钉死）
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT run_as_is_owner CHECK (run_as = owner_wecom_id),
  CONSTRAINT mode_fields CHECK (
    (mode='template' AND template_key IS NOT NULL) OR
    (mode='sql' AND query_intent IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_cron_job ON scheduled_reports(cron_job_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_owner ON scheduled_reports(owner_wecom_id);

-- RLS：用户只能管自己的定时应用（owner 维度）
ALTER TABLE scheduled_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduled_reports_owner ON scheduled_reports;
CREATE POLICY scheduled_reports_owner ON scheduled_reports
  FOR ALL TO authenticated
  USING (owner_wecom_id = current_setting('request.jwt.claims.sub', true))
  WITH CHECK (owner_wecom_id = current_setting('request.jwt.claims.sub', true));
GRANT SELECT ON scheduled_reports TO authenticated;

-- SECURITY DEFINER RPC：agent-query 反查 run_as（serviceJwt 调，越权读但只读 run_as）
CREATE OR REPLACE FUNCTION get_scheduled_run_as(p_cron_job_id TEXT)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT run_as FROM scheduled_reports WHERE cron_job_id = $1 AND enabled LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION get_scheduled_run_as(TEXT) TO authenticated;

COMMENT ON TABLE scheduled_reports IS '定时应用绑定（spec C4；cron_job_id→run_as 反查）';
DO $$ BEGIN RAISE NOTICE 'Migration 035_scheduled_reports applied'; END $$;
