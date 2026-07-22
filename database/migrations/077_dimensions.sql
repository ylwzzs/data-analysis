-- 077_dimensions.sql
-- 语义层维度模型：dimensions（维度定义）+ dimension_levels（层级链）
-- branch 复用 dim_branch（三级），item 复用 dim_item（单品级）
-- customer（A4 派生物化）/category（品类层级）/date（内置）后续
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT
-- 部署后需重启 postgrest: docker compose restart postgrest

CREATE TABLE IF NOT EXISTS dimensions (
  dim_code           TEXT PRIMARY KEY,
  name               TEXT NOT NULL,         -- 中文
  description        TEXT,
  source_type        TEXT NOT NULL CHECK (source_type IN ('static','derived')),
  join_table         TEXT NOT NULL,         -- JOIN 的维表（dim_branch/dim_item/dim_customer）
  join_key           TEXT NOT NULL,         -- JOIN 键列
  source_fact_table  TEXT,                  -- derived: 派生自哪张事实表；static: NULL
  business_rule      TEXT,                  -- derived: 派生规则（中文自然语言）
  is_assessed_filter BOOLEAN DEFAULT false, -- 是否套 is_assessed_war_zone 白名单
  enabled            BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS dimension_levels (
  dim_code        TEXT NOT NULL REFERENCES dimensions(dim_code) ON DELETE CASCADE,
  level_code      TEXT NOT NULL,
  level_name      TEXT NOT NULL,            -- 中文
  depth           INT NOT NULL,
  key_column      TEXT NOT NULL,            -- 该级聚合键列
  name_column     TEXT NOT NULL,            -- 该级显示名列
  parent_level    TEXT,                     -- 父级 level_code（最顶层 NULL）
  rollup_strategy TEXT DEFAULT 'sum',       -- sum/distinct_count
  PRIMARY KEY (dim_code, level_code)
);

COMMENT ON TABLE dimensions IS '语义层维度定义：static=独立维表，derived=从事实表派生';
COMMENT ON TABLE dimension_levels IS '维度层级链：每级声明聚合键列+显示名列+父级';

INSERT INTO dimensions (dim_code, name, description, source_type, join_table, join_key, source_fact_table, business_rule, is_assessed_filter) VALUES
  ('branch','门店','门店组织维度（战区/小区/门店三级）','static','dim_branch','branch_num',NULL,NULL,true),
  ('item','商品','商品维度（单品级，品类层级后续扩展）','static','dim_item','item_num',NULL,NULL,false)
ON CONFLICT (dim_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, source_type=EXCLUDED.source_type,
  join_table=EXCLUDED.join_table, join_key=EXCLUDED.join_key, is_assessed_filter=EXCLUDED.is_assessed_filter;

INSERT INTO dimension_levels (dim_code, level_code, level_name, depth, key_column, name_column, parent_level, rollup_strategy) VALUES
  ('branch','region','战区',0,'first_level_region','first_level_region',NULL,'sum'),
  ('branch','sub_region','小区',1,'second_level_region','second_level_region','region','sum'),
  ('branch','store','门店',2,'branch_num','branch_name','sub_region','sum'),
  ('item','item','商品',0,'item_num','item_name',NULL,'sum')
ON CONFLICT (dim_code, level_code) DO UPDATE SET
  level_name=EXCLUDED.level_name, depth=EXCLUDED.depth, key_column=EXCLUDED.key_column,
  name_column=EXCLUDED.name_column, parent_level=EXCLUDED.parent_level, rollup_strategy=EXCLUDED.rollup_strategy;

GRANT SELECT ON dimensions, dimension_levels TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 077 completed: dimensions + levels (branch x3, item x1)'; END $$;
