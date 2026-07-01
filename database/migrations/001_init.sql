-- database/migrations/001_init.sql
-- 数据分析平台数据库初始化
-- 由 scripts/migrate.sh 幂等执行：表/扩展/索引均带 IF NOT EXISTS，触发器先 DROP 再 CREATE。

-- 启用扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 数据源配置表
CREATE TABLE IF NOT EXISTS data_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  api_endpoint VARCHAR(500),
  auth_type VARCHAR(50) DEFAULT 'none',
  auth_config JSONB,
  schedule VARCHAR(100),
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 数据文件记录表
CREATE TABLE IF NOT EXISTS data_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES data_sources(id),
  storage_path VARCHAR(500) NOT NULL,
  file_format VARCHAR(20) DEFAULT 'parquet',
  row_count INT,
  size_bytes BIGINT,
  schema_json JSONB,
  ingested_at TIMESTAMP DEFAULT NOW()
);

-- 报表配置表
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  query_template TEXT,
  chart_config JSONB,
  metrics JSONB,
  schedule VARCHAR(100),
  recipients JSONB,
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 组织架构同步表（从企业微信同步）
CREATE TABLE IF NOT EXISTS org_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wecom_id VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(100),
  avatar VARCHAR(500),
  department_ids JSONB,
  position VARCHAR(100),
  mobile VARCHAR(50),
  email VARCHAR(100),
  synced_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org_departments (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(100),
  parent_id VARCHAR(100),
  path VARCHAR(500),
  order_weight INT DEFAULT 0,
  synced_at TIMESTAMP DEFAULT NOW()
);

-- 数据权限配置表
CREATE TABLE IF NOT EXISTS data_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,
  department_id VARCHAR(100),
  user_id UUID,
  permission_level VARCHAR(20) DEFAULT 'read',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 查询日志表（审计用）
CREATE TABLE IF NOT EXISTS query_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,
  query_type VARCHAR(50),
  query_content TEXT,
  resource_id UUID,
  executed_at TIMESTAMP DEFAULT NOW(),
  duration_ms INT,
  status VARCHAR(20) DEFAULT 'success',
  error_message TEXT
);

-- 创建索引（IF NOT EXISTS 保证可重复执行）
CREATE INDEX IF NOT EXISTS idx_data_files_source ON data_files(source_id);
CREATE INDEX IF NOT EXISTS idx_data_files_ingested ON data_files(ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_logs_user ON query_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_query_logs_time ON query_logs(executed_at DESC);

-- 创建更新时间触发器（PostgreSQL 的 CREATE TRIGGER 不支持 IF NOT EXISTS，先 DROP 再 CREATE）
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_data_sources_updated_at ON data_sources;
CREATE TRIGGER update_data_sources_updated_at
  BEFORE UPDATE ON data_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_reports_updated_at ON reports;
CREATE TRIGGER update_reports_updated_at
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
