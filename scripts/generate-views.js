#!/usr/bin/env node
/**
 * 语义层视图生成器
 * 读 view-manifest.json + PG(metric_registry/metric_sources/dimension_levels/dimensions)
 * 产出下钻视图迁移（多层 UNION ALL）+ audit 视图（rollup 自校验）
 *
 * A2 限制：只支持单源视图（所有 base 指标来自同一 source_table）
 *
 * 用法：DATABASE_URL=postgresql://postgres:postgres@localhost:5432/insforge node scripts/generate-views.js
 */
const fs = require("fs");
const path = require("path");
const { Client } = require(path.join(__dirname, "..", "services", "node_modules", "pg"));

const MANIFEST_PATH = path.join(__dirname, "view-manifest.json");
const MIGRATIONS_DIR = path.join(__dirname, "..", "database", "migrations");

function nextMigrationNum() {
  const nums = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .map((f) => parseInt(f.slice(0, 3), 10));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

async function readModel(client) {
  const [metrics, sources, levels, dims] = await Promise.all([
    client.query(
      "SELECT metric_code, measure_type, formula, depends_on, additive, cost_sensitive FROM metric_registry WHERE enabled"
    ),
    client.query("SELECT metric_code, source_table, source_column, source_filter FROM metric_sources"),
    client.query(
      "SELECT dim_code, level_code, depth, key_column, name_column, parent_level FROM dimension_levels ORDER BY dim_code, depth"
    ),
    client.query("SELECT dim_code, join_table, join_key, is_assessed_filter FROM dimensions WHERE enabled"),
  ]);
  return { metrics: metrics.rows, sources: sources.rows, levels: levels.rows, dims: dims.rows };
}

// pg JSONB 通常直接返回 JS 数组；兼容历史字串
function normDeps(d) {
  if (Array.isArray(d)) return d;
  if (typeof d === "string") {
    try {
      return JSON.parse(d);
    } catch {
      return [];
    }
  }
  return [];
}

// 校验：所有 base 指标必须同源（A2 单源限制）
function validateView(view, model) {
  const baseMetrics = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "base");
  if (baseMetrics.length === 0) throw new Error(`视图 ${view.name}: 无 base 指标，无法定位 source_table`);
  const tables = [...new Set(
    baseMetrics.map((m) => {
      const s = model.sources.find((x) => x.metric_code === m.metric_code);
      if (!s) throw new Error(`指标 ${m.metric_code} 无 metric_sources 映射`);
      return s.source_table;
    })
  )];
  if (tables.length > 1)
    throw new Error(`视图 ${view.name}: 多源（${tables.join(",")}）A2 暂不支持，需单源`);
  return { sourceTable: tables[0], baseMetrics };
}

// 生成单层 UNION 分支
function genLevelBranch(view, level, parentLevel, baseMetrics, model, dim, sourceTable) {
  const src = (code) => model.sources.find((s) => s.metric_code === code);
  const cols = [];
  cols.push(`'${level.level_code}' AS level`);
  cols.push(parentLevel ? `dim.${parentLevel.key_column} AS parent_code` : `NULL::text AS parent_code`);
  if (view.target_scoped) cols.push("t.id AS target_id");
  cols.push(`dim.${level.key_column} AS code`);
  cols.push(`dim.${level.name_column} AS name`);

  // 1) base 可加指标：直接 SUM 源列
  for (const m of baseMetrics) {
    cols.push(`SUM(s.${src(m.metric_code).source_column}) AS ${m.metric_code}`);
  }

  // 2) derived 非可加比率（如 margin=profit/amount）：不可直接 SUM，须按 metric_registry.depends_on 重算
  //    按 view 的单一 sourceTable 定位列（view-scoped，避免 delivery 视图误取 sale 列）
  const derivedRatios = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "derived" && !m.additive);
  for (const dm of derivedRatios) {
    const deps = normDeps(dm.depends_on);
    if (deps.length !== 2) {
      throw new Error(`视图 ${view.name}: derived 指标 ${dm.metric_code} depends_on=[${deps.join(",")}]，生成器当前仅支持二元比率（须恰好 2 依赖）`);
    }
    // 依赖须是本视图已声明的 base 指标（保证口径一致且不静默丢弃）
    for (const d of deps) {
      if (!baseMetrics.some((b) => b.metric_code === d)) {
        throw new Error(`视图 ${view.name}: derived 指标 ${dm.metric_code} 的依赖 ${d} 未在视图 metrics 中声明为 base 指标`);
      }
    }
    const [numCode, denCode] = deps;
    const numSrc = model.sources.find((s) => s.metric_code === numCode && s.source_table === sourceTable);
    const denSrc = model.sources.find((s) => s.metric_code === denCode && s.source_table === sourceTable);
    if (!numSrc || !denSrc) {
      throw new Error(`视图 ${view.name}: derived 指标 ${dm.metric_code} 依赖 (${deps.join(",")}) 在源表 ${sourceTable} 未全部映射，无法重算`);
    }
    cols.push(`SUM(s.${numSrc.source_column}) / NULLIF(SUM(s.${denSrc.source_column}), 0) AS ${dm.metric_code}`);
  }

  // 3) 兜底：声明的 derived 可加指标（如 outbound_*）跨多源，A2 单源生成器暂不支持 → 显式报错，不静默丢弃
  const unresolved = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "derived" && m.additive);
  if (unresolved.length) {
    throw new Error(`视图 ${view.name}: derived 可加指标 [${unresolved.map((u) => u.metric_code).join(",")}] 跨多源，A2 单源生成器暂不支持`);
  }

  const sourceFilter = baseMetrics[0] && src(baseMetrics[0].metric_code).source_filter;
  let from = `FROM ${src(baseMetrics[0].metric_code).source_table} s`;
  from += `\n  JOIN ${dim.join_table} dim ON s.branch_num = dim.${dim.join_key} AND s.system_book_code = dim.system_book_code`;
  const where = [];
  if (view.target_scoped) {
    from += `\n  JOIN targets t ON s.system_book_code = t.system_book_code\n    AND s.biz_date BETWEEN t.start_date AND t.end_date`;
    where.push("t.status = 'active'");
  }
  if (sourceFilter) where.push(sourceFilter);
  if (view.assessed_filter) where.push("is_assessed_war_zone(dim.first_level_region)");

  const groupCols = [];
  if (view.target_scoped) groupCols.push("t.id");
  if (parentLevel) groupCols.push(`dim.${parentLevel.key_column}`);
  groupCols.push(`dim.${level.key_column}`);
  groupCols.push(`dim.${level.name_column}`);

  return `  SELECT\n    ${cols.join(",\n    ")}\n  ${from}\n  ${where.length ? "WHERE " + where.join(" AND ") : ""}\n  GROUP BY ${groupCols.join(", ")}`;
}

