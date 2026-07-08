-- 修复种子规则重复：020/022 早期用 INSERT ON CONFLICT DO NOTHING 但无自然键唯一约束，
-- migrate.sh 每次部署重跑全部迁移 → 每次部署重复插入（service_down 已 ×3）。
-- 这里去重 + 加唯一索引，让后续 020/022 的 ON CONFLICT DO NOTHING 真正命中唯一索引而跳过。
BEGIN;

-- 去重：每个 (check_type, target) 非空组合只保留最小 id 的一行
DELETE FROM monitor_rules a
USING monitor_rules b
WHERE a.check_type = b.check_type
  AND a.target IS NOT NULL
  AND a.target = b.target
  AND a.id > b.id;

-- 删除空 target 的 token_expire 模板残留（已被 022 的真实规则取代，且 NULL 不受唯一索引约束）
DELETE FROM monitor_rules WHERE check_type = 'token_expire' AND target IS NULL;

-- 唯一索引：同 check_type + target 不可重复（target 非空时）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_monitor_rules_type_target
  ON monitor_rules(check_type, target) WHERE target IS NOT NULL;

COMMIT;
