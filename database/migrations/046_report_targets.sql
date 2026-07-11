-- 046_report_targets.sql
-- 报表体系 D：目标与达成率（spec §4，依赖 045 report_* 含 system_book_code）
-- 4 表(metric_definitions/targets/target_metric_values/target_snapshots)
-- + close_target 固化函数(SECURITY DEFINER)
-- + report_achievement_v 三态达成率视图(security_invoker)
-- + datasets/dataset_columns 注册(问数出口)

-- ===== metric_definitions：指标定义层（开发维护口径，admin 只选）=====
CREATE TABLE IF NOT EXISTS metric_definitions (
    metric_code    TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    source_dataset TEXT,
    value_column   TEXT,
    unit           TEXT,
    data_ready     BOOLEAN NOT NULL DEFAULT false,
    enabled        BOOLEAN NOT NULL DEFAULT true,
    description    TEXT,
    created_at     TIMESTAMPTZ DEFAULT now()
);

INSERT INTO metric_definitions (metric_code, name, source_dataset, value_column, unit, data_ready, enabled, description) VALUES
  ('sale', '销售目标', 'report_daily_sales', 'total_sale', '元', true, true,
   '销售额达成（SUM report_daily_sales.total_sale 按门店+日期段）'),
  ('purchase', '拿货目标', NULL, NULL, '件', false, true,
   '配送明细拿货量（数据源待接入，接入后翻 data_ready=true 并扩展视图）')
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, source_dataset=EXCLUDED.source_dataset, value_column=EXCLUDED.value_column,
  unit=EXCLUDED.unit, enabled=EXCLUDED.enabled, description=EXCLUDED.description;

-- ===== targets：目标主表（时间段+门店+状态）=====
CREATE TABLE IF NOT EXISTS targets (
    id               BIGSERIAL PRIMARY KEY,
    name             TEXT NOT NULL,
    system_book_code TEXT NOT NULL,
    branch_num       TEXT NOT NULL,
    start_date       DATE NOT NULL,
    end_date         DATE NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    closed_at        TIMESTAMPTZ,
    note             TEXT,
    created_by       TEXT,
    created_at       TIMESTAMPTZ DEFAULT now(),
    updated_at       TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT target_dates CHECK (end_date >= start_date),
    UNIQUE (system_book_code, branch_num, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS idx_targets_status_dates ON targets(status, end_date);

DROP TRIGGER IF EXISTS update_targets_updated_at ON targets;
CREATE TRIGGER update_targets_updated_at
    BEFORE UPDATE ON targets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== target_metric_values：目标挂的各指标目标值 =====
CREATE TABLE IF NOT EXISTS target_metric_values (
    target_id    BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    metric_code  TEXT NOT NULL REFERENCES metric_definitions(metric_code),
    target_value NUMERIC(14,2) NOT NULL,
    PRIMARY KEY (target_id, metric_code)
);

-- ===== target_snapshots：已结束目标的固化实际值 =====
CREATE TABLE IF NOT EXISTS target_snapshots (
    target_id        BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    metric_code      TEXT NOT NULL,
    actual_value     NUMERIC(14,2),
    achievement_rate NUMERIC(6,2),
    data_status      TEXT,
    snapshot_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (target_id, metric_code)
);

-- ===== RLS + GRANT（照抄 015 branch_nums policy；已知局限：claim 不含品牌）=====
ALTER TABLE targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS targets_rls_branch_nums ON targets;
CREATE POLICY targets_rls_branch_nums ON targets
  FOR SELECT TO authenticated
  USING (
    current_setting('request.jwt.claims.branch_nums', true) IS NULL
    OR current_setting('request.jwt.claims.branch_nums', true)::jsonb ? '*'
    OR branch_num = ANY(ARRAY(SELECT jsonb_array_elements_text(current_setting('request.jwt.claims.branch_nums', true)::jsonb)))
  );

ALTER TABLE target_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS snapshots_rls_branch_nums ON target_snapshots;
CREATE POLICY snapshots_rls_branch_nums ON target_snapshots
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM targets WHERE targets.id = target_snapshots.target_id AND (
      current_setting('request.jwt.claims.branch_nums', true) IS NULL
      OR current_setting('request.jwt.claims.branch_nums', true)::jsonb ? '*'
      OR targets.branch_num = ANY(ARRAY(SELECT jsonb_array_elements_text(current_setting('request.jwt.claims.branch_nums', true)::jsonb)))
    ))
  );

GRANT SELECT ON metric_definitions TO authenticated;
GRANT SELECT ON targets TO authenticated;
GRANT SELECT ON target_metric_values TO authenticated;
GRANT SELECT ON target_snapshots TO authenticated;

-- ===== close_target：固化目标实际值 → snapshot → status=closed（幂等，可重固化）=====
-- 自动(scheduler end_date次日) 或 手动(UI提前结束) 触发；service 身份绕 RLS 算 actual
CREATE OR REPLACE FUNCTION close_target(p_target_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t_rec RECORD;
    v_actual NUMERIC(14,2);
    v_days_have INTEGER;
    v_total_days INTEGER;
    v_dstatus TEXT;
    v_metric TEXT;
    v_tval NUMERIC(14,2);
BEGIN
    SELECT * INTO t_rec FROM targets WHERE id = p_target_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'target not found'); END IF;
    v_total_days := t_rec.end_date - t_rec.start_date + 1;
    FOR v_metric IN SELECT metric_code FROM target_metric_values WHERE target_id = p_target_id LOOP
        SELECT target_value INTO v_tval FROM target_metric_values WHERE target_id=p_target_id AND metric_code=v_metric;
        IF v_metric = 'sale' THEN
            SELECT COALESCE(SUM(total_sale),0), COUNT(DISTINCT biz_date)
              INTO v_actual, v_days_have
              FROM report_daily_sales
             WHERE system_book_code = t_rec.system_book_code
               AND branch_num = t_rec.branch_num
               AND biz_date BETWEEN t_rec.start_date AND t_rec.end_date;
            v_dstatus := CASE WHEN v_days_have = 0 THEN 'missing'
                              WHEN v_days_have < v_total_days THEN 'partial' ELSE 'complete' END;
            INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
            VALUES (p_target_id, v_metric, v_actual,
                    CASE WHEN v_tval > 0 THEN round((v_actual / v_tval)::numeric, 4) ELSE NULL END,
                    v_dstatus, now())
            ON CONFLICT (target_id, metric_code) DO UPDATE SET
              actual_value=EXCLUDED.actual_value, achievement_rate=EXCLUDED.achievement_rate,
              data_status=EXCLUDED.data_status, snapshot_at=now();
        ELSE
            -- not-ready 指标（如 purchase 未接入）占位
            INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
            VALUES (p_target_id, v_metric, NULL, NULL, 'not_ready', now())
            ON CONFLICT (target_id, metric_code) DO UPDATE SET data_status='not_ready', snapshot_at=now();
        END IF;
    END LOOP;
    UPDATE targets SET status='closed', closed_at=now(), updated_at=now() WHERE id = p_target_id;
    RETURN jsonb_build_object('ok', true, 'target_id', p_target_id, 'metrics',
      (SELECT jsonb_agg(jsonb_build_object('metric', metric_code, 'actual', actual_value, 'rate', achievement_rate, 'status', data_status))
       FROM target_snapshots WHERE target_id = p_target_id));
END $$;
GRANT EXECUTE ON FUNCTION close_target(BIGINT) TO authenticated;

-- ===== report_achievement_v：达成率三态视图（active+sale实时 / active+not_ready / closed读snapshot）=====
DROP VIEW IF EXISTS report_achievement_v;
CREATE VIEW report_achievement_v AS
SELECT
    t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
    t.system_book_code, t.branch_num,
    b.branch_name,
    derive_war_zone(b.region_name) AS war_zone,
    b.region_name, b.city,
    mv.metric_code, md.name AS metric_name, md.unit, md.data_ready,
    mv.target_value,
    CASE
      WHEN t.status = 'closed' THEN sn.actual_value
      WHEN md.metric_code = 'sale' AND md.data_ready THEN sa.sale_actual
      ELSE NULL
    END AS actual_value,
    CASE
      WHEN t.status = 'closed' THEN sn.data_status
      WHEN md.metric_code = 'sale' AND md.data_ready THEN
        CASE WHEN sa.sale_days = 0 THEN 'missing'
             WHEN sa.sale_days < (t.end_date - t.start_date + 1) THEN 'partial'
             ELSE 'complete' END
      ELSE 'not_ready'
    END AS data_status,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed,
    CASE WHEN mv.target_value > 0 AND t.status='closed' THEN sn.achievement_rate
         WHEN mv.target_value > 0 AND md.metric_code='sale' AND md.data_ready
         THEN round((COALESCE(sa.sale_actual,0) / mv.target_value)::numeric, 4)
         ELSE NULL END AS achievement_rate,
    CASE WHEN t.status='active' AND mv.target_value > 0 AND md.metric_code='sale' AND md.data_ready
              AND (LEAST(current_date, t.end_date) - t.start_date + 1) > 0
         THEN round((COALESCE(sa.sale_actual,0) / (
              mv.target_value * (LEAST(current_date, t.end_date) - t.start_date + 1)::numeric
              / (t.end_date - t.start_date + 1)))::numeric, 4)
         ELSE NULL END AS progress_rate
