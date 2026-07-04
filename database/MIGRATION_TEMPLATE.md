# 数据库迁移文件标准模板

## 核心原则

**所有迁移文件必须幂等**：同一文件可多次执行不报错。

## 模板结构

```sql
-- NNN_table_name.sql
-- 简要说明（一行）
-- 幂等设计：列出幂等策略（DROP IF EXISTS / ON CONFLICT 等）

-- ===== 表操作 =====
-- 创建表（幂等）
CREATE TABLE IF NOT EXISTS table_name (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(500),              -- 字符串字段统一用大长度（避免反复修改）
    code VARCHAR(200),
    description TEXT,               -- 长文本用 TEXT
    status VARCHAR(50),             -- 状态/枚举用小长度
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ===== 触发器（幂等） =====
DROP TRIGGER IF EXISTS update_table_name_updated_at ON table_name;
CREATE TRIGGER update_table_name_updated_at
    BEFORE UPDATE ON table_name
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== 索引（幂等） =====
CREATE INDEX IF NOT EXISTS idx_table_name_code ON table_name(code);
CREATE INDEX IF NOT EXISTS idx_table_name_status ON table_name(status);

-- ===== 权限（幂等） =====
GRANT SELECT, INSERT, UPDATE ON table_name TO anon;
GRANT SELECT, INSERT, UPDATE ON table_name TO authenticated;

-- ===== RLS（幂等） =====
-- 开发阶段禁用，生产环境评估后开启
ALTER TABLE table_name DISABLE ROW LEVEL SECURITY;

-- ===== 初始数据（幂等） =====
INSERT INTO table_name (id, name, code) VALUES
    ('固定UUID'::uuid, '名称', 'CODE')
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    code = EXCLUDED.code;

COMMENT ON TABLE table_name IS '表说明';
```

## 字段长度标准

| 字段类型 | 推荐类型 | 说明 |
|---------|---------|-----|
| 编号/编码 | TEXT | 业务编码可能很长，VARCHAR 容易反复修改 |
| 名称 | TEXT | 商品名/部门名等可能超长 |
| 类别/分类 | TEXT | 层级分类路径可能很长 |
| 描述/备注 | TEXT | 长文本无长度限制 |
| 状态/类型 | VARCHAR(50) | 枚举值，短字符串，VARCHAR 足够 |
| 外部系统ID | TEXT | 外部系统ID格式不可控 |

**核心原则**：对于来自外部系统的数据，一律用 TEXT，不要用 VARCHAR。
VARCHAR 只用于自己控制的枚举字段（如 status）。

## 幂等策略清单

1. `CREATE TABLE IF NOT EXISTS` - 表创建
2. `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` - 触发器
3. `CREATE INDEX IF NOT EXISTS` - 索引
4. `GRANT ...` - 权限（GRANT 本身幂等）
5. `INSERT ... ON CONFLICT DO UPDATE` - 初始数据
6. `ALTER TABLE DISABLE ROW LEVEL SECURITY` - RLS（幂等）

## 常见错误

| 错误 | 正确做法 |
|-----|---------|
| `CREATE TRIGGER` 不带 DROP | 必须先 `DROP TRIGGER IF EXISTS` |
| `INSERT` 不带 ON CONFLICT | 必须加 `ON CONFLICT DO UPDATE` |
| VARCHAR(50) 不够 | 统一用 VARCHAR(200/500) |
| 缺少 COMMENT | 每个表必须有 COMMENT |