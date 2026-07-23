// health route 的纯函数：动态发现 audit 视图 + 计算 rollup 差异
// 抽出来便于单测（不依赖 PostgREST/网络）

// 从 PostgREST 根 OpenAPI 提取所有 report_*_v_audit 视图名
export function parseAuditViewNames(openapi: any): string[] {
  const fromDefs = openapi?.definitions ? Object.keys(openapi.definitions) : [];
  const fromPaths = openapi?.paths
    ? Object.keys(openapi.paths).map((p) => p.replace(/^\//, ''))
    : [];
  const names = new Set<string>([...fromDefs, ...fromPaths]);
  return [...names].filter((n) => /^report_.+_v_audit$/.test(n)).sort();
}

// 对一个 audit 视图的所有行：找 *_diff 列算 max(|值|)，*_total 列求和
export function computeAuditStats(rows: any[]): {
  diffColumns: { name: string; maxValue: number }[];
  status: 'ok' | 'warn';
  totals: Record<string, number>;
} {
  if (!rows.length) return { diffColumns: [], status: 'ok', totals: {} };
  const allKeys = Object.keys(rows[0]);
  const diffKeys = allKeys.filter((k) => k.endsWith('_diff'));
  const totalKeys = allKeys.filter((k) => k.endsWith('_total'));
  const diffColumns = diffKeys.map((name) => ({
    name,
    maxValue: Math.max(...rows.map((r) => Math.abs(Number(r[name]) || 0))),
  }));
  const totals: Record<string, number> = {};
  for (const tk of totalKeys) totals[tk] = rows.reduce((s, r) => s + (Number(r[tk]) || 0), 0);
  const status = diffColumns.every((d) => d.maxValue < 0.01) ? 'ok' : 'warn';
  return { diffColumns, status, totals };
}