FROM targets t
JOIN target_metric_values mv ON mv.target_id = t.id
JOIN metric_definitions md ON md.metric_code = mv.metric_code
LEFT JOIN dim_branch b
       ON b.system_book_code = t.system_book_code AND b.branch_num = t.branch_num
LEFT JOIN target_snapshots sn
       ON sn.target_id = t.id AND sn.metric_code = mv.metric_code
LEFT JOIN LATERAL (
    SELECT SUM(r.total_sale) AS sale_actual,
           count(DISTINCT r.biz_date) AS sale_days
    FROM report_daily_sales r
    WHERE r.system_book_code = t.system_book_code
      AND r.branch_num = t.branch_num
      AND r.biz_date BETWEEN t.start_date AND t.end_date
) sa ON md.metric_code = 'sale';

ALTER VIEW report_achievement_v OWNER TO postgres;
ALTER VIEW report_achievement_v SET (security_invoker = true);
GRANT SELECT ON report_achievement_v TO authenticated;

-- ===== 注册 report_achievement_v 到数据字典（问数出口，照 032 模式）=====
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description) VALUES
  ('report_achievement_v','目标达成率(三态)','pg_table','report_achievement_v','summary', TRUE, TRUE, 'start_date', 'YYYY-MM-DD', FALSE, TRUE,
   '目标达成率：active实时/closed读snapshot/not_ready；含 target/actual/achievement_rate/progress_rate')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, is_realtime=EXCLUDED.is_realtime,
  exposed=EXCLUDED.exposed, description=EXCLUDED.description;

INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
  ('report_achievement_v','target_id','BIGINT','标识',FALSE,NULL,'目标ID',1),
  ('report_achievement_v','name','TEXT','标识',FALSE,NULL,'目标名称',2),
  ('report_achievement_v','status','TEXT','状态',FALSE,NULL,'active/closed',3),
  ('report_achievement_v','start_date','DATE','日期',FALSE,NULL,'周期起',4),
  ('report_achievement_v','end_date','DATE','日期',FALSE,NULL,'周期止',5),
  ('report_achievement_v','system_book_code','TEXT','维度',FALSE,'dim_branch.system_book_code','品牌',6),
  ('report_achievement_v','branch_num','TEXT','维度',FALSE,'dim_branch.branch_num','门店',7),
  ('report_achievement_v','war_zone','TEXT','维度',FALSE,NULL,'战区(roll-up)',8),
  ('report_achievement_v','region_name','TEXT','维度',FALSE,NULL,'区域',9),
  ('report_achievement_v','city','TEXT','维度',FALSE,NULL,'城市',10),
  ('report_achievement_v','metric_code','TEXT','指标',FALSE,'metric_definitions.metric_code','指标code',11),
  ('report_achievement_v','metric_name','TEXT','指标',FALSE,NULL,'指标名',12),
  ('report_achievement_v','target_value','DECIMAL','金额',FALSE,NULL,'目标值',13),
  ('report_achievement_v','actual_value','DECIMAL','金额',FALSE,NULL,'实际值',14),
  ('report_achievement_v','achievement_rate','DECIMAL','比率',FALSE,NULL,'累计达成率(actual/target)',15),
  ('report_achievement_v','progress_rate','DECIMAL','比率',FALSE,NULL,'进度对齐(按已过天数折算)',16),
  ('report_achievement_v','data_status','TEXT','状态',FALSE,NULL,'complete/partial/missing/not_ready',17)
ON CONFLICT (dataset_name, name) DO UPDATE SET data_type=EXCLUDED.data_type, description=EXCLUDED.description;

DO $$ BEGIN RAISE NOTICE 'Migration 046_report_targets applied'; END $$;
