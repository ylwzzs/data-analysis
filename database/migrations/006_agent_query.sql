-- 006_agent_query.sql
-- Agent 个性化查询相关表结构
-- 幂等设计,可重复执行

-- ============================================
-- 1. 扩展 org_users 表:添加企微 ID 映射
-- ============================================
ALTER TABLE org_users
ADD COLUMN IF NOT EXISTS wecom_id VARCHAR(50) UNIQUE;

-- 创建索引加速查询
CREATE INDEX IF NOT EXISTS idx_org_users_wecom_id ON org_users(wecom_id);

COMMENT ON COLUMN org_users.wecom_id IS '企业微信用户ID';

-- ============================================
-- 2. 扩展 org_departments 表:添加权限配置
-- ============================================
ALTER TABLE org_departments
ADD COLUMN IF NOT EXISTS allowed_regions JSONB DEFAULT '["*"]'::jsonb;

ALTER TABLE org_departments
ADD COLUMN IF NOT EXISTS data_scope JSONB DEFAULT '{"max_history_days": 90, "max_rows": 1000}'::jsonb;

COMMENT ON COLUMN org_departments.allowed_regions IS '允许查看的地区列表,["*"]表示全部';
COMMENT ON COLUMN org_departments.data_scope IS '数据范围限制:max_history_days(最大历史天数)、max_rows(最大返回行数)';

-- ============================================
-- 3. 创建审计日志表
-- ============================================
CREATE TABLE IF NOT EXISTS agent_query_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  user_name VARCHAR(100),
  query_text TEXT NOT NULL,
  generated_sql TEXT,
  final_sql TEXT,
  data_source VARCHAR(20),  -- 'hot'/'warm'/'cold'
  rows_returned INT,
  execution_time_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_agent_logs_user ON agent_query_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_time ON agent_query_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_logs_rows ON agent_query_logs(rows_returned) WHERE rows_returned > 1000;

COMMENT ON TABLE agent_query_logs IS 'Agent 查询审计日志';

-- ============================================
-- 4. 创建数据源元数据表
-- ============================================
CREATE TABLE IF NOT EXISTS data_sources_meta (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  table_name VARCHAR(100) NOT NULL,
  s3_path VARCHAR(500),
  columns JSONB NOT NULL,
  is_hot BOOLEAN DEFAULT FALSE,
  hot_table_name VARCHAR(100),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_data_sources_table ON data_sources_meta(table_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_data_sources_name ON data_sources_meta(name);

COMMENT ON TABLE data_sources_meta IS '数据源元数据:表结构、存储位置等';

-- ============================================
-- 5. 触发器:自动更新 updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_data_sources_meta_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_data_sources_meta_updated_at ON data_sources_meta;
CREATE TRIGGER update_data_sources_meta_updated_at
  BEFORE UPDATE ON data_sources_meta
  FOR EACH ROW
  EXECUTE FUNCTION update_data_sources_meta_updated_at();

-- ============================================
-- 6. 示例数据:销售明细表元数据
-- ============================================
INSERT INTO data_sources_meta (name, table_name, s3_path, columns, is_hot, hot_table_name, description)
VALUES (
  '销售明细',
  'sales',
  's3://data/sales/*.parquet',
  '[
    {"name": "id", "type": "uuid", "description": "订单ID"},
    {"name": "date", "type": "date", "description": "销售日期"},
    {"name": "region", "type": "varchar", "description": "销售地区"},
    {"name": "product", "type": "varchar", "description": "产品名称"},
    {"name": "amount", "type": "decimal", "description": "销售金额"},
    {"name": "quantity", "type": "int", "description": "销售数量"}
  ]'::jsonb,
  true,
  'sales_hot',
  '销售订单明细数据,包含订单ID、日期、地区、产品、金额、数量'
)
ON CONFLICT (name) DO UPDATE
SET
  columns = EXCLUDED.columns,
  updated_at = NOW();

-- ============================================
-- 7. 权限授予
-- ============================================
GRANT SELECT, INSERT ON agent_query_logs TO anon, authenticated;
GRANT SELECT ON data_sources_meta TO anon, authenticated;

-- ============================================
-- 完成
-- ============================================
-- 迁移完成提示
DO $$
BEGIN
  RAISE NOTICE 'Migration 006_agent_query completed successfully';
END $$;
