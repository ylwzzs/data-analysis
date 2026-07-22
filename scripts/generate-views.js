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
function genLevelBranch(view, level, parentLevel, baseMetrics, model, dim) {
  const src = (code) => model.sources.find((s) => s.metric_code === code);
  const cols = [];
  cols.push(`'${level.level_code}' AS level`);
  cols.push(parentLevel ? `dim.${parentLevel.key_column} AS parent_code` : `NULL::text AS parent_code`);
  if (view.target_scoped) cols.push("t.id AS target_id");
  cols.push(`dim.${level.key_column} AS code`);
  cols.push(`dim.${level.name_column} AS name`);

  for (const m of baseMetrics) {
    cols.push(`SUM(s.${src(m.metric_code).source_column}) AS ${m.metric_code}`);
  }

  // 同源 derived 比率：margin = profit/amount（重算，不直接 SUM）
  const profitSrc = src("sale_profit") || src("delivery_profit") || src("wholesale_profit");
  const amountSrc = src("sale_amount") || src("delivery_amount") || src("wholesale_amount");
  if (view.metrics.includes("margin") && profitSrc && amountSrc) {
    cols.push(`SUM(s.${profitSrc.source_column}) / NULLIF(SUM(s.${amountSrc.source_column}), 0) AS margin`);
  }

  const sourceFilter = baseMetrics[0] && src(baseMetrics[0].metric_code).source_filter;
  let from = `FROM ${src(baseMetrics[0].metric_code).source_table} s`;
  from += `\n  JOIN ${dim.join_table} dim ON s.branch_num = dim.${dim.join_key}`;
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
  const pivots = codes.map((c) => `MAX(CASE WHEN level='${c}' THEN ${metric} END) AS ${c}_total`).join(",\n      ");
  const diffs = [];
  for (let i = 1; i < codes.length; i++) {
    diffs.push(`ABS(${codes[0]}_total - ${codes[i]}_total) AS ${codes[0]}_vs_${codes[i]}_diff`);
  }
  const tgt = view.target_scoped;
  return `DROP VIEW IF EXISTS ${auditName};
CREATE VIEW ${auditName} AS
  SELECT${tgt ? " target_id," : ""}
      ${pivots}${diffs.length ? ",\n      " + diffs.join(",\n      ") : ""}
  FROM (
    SELECT${tgt ? " target_id," : ""} level, SUM(${metric}) AS ${metric}
    FROM ${viewName}
    GROUP BY ${tgt ? "target_id, " : ""}level
  ) x${tgt ? " GROUP BY target_id" : ""};
ALTER VIEW ${auditName} SET (security_invoker = true);
GRANT SELECT ON ${auditName} TO authenticated, anon;`;
}

function genViewSql(view, model) {
  const dim = model.dims.find((d) => d.dim_code === view.dimension);
  if (!dim) throw new Error(`维度 ${view.dimension} 未注册`);
  const { baseMetrics } = validateView(view, model);
  const levels = model.levels
    .filter((l) => l.dim_code === view.dimension && view.levels.includes(l.level_code))
    .sort((a, b) => a.depth - b.depth);
  if (levels.length === 0) throw new Error(`维度 ${view.dimension} 无匹配层级 ${view.levels}`);

  const branches = levels.map((lvl) => {
    const parent = lvl.parent_level ? levels.find((l) => l.level_code === lvl.parent_level) : null;
    return genLevelBranch(view, lvl, parent, baseMetrics, model, dim);
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
