-- 079_semantic_dictionary_v.sql
-- 人类可读语义字典视图：JOIN 指标 + 维度，中文展示
-- 可喂 get_data_dictionary() 升级 LLM 问数；也可直接 psql 查阅
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW（禁 CREATE OR REPLACE，防后迁移加列报错）
-- 部署后需重启 postgrest: docker compose restart postgrest

DROP VIEW IF EXISTS semantic_dictionary_v;

CREATE VIEW semantic_dictionary_v AS
SELECT
  'metric'::text               AS kind,
  metric_code                  AS code,
  name,
  description,
  business_formula             AS formula,
  measure_type,
  additive,
  cost_sensitive,
  unit
FROM metric_registry
WHERE enabled
UNION ALL
SELECT
  'dimension'::text            AS kind,
  dim_code                     AS code,
  name,
  description,
  business_rule                AS formula,
  source_type                  AS measure_type,
  is_assessed_filter           AS additive,
  NULL::boolean                AS cost_sensitive,
  NULL::text                   AS unit
FROM dimensions
WHERE enabled;

ALTER VIEW semantic_dictionary_v OWNER TO postgres;
ALTER VIEW semantic_dictionary_v SET (security_invoker = true);
GRANT SELECT ON semantic_dictionary_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 079 completed: semantic_dictionary_v'; END $$;
