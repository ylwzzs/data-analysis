-- 082_dim_customer.sql
-- 批发客户维度（从 wholesale_detail parquet 派生物化，仿 dim_branch 029）
-- base 派生覆盖 + ext 人工维护(FK CASCADE) + is_active 软删除 + customer_full 视图
-- 注册 datasets(kind=dim,carry_enabled) → carry-dims 自动 COPY parquet
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT + DROP/CREATE VIEW；部署后重启 postgrest

CREATE TABLE IF NOT EXISTS dim_customer (
    system_book_code  TEXT NOT NULL,
    client_code       TEXT NOT NULL,          -- 批发客户号（品牌内编号）
    client_name       TEXT,                    -- 最近客户名（派生 arg_max by audit_time）
    first_order_date   DATE,                   -- 首单
    last_order_date    DATE,                   -- 末单（活跃/流失判断）
    active_days        INT,                    -- 活跃天数
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,  -- 软删除：派生未见→false
    raw                JSONB,
    updated_at         TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (system_book_code, client_code)
);
COMMENT ON TABLE dim_customer IS '批发客户维度（wholesale_detail 派生；PK 品牌隔离；is_active 软删除）';

CREATE TABLE IF NOT EXISTS dim_customer_ext (
    system_book_code  TEXT NOT NULL,
    client_code       TEXT NOT NULL,
    custom_group      TEXT,                    -- 客户分组（人工）
    note              TEXT,                    -- 备注（人工）
    updated_at        TIMESTAMP DEFAULT NOW(),
    updated_by        TEXT,
    PRIMARY KEY (system_book_code, client_code),
    FOREIGN KEY (system_book_code, client_code)
      REFERENCES dim_customer(system_book_code, client_code) ON DELETE CASCADE
);
COMMENT ON TABLE dim_customer_ext IS '批发客户扩展（人工维护，派生绝不写；软删除 is_active=false 不触发 CASCADE，ext 保留）';

DROP VIEW IF EXISTS customer_full;
CREATE VIEW customer_full AS
SELECT c.system_book_code, c.client_code, c.client_name,
       c.first_order_date, c.last_order_date, c.active_days, c.is_active,
       e.custom_group, e.note
FROM dim_customer c
LEFT JOIN dim_customer_ext e
  ON c.system_book_code = e.system_book_code AND c.client_code = e.client_code;
ALTER VIEW customer_full SET (security_invoker = true);
COMMENT ON VIEW customer_full IS '客户+扩展视图（base JOIN ext）';

-- datasets 注册（carry-dims 读 kind=dim AND carry_enabled=true 自动 COPY parquet）
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, carry_enabled, exposed, description) VALUES
 ('dim_customer','批发客户维度(派生)','pg_table','dim_customer','dim',FALSE,FALSE,NULL,TRUE,FALSE,
  '批发客户维度（从 wholesale_detail 派生；carry-dims 自动 COPY 到 s3://dims/dim_customer.parquet）')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, carry_enabled=EXCLUDED.carry_enabled,
  exposed=EXCLUDED.exposed, description=EXCLUDED.description;

GRANT SELECT ON dim_customer, customer_full TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON dim_customer_ext TO authenticated;

DO $$ BEGIN RAISE NOTICE 'Migration 082_dim_customer completed'; END $$;
