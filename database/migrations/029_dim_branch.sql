-- 029_dim_branch.sql
-- 门店主数据 dim_branch + 门店扩展 dim_branch_ext + 统一战区维表 dim_region + branch_full 视图
-- 依据实测：branch.page API；branch_num=API system_id(=明细 branch_num)；战区=区域名顶层前缀，两品牌共享同一套。
-- 幂等：IF NOT EXISTS / OR REPLACE / DROP+CREATE 视图（migrate 每次重跑全部迁移）。

-- ===== 门店主数据（采集覆盖 base + is_active 软删除）=====
CREATE TABLE IF NOT EXISTS dim_branch (
    system_book_code TEXT NOT NULL,
    branch_num       TEXT NOT NULL,           -- API system_id（= 明细 branch_num，JOIN 键）
    branch_id        TEXT,                    -- API id（系统大号）
    branch_code      TEXT,
    branch_name      TEXT,
    region_name      TEXT,                    -- branch_region.name（如"东部二区"）
    branch_groups    TEXT,                    -- 多级标签（如"东部二区,云南,所有门店"）
    province         TEXT,
    city             TEXT,
    district         TEXT,
    address          TEXT,
    phone            TEXT,
    longitude        TEXT,
    latitude         TEXT,
    enable           BOOLEAN,                 -- 乐檬启停
    deleted          BOOLEAN,
    expire_time      TEXT,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,   -- 软删除：本次采集未见到→false
    raw              JSONB,
    updated_at       TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (system_book_code, branch_num)
);
CREATE INDEX IF NOT EXISTS idx_dim_branch_region ON dim_branch(region_name);
DROP TRIGGER IF EXISTS update_dim_branch_updated_at ON dim_branch;
CREATE TRIGGER update_dim_branch_updated_at
    BEFORE UPDATE ON dim_branch FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
COMMENT ON TABLE dim_branch IS '门店主数据（采集覆盖 base；PK 品牌隔离；is_active 软删除）';

-- ===== 门店扩展（人工维护，采集永不碰）=====
CREATE TABLE IF NOT EXISTS dim_branch_ext (
    system_book_code TEXT NOT NULL,
    branch_num       TEXT NOT NULL,
    custom_group     TEXT,
    note             TEXT,
    updated_at       TIMESTAMP DEFAULT NOW(),
    updated_by       TEXT,
    PRIMARY KEY (system_book_code, branch_num),
    FOREIGN KEY (system_book_code, branch_num) REFERENCES dim_branch(system_book_code, branch_num) ON DELETE CASCADE
);
COMMENT ON TABLE dim_branch_ext IS '门店扩展（人工二次维护，采集绝不写入；单店级特例）';

-- ===== 战区自动派生函数（region_name 前缀 → war_zone）=====
CREATE OR REPLACE FUNCTION derive_war_zone(region_name TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF region_name IS NULL THEN RETURN NULL;
  ELSIF region_name LIKE '东部%' THEN RETURN '东部';
  ELSIF region_name LIKE '中部%' THEN RETURN '中部';
  ELSIF region_name LIKE '南部%' THEN RETURN '南部';
  ELSIF region_name LIKE '西部%' THEN RETURN '西部';
  ELSIF region_name LIKE '%大区' THEN RETURN region_name;       -- 广西大区/贵州宣威大区 各成一战区
  ELSIF region_name IN ('其余门店1','其他门店','所有区域') THEN RETURN '未分配';
  ELSE RETURN '未分配';
  END IF;
END; $$;

-- ===== 统一战区维表（品牌无关；war_zone 空 → branch_full 走 derive_war_zone 自动派生）=====
CREATE TABLE IF NOT EXISTS dim_region (
    region_name  TEXT PRIMARY KEY,            -- 两品牌共享标签（如"东部三区"）
    war_zone     TEXT,                         -- 空→自动派生；填了即覆盖（统一管理改这里）
    sub_region   TEXT,
    display_name TEXT,
    updated_at   TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE dim_region IS '统一战区维表（品牌无关，PK region_name；war_zone 可空走自动派生，填则覆盖）';

-- seed 已知区域名（war_zone 留空→自动；要改某区域战区 UPDATE dim_region SET war_zone=...）
INSERT INTO dim_region (region_name) VALUES
  ('东部一区'),('东部二区'),('东部三区'),('东部四区'),
  ('中部一区'),('中部二区'),('中部三区'),
  ('南部一区'),('南部二区'),('南部三区'),('南部四区'),('南部五区'),
  ('西部一区'),('西部二区'),
  ('广西大区'),('贵州宣威大区'),
  ('其余门店1'),('其他门店'),('所有区域')
ON CONFLICT (region_name) DO NOTHING;

-- ===== branch_full 视图：门店 + 战区（dim_region.war_zone 优先，否则 derive_war_zone）=====
DROP VIEW IF EXISTS branch_full;
CREATE VIEW branch_full AS
SELECT b.system_book_code, b.branch_num, b.branch_id, b.branch_code, b.branch_name,
       b.region_name, b.branch_groups, b.province, b.city, b.district, b.address, b.phone,
       b.enable, b.deleted, b.expire_time, b.is_active,
       COALESCE(r.war_zone, derive_war_zone(b.region_name)) AS war_zone,
       r.sub_region
FROM dim_branch b
LEFT JOIN dim_region r ON r.region_name = b.region_name;
COMMENT ON VIEW branch_full IS '门店+战区视图（war_zone：dim_region 优先，否则按 region_name 前缀派生）';

-- ===== 权限 =====
GRANT SELECT ON dim_branch, branch_full, dim_region TO authenticated;
GRANT SELECT ON dim_branch, branch_full TO anon;
GRANT SELECT, INSERT, UPDATE ON dim_branch_ext, dim_region TO authenticated;
