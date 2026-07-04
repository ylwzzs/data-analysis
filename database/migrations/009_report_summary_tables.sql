-- 009_report_summary_tables.sql
-- 标准报表汇总表（DuckDB /compute 结果写入）
-- 架构文档：docs/architecture.md - PostgreSQL 存储（热数据）

-- 每日门店销售汇总
CREATE TABLE IF NOT EXISTS report_daily_sales (
    biz_date DATE NOT NULL,
    branch_num VARCHAR(20) NOT NULL,
    branch_name VARCHAR(100),
    total_orders INTEGER DEFAULT 0,
    total_items INTEGER DEFAULT 0,
    total_sale DECIMAL(12,2) DEFAULT 0,
    total_profit DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (biz_date, branch_num)
);

COMMENT ON TABLE report_daily_sales IS '每日门店销售汇总（几万条明细 → 几百条汇总）';

-- 每日品类汇总
CREATE TABLE IF NOT EXISTS report_daily_category (
    biz_date DATE NOT NULL,
    branch_num VARCHAR(20) NOT NULL,
    category VARCHAR(50) NOT NULL,
    total_items INTEGER DEFAULT 0,
    total_sale DECIMAL(12,2) DEFAULT 0,
    total_profit DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (biz_date, branch_num, category)
);

COMMENT ON TABLE report_daily_category IS '每日门店品类汇总';

-- 周趋势汇总
CREATE TABLE IF NOT EXISTS report_weekly_trend (
    week_start DATE NOT NULL,
    branch_num VARCHAR(20) NOT NULL,
    branch_name VARCHAR(100),
    total_sale DECIMAL(12,2) DEFAULT 0,
    prev_week_sale DECIMAL(12,2) DEFAULT 0,
    growth_rate DECIMAL(5,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (week_start, branch_num)
);

COMMENT ON TABLE report_weekly_trend IS '周销售趋势汇总（环比增长）';

-- 权限：authenticated 可读写
GRANT SELECT, INSERT, UPDATE ON report_daily_sales, report_daily_category, report_weekly_trend TO authenticated;

-- anon 无权限（报表数据必须登录后才能看）
-- REVOKE 不需要，因为这些表是新创建的，默认只有 owner 有权限

-- 更新触发器（自动更新 updated_at）
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_report_daily_sales_updated_at
    BEFORE UPDATE ON report_daily_sales
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_report_daily_category_updated_at
    BEFORE UPDATE ON report_daily_category
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_report_weekly_trend_updated_at
    BEFORE UPDATE ON report_weekly_trend
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();