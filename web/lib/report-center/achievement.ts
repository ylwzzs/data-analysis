// web/lib/report-center/achievement.ts
// breakdown(门店/品类排行+交叉表) + 趋势(按日累计)。考核口径: actual 只算 4 大战区门店。
import { getClient } from "@/lib/api";
import { METRICS, MetricCode } from "./metric-source";

export interface BreakdownRow {
  target_id: number; branch_num: string; branch_name: string; war_zone: string;
  category: string | null; metric_code: MetricCode;
  target_value: number; actual_value: number | null;
  achievement_rate: number | null; progress_rate: number | null;
}

// 参与考核的 4 大战区(first_level_region); 与 DB 的 is_assessed_war_zone() 白名单保持一致
const ASSESSED_WAR_ZONES = ["东部战区", "南部战区", "西部战区", "中部战区"];
let _assessedNumsCache: string[] | null = null;

// 4 战区门店 branch_num 集合(进程级缓存; 战区范围不随运行时变)
async function getAssessedBranchNums(client: any): Promise<string[]> {
  const cached = _assessedNumsCache;
  if (cached) return cached;
  const { data, error } = await client.database.from("dim_branch")
    .select("branch_num").eq("is_active", true).in("first_level_region", ASSESSED_WAR_ZONES);
  if (error) throw error;
  const nums = (data ?? []).map((d: any) => d.branch_num);
  _assessedNumsCache = nums;
  return nums;
}

// breakdown 行：store→门店 / hq→品类。用于排行+交叉表。走 report_achievement_v(视图已过滤 4 战区)。
export async function getBreakdown(targetId: number, targetType: "store"|"hq"): Promise<BreakdownRow[]> {
  const client = await getClient();
  const { data, error } = await client.database.from("report_achievement_v")
    .select("target_id,branch_num,branch_name,war_zone,category,metric_code,target_value,actual_value,achievement_rate,progress_rate")
    .eq("parent_target_id", targetId).eq("target_level","breakdown").eq("target_type", targetType);
  if (error) throw error;
  return (data ?? []) as BreakdownRow[];
}

export interface TrendPoint { date: string; cum_actual: number; target_line: number; progress_line: number; }

// 趋势：按日累计 actual vs 目标线(匀) vs 进度线(匀)。按 metric 选表，outbound 双查合并。actual 只算 4 战区门店。
export async function getTrend(target: {
  system_book_code: string; branch_num: string; category: string | null;
  start_date: string; end_date: string; target_value: number; metric_code: MetricCode;
}): Promise<TrendPoint[]> {
  const meta = METRICS[target.metric_code];
  const client = await getClient();
  const assessedNums = await getAssessedBranchNums(client);
  // 主表按日聚合；outbound 双查并行（main+sec 合并）
  const [main, sec] = meta.secondaryTable && meta.secondaryValueCol
    ? await Promise.all([
        fetchDailySum(client, meta.trendTable, meta.trendValueCol, target, meta.categoryIn, assessedNums),
        fetchDailySum(client, meta.secondaryTable, meta.secondaryValueCol, target, meta.categoryIn, assessedNums),
      ])
    : [await fetchDailySum(client, meta.trendTable, meta.trendValueCol, target, meta.categoryIn, assessedNums), []];
  let merged = main;
  if (sec.length) {
    // 按日期合并（FULL JOIN 语义）
    const byDate = new Map<string, number>();
    for (const d of main) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.value);
    for (const d of sec) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.value);
    merged = [...byDate.entries()].map(([date,value]) => ({date,value}));
  }
  return toTrendPoints(merged, target);
}

// 内部：单表按日聚合，限定 4 战区门店(branch_num 集合)。system_book_code='ALL' 时不加该过滤(靠 branch 过滤覆盖两品牌)。
async function fetchDailySum(client: any, table: string, col: string, t: any, categoryIn: string[] | undefined, assessedNums: string[]) {
  let q = client.database.from(table).select(`biz_date,${col}`)
    .in("branch_num", assessedNums)
    .gte("biz_date", t.start_date).lte("biz_date", t.end_date);
  if (t.system_book_code && t.system_book_code !== "ALL") q = q.eq("system_book_code", t.system_book_code);
  if (t.branch_num && t.branch_num !== "ALL") q = q.eq("branch_num", t.branch_num);
  if (categoryIn && categoryIn.length) q = q.in("category_group", categoryIn);
  // report_daily_sales 无 category_group 列，categoryIn 为 undefined 时不加该过滤（sale 全品类）
  const { data, error } = await q;
  if (error) throw error;
  // 按日求和（同日多行合并）
  const byDate = new Map<string, number>();
  for (const r of data ?? []) byDate.set(r.biz_date, (byDate.get(r.biz_date) ?? 0) + Number(r[col] ?? 0));
  return [...byDate.entries()].map(([date,value]) => ({date, value}));
}

// 内部：日累计 + 目标线 + 进度线
function toTrendPoints(daily: {date:string,value:number}[], t: {start_date:string;end_date:string;target_value:number}): TrendPoint[] {
  const sorted = daily.filter(d => d.date >= t.start_date && d.date <= t.end_date).sort((a,b)=>a.date<b.date?-1:1);
  const days = Math.max(1, Math.round((+new Date(t.end_date) - +new Date(t.start_date))/86400000) + 1);
  const dailyTarget = t.target_value / days;
  let cum = 0;
  return sorted.map((d, i) => {
    cum += d.value;
    const dayIdx = i + 1;
    return {
      date: d.date,
      cum_actual: Math.round(cum),
      target_line: Math.round(dailyTarget * dayIdx),
      progress_line: Math.round(dailyTarget * dayIdx), // 进度线=目标匀速线（与目标线同，进度率另在KPI体现）
    };
  });
}
