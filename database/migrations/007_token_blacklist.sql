-- database/migrations/007_token_blacklist.sql
-- JWT 黑名单表：存储已吊销的 token
-- 用于用户退出登录或账号异常时立即失效 token
-- 幂等：可重复执行

CREATE TABLE IF NOT EXISTS token_blacklist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_hash VARCHAR(64) NOT NULL,  -- SHA256 前 16 位或完整 hash
  jti VARCHAR(64),                  -- JWT ID（如果有）
  user_id VARCHAR(100),             -- 关联用户（可选，用于审计）
  expires_at TIMESTAMP NOT NULL,    -- token 原始过期时间
  blacklisted_at TIMESTAMP DEFAULT NOW(),
  reason VARCHAR(50) DEFAULT 'logout'  -- logout | revoked | expired
);

-- 索引：快速检查 token 是否在黑名单中
CREATE INDEX IF NOT EXISTS idx_token_blacklist_hash ON token_blacklist(token_hash);
CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires ON token_blacklist(expires_at);

-- 授权 authenticated role 读写
GRANT SELECT, INSERT, DELETE ON token_blacklist TO authenticated;

COMMENT ON TABLE token_blacklist IS 'JWT 黑名单，middleware 检查 token 是否被吊销';