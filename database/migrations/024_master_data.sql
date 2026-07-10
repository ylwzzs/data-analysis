-- 024_master_data.sql
-- 报表主数据（商品）：dim_item / dim_item_ext / item_scenario_names + canonical_product 视图
-- 门店 dim_branch 延后（单独采，同 dim_item 模式，base 列待看 branch API 真实结构再定，不臆想）。
-- 设计依据：docs/superpowers/specs/2026-07-10-report-master-data-design.md
-- 幂等：全部 IF NOT EXISTS / OR REPLACE。

-- ===== 商品主数据（采集权威：覆盖 base + raw JSONB） =====
CREATE TABLE IF NOT EXISTS dim_item (
    system_book_code   TEXT NOT NULL,           -- 品牌（3120/64188），源自 API system_book_code
    item_num           TEXT NOT NULL,           -- 商品编号（品牌内）
    item_code          TEXT,                    -- 业务编码 = 跨品牌合并键
    bar_code           TEXT,                    -- 条码（主规格）
    item_name          TEXT,
    -- 类别拆结构化（不再存 JSON blob）
    category_code      TEXT,
    category_name      TEXT,
    category_path      TEXT,                    -- full_category_path，如「生鲜->水果生鲜->菠萝凤梨类」
    top_category       TEXT,                    -- 如「SX|生鲜」
    item_brand         TEXT,
    department         TEXT,
    item_unit          TEXT,
    item_regular_price TEXT,
    item_cost_price    TEXT,                    -- 成本敏感列：搬运 DuckDB 须按 §4.2 can_see_cost 脱敏
    supplier_name      TEXT,                    -- 主供应商
    item_tags          TEXT,                    -- item_tag_strs
    raw                JSONB,                   -- 其余 ~150 字段备查
    updated_at         TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (system_book_code, item_num)
);
CREATE INDEX IF NOT EXISTS idx_dim_item_code ON dim_item(item_code);
CREATE INDEX IF NOT EXISTS idx_dim_item_category ON dim_item(category_name);
DROP TRIGGER IF EXISTS update_dim_item_updated_at ON dim_item;
CREATE TRIGGER update_dim_item_updated_at
    BEFORE UPDATE ON dim_item FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
COMMENT ON TABLE dim_item IS '商品主数据（采集覆盖 base 列 + raw JSONB；PK 品牌隔离防跨品牌碰撞）';

-- ===== 商品扩展（人工维护，采集永不碰） =====
CREATE TABLE IF NOT EXISTS dim_item_ext (
    system_book_code TEXT NOT NULL,
    item_num         TEXT NOT NULL,
    custom_group     TEXT,                      -- 自定义分组（示例列，按需扩）
    note             TEXT,
    updated_at       TIMESTAMP DEFAULT NOW(),
    updated_by       TEXT,
    PRIMARY KEY (system_book_code, item_num),
    FOREIGN KEY (system_book_code, item_num) REFERENCES dim_item(system_book_code, item_num) ON DELETE CASCADE
);
COMMENT ON TABLE dim_item_ext IS '商品扩展（人工二次维护，采集绝不写入；外键级联删）';

-- ===== 场景命名（跨品牌共享，挂 canonical item_code） =====
CREATE TABLE IF NOT EXISTS item_scenario_names (
    item_code    TEXT NOT NULL,
    scenario     TEXT NOT NULL,                 -- 场景，如「节日礼盒」「日常」
    display_name TEXT NOT NULL,
    PRIMARY KEY (item_code, scenario)
);
COMMENT ON TABLE item_scenario_names IS '商品场景命名映射（一商品多场景多名）';

-- ===== 跨品牌合并视图（按 item_code 自动聚合；60% 同码合并、40% 各异分开） =====
CREATE OR REPLACE VIEW canonical_product AS
SELECT item_code,
       (ARRAY_AGG(item_name ORDER BY item_name))[1] AS display_name,
       (ARRAY_AGG(category_name ORDER BY item_name))[1] AS category_name,
       (ARRAY_AGG(top_category ORDER BY item_name))[1] AS top_category,
       COUNT(DISTINCT system_book_code) AS brand_count,
       ARRAY_AGG(DISTINCT system_book_code) AS brands
FROM dim_item
WHERE item_code IS NOT NULL
GROUP BY item_code;
COMMENT ON VIEW canonical_product IS '跨品牌合并层：按 item_code 自动聚合（无人工映射表）';

-- ===== 权限 =====
GRANT SELECT ON dim_item, canonical_product, item_scenario_names TO authenticated;
GRANT SELECT, INSERT, UPDATE ON dim_item_ext, item_scenario_names TO authenticated;
-- anon 默认无权限（主数据须登录后访问）；如需 anon 只读另议。