// 生成 audit 视图（各层加总一致性）
function genAuditSql(viewName, view, levels) {
  const auditName = viewName + "_audit";
  const codes = levels.map((l) => l.level_code);
  const metric = view.metrics[0];
  const tgt = view.target_scoped;

  // 关键：pivot 与 diff 须分层。PG SELECT 别名对同级表达式不可见（仅 ORDER BY 可见），
  // 故把 pivot 放进子查询 z，diff 在外层 SELECT 引用 z 的输出列。
  const pivots = codes.map((c) => `MAX(CASE WHEN level='${c}' THEN m END) AS ${c}_total`).join(",\n        ");
  const diffs = [];
  for (let i = 1; i < codes.length; i++) {
    diffs.push(`ABS(${codes[0]}_total - ${codes[i]}_total) AS ${codes[0]}_vs_${codes[i]}_diff`);
  }

  const outCols = [];
  if (tgt) outCols.push("target_id");
  for (const c of codes) outCols.push(`${c}_total`);
  outCols.push(...diffs);

  return `DROP VIEW IF EXISTS ${auditName};
CREATE VIEW ${auditName} AS
  SELECT
    ${outCols.join(",\n    ")}
  FROM (
    SELECT${tgt ? "\n      target_id," : ""}
        ${pivots}
    FROM (
      SELECT${tgt ? " target_id," : ""} level, SUM(${metric}) AS m
      FROM ${viewName}
      GROUP BY ${tgt ? "target_id, " : ""}level
    ) y
    GROUP BY${tgt ? " target_id" : ""}
  ) z;
ALTER VIEW ${auditName} SET (security_invoker = true);
GRANT SELECT ON ${auditName} TO authenticated, anon;`;
}

function genViewSql(view, model) {
  const dim = model.dims.find((d) => d.dim_code === view.dimension);
  if (!dim) throw new Error(`维度 ${view.dimension} 未注册`);
  const { sourceTable, baseMetrics } = validateView(view, model);
  const levels = model.levels
    .filter((l) => l.dim_code === view.dimension && view.levels.includes(l.level_code))
    .sort((a, b) => a.depth - b.depth);
  if (levels.length === 0) throw new Error(`维度 ${view.dimension} 无匹配层级 ${view.levels}`);

  const branches = levels.map((lvl) => {
    const parent = lvl.parent_level ? levels.find((l) => l.level_code === lvl.parent_level) : null;
    return genLevelBranch(view, lvl, parent, baseMetrics, model, dim, sourceTable);
  });

  const viewName = `report_${view.name}_v`;
  let sql = `-- AUTO-GENERATED by scripts/generate-views.js（勿手改；改 view-manifest.json 后重生成）\n-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW；部署后重启 postgrest\n\n`;
  sql += `DROP VIEW IF EXISTS ${viewName};\nCREATE VIEW ${viewName} AS\n${branches.join("\nUNION ALL\n")};\n`;
  sql += `ALTER VIEW ${viewName} OWNER TO postgres;\nALTER VIEW ${viewName} SET (security_invoker = true);\nGRANT SELECT ON ${viewName} TO authenticated, anon;\n`;
  if (view.audit) sql += "\n" + genAuditSql(viewName, view, levels) + "\n";
  return sql;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const conn = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/insforge";
  const client = new Client({ connectionString: conn });
  await client.connect();
  const model = await readModel(client);
  await client.end();

  let num = nextMigrationNum();
  for (const view of manifest.views) {
    const sql = genViewSql(view, model);
    const fname = `${String(num).padStart(3, "0")}_generated_${view.name}.sql`;
    fs.writeFileSync(path.join(MIGRATIONS_DIR, fname), sql);
    console.log(`✓ generated database/migrations/${fname}`);
    num++;
  }
}

main().catch((e) => {
  console.error("生成失败:", e.message);
  process.exit(1);
});
