// web/app/admin/targets/[id]/page.tsx
// 分解页：一个目标两板块——总部品类分解(水果/标品 × 出库) + 门店分解(各店 × 销售/配送)
'use client';
import { useState, useEffect, useRef, Fragment } from 'react';
import { ArrowLeft, Download, Upload, CheckCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { useParams } from 'next/navigation';

const HQ_METRICS = ['outbound_amt', 'outbound_profit'];
const HQ_CATEGORIES = ['水果', '标品耗材'];
const STORE_METRICS = ['sale', 'delivery'];
const METRIC_NAME: Record<string, string> = { sale: '销售总额', delivery: '配送', outbound_amt: '出库金额', outbound_profit: '出库毛利' };

export default function BreakdownPage() {
  const { id } = useParams<{ id: string }>();
  const [hqGrid, setHqGrid] = useState<Record<string, Record<string, string>>>({});
  const [warZoneRows, setWarZoneRows] = useState<any[]>([]);
  const [regionRows, setRegionRows] = useState<any[]>([]);
  const [branchRows, setBranchRows] = useState<any[]>([]);
  const [expandedWz, setExpandedWz] = useState<Set<string>>(new Set());
  const [expandedR2, setExpandedR2] = useState<Set<string>>(new Set());
  const [balance, setBalance] = useState<any>({});
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const r = await fetch(`/api/admin/targets/breakdown?parent_id=${id}`); const j = await r.json();
    setBalance(j.balance || {});
    const savedCat: Record<string, any> = Object.fromEntries((j.categoryRows || []).map((x: any) => [x.category, x.metrics]));
    setHqGrid(Object.fromEntries(HQ_CATEGORIES.map(c => [c, Object.fromEntries(HQ_METRICS.map(m => [m, savedCat[c]?.[m] ?? '']))])));
    // 三级门店分解: warZoneRows/regionRows 从 DB 返, 为空时从 branchRows 派生(空 metrics)
    const br = (j.branchRows || []) as any[];
    const wzDbMap = Object.fromEntries((j.warZoneRows || []).map((r: any) => [r.war_zone, r]));
    const r2DbMap = Object.fromEntries((j.regionRows || []).map((r: any) => [`${r.war_zone}|${r.region_l2}`, r]));
    const wzs = [...new Set(br.map((b: any) => b.war_zone).filter(Boolean))];
    const r2Keys = [...new Set(br.map((b: any) => `${b.war_zone}|${b.region_l2}`))];
    const wzRows = wzs.map((wz: string) => wzDbMap[wz] || { war_zone: wz, metrics: {} });
    const rgRows = r2Keys.map((key: string) => {
      const [war_zone, region_l2] = key.split('|');
      return r2DbMap[key] || { war_zone, region_l2, metrics: {} };
    });
    wzRows.sort((a, b) => (a.war_zone || '').localeCompare(b.war_zone || ''));
    rgRows.sort((a, b) => (a.war_zone || '').localeCompare(b.war_zone || '') || (a.region_l2 || '').localeCompare(b.region_l2 || ''));
    setWarZoneRows(wzRows);
    setRegionRows(rgRows);
    setBranchRows(br);
    setExpandedWz(new Set(wzs));
    setExpandedR2(new Set());
  };
  useEffect(() => { load(); }, []);

  // 品类
  const setHq = (cat: string, m: string, v: string) => setHqGrid(g => ({ ...g, [cat]: { ...g[cat], [m]: v } }));
  const hqSum = (m: string) => HQ_CATEGORIES.reduce((s, c) => s + (Number(hqGrid[c]?.[m]) || 0), 0);
  const saveHq = async () => {
    const payload = HQ_CATEGORIES.map(c => ({ category: c, metrics: Object.fromEntries(HQ_METRICS.map(m => [m, Number(hqGrid[c]?.[m]) || 0])) }));
    const r = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), rows: payload }) });
    const j = await r.json();
    if (j.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); load(); } else alert('失败:' + JSON.stringify(j));
  };

  // 门店三级: 战区/区域/门店
  const setWzCell = (wz: string, m: string, v: string) => setWarZoneRows(rs => rs.map(r => r.war_zone === wz ? { ...r, metrics: { ...r.metrics, [m]: v } } : r));
  const setR2Cell = (wz: string, r2: string, m: string, v: string) => setRegionRows(rs => rs.map(r => r.war_zone === wz && r.region_l2 === r2 ? { ...r, metrics: { ...r.metrics, [m]: v } } : r));
  const setStoreCell = (bn: string, m: string, v: string) => setBranchRows(rs => rs.map(r => r.branch_num === bn ? { ...r, metrics: { ...r.metrics, [m]: v } } : r));
  const toggleWz = (wz: string) => setExpandedWz(s => { const n = new Set(s); if (n.has(wz)) n.delete(wz); else n.add(wz); return n; });
  const toggleR2 = (key: string) => setExpandedR2(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // 子和校验: 战区=所辖区域和 / 区域=所辖门店和
  const wzRegionSum = (wz: string, m: string) => regionRows.filter(r => r.war_zone === wz).reduce((s, r) => s + (Number(r.metrics?.[m]) || 0), 0);
  const r2StoreSum = (wz: string, r2: string, m: string) => branchRows.filter(b => b.war_zone === wz && b.region_l2 === r2).reduce((s, b) => s + (Number(b.metrics?.[m]) || 0), 0);
  const storeSum = (m: string) => branchRows.reduce((s, r) => s + (Number(r.metrics?.[m]) || 0), 0);
  const saveThreeLevel = async () => {
    const diffs: string[] = [];
    STORE_METRICS.forEach(m => {
      const total = Number(balance[m]?.total) || 0;
      const stSum = storeSum(m);
      if (total && total !== stSum) diffs.push(`总目标 ${METRIC_NAME[m]} 差额 ${stSum - total}`);
      warZoneRows.forEach(wz => {
        const wzVal = Number(wz.metrics?.[m]) || 0;
        if (!wzVal) return;
        const rSum = wzRegionSum(wz.war_zone, m);
        if (wzVal !== rSum) diffs.push(`战区${wz.war_zone} ${METRIC_NAME[m]} 差额 ${rSum - wzVal}`);
      });
      regionRows.forEach(r2 => {
        const r2Val = Number(r2.metrics?.[m]) || 0;
        if (!r2Val) return;
        const sSum = r2StoreSum(r2.war_zone, r2.region_l2, m);
        if (r2Val !== sSum) diffs.push(`区域${r2.region_l2} ${METRIC_NAME[m]} 差额 ${sSum - r2Val}`);
      });
    });
    if (diffs.length && !confirm(`有 ${diffs.length} 处子和校验差额：\n${diffs.slice(0, 6).join('\n')}${diffs.length > 6 ? '\n...' : ''}\n确认保存？`)) return;
    const payload = [
      ...warZoneRows.filter(wz => STORE_METRICS.some(m => Number(wz.metrics?.[m]) > 0)).map(r => ({ breakdown_level: 'war_zone', war_zone: r.war_zone, branch_num: 'ALL', metrics: Object.fromEntries(STORE_METRICS.map(m => [m, Number(r.metrics?.[m]) || 0])) })),
      ...regionRows.filter(r2 => STORE_METRICS.some(m => Number(r2.metrics?.[m]) > 0)).map(r => ({ breakdown_level: 'region_l2', war_zone: r.war_zone, region_l2: r.region_l2, branch_num: 'ALL', metrics: Object.fromEntries(STORE_METRICS.map(m => [m, Number(r.metrics?.[m]) || 0])) })),
      ...branchRows.map(r => ({ breakdown_level: 'store', branch_num: r.branch_num, metrics: Object.fromEntries(STORE_METRICS.map(m => [m, Number(r.metrics?.[m]) || 0])) })),
    ];
    const r = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), sbc: 'ALL', rows: payload }) });
    const j = await r.json();
    if (j.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); load(); } else alert('失败:' + JSON.stringify(j));
  };
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try {
      const r = await fetch('/api/admin/targets/template', { method: 'POST', body: fd });
      const j = await r.json();
      if (j.rows) {
        const byBn = Object.fromEntries(j.rows.map((x: any) => [x.branch_num, x.metrics]));
        setBranchRows(rs => rs.map(rw => byBn[rw.branch_num] ? { ...rw, metrics: { ...rw.metrics, ...byBn[rw.branch_num] } } : rw));
        alert(`已导入 ${j.count} 条，请核对后点「保存三级分解」`);
      } else { alert('解析失败：' + (j.error || JSON.stringify(j))); }
    } catch (err) { alert('解析失败：' + String(err)); }
    e.target.value = '';
  };
  return (
    <div className="p-4">
      <a href="/admin/targets" className="text-primary text-sm inline-flex items-center gap-1"><ArrowLeft size={14} /> 返回目标列表</a>
      <h1 className="text-xl font-bold my-2">目标分解</h1>

      <h2 className="font-bold mb-2 mt-4">总部板块·品类分解 <span className="text-xs text-gray-500 font-normal">（出库金额/毛利，不拆门店）</span></h2>
      <div className="mb-2 flex items-center gap-2">
        <button onClick={saveHq} className="bg-primary text-white px-4 py-1 text-sm rounded-md inline-flex items-center gap-1.5 hover:bg-primary/90">保存品类分解</button>
        {saved && <span className="text-green-600 text-sm inline-flex items-center gap-1"><CheckCircle size={14} /> 已保存</span>}
      </div>
      <table className="text-sm border-collapse tabular-nums mb-6 w-full max-w-2xl">
        <thead><tr className="bg-gray-100">
          <th className="border p-2 text-left">品类</th>
          {HQ_METRICS.map(m => <th key={m} className="border p-2 text-left">{METRIC_NAME[m]}(元)</th>)}
        </tr></thead>
        <tbody>
          {HQ_CATEGORIES.map(cat => (
            <tr key={cat}>
              <td className="border p-2">{cat}</td>
              {HQ_METRICS.map(m => <td key={m} className="border p-2"><input type="number" value={hqGrid[cat]?.[m] ?? ''} onChange={e => setHq(cat, m, e.target.value)} className="border rounded-md px-2 py-1 w-full text-sm text-right tabular-nums" /></td>)}
            </tr>
          ))}
          <tr className="bg-gray-50 font-medium">
            <td className="border p-2">合计</td>
            {HQ_METRICS.map(m => {
              const sum = hqSum(m); const total = Number(balance[m]?.total || 0); const diff = sum - total;
              return <td key={m} className={`border p-2 text-right tabular-nums ${diff===0 ? 'text-green-600' : 'text-red-600'}`}>{sum.toLocaleString()}{diff!==0 && <span className="text-xs ml-1">({diff>0?'+':''}{diff.toLocaleString()})</span>}</td>;
            })}
          </tr>
        </tbody>
      </table>

      <h2 className="font-bold mb-2">门店板块·三级分解 <span className="text-xs text-gray-500 font-normal">（战区→区域→门店，销售/配送）</span></h2>
      <div className="mb-2 flex items-center gap-2">
        <a href={`/api/admin/targets/template?parent_id=${id}`} download className="inline-flex items-center gap-1.5 border border-primary text-primary px-4 py-1 text-sm rounded-md hover:bg-primary/5"><Download size={14} /> 下载模板</a>
        <input type="file" accept=".xlsx,.xls" ref={fileInputRef} onChange={handleImport} className="hidden" />
        <button onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-1.5 border border-primary text-primary px-4 py-1 text-sm rounded-md hover:bg-primary/5"><Upload size={14} /> 导入分解</button>
        <button onClick={saveThreeLevel} className="bg-primary text-white px-4 py-1 text-sm rounded-md inline-flex items-center gap-1.5 hover:bg-primary/90">保存三级分解</button>
      </div>
      <table className="text-sm border-collapse tabular-nums w-full">
        <thead><tr className="bg-gray-100">
          <th className="border p-2 text-left">战区 / 区域 / 门店</th>
          {STORE_METRICS.map(m => <th key={m} className="border p-2 text-right w-44">{METRIC_NAME[m]}</th>)}
          <th className="border p-2 text-right w-44">子和校验</th>
        </tr></thead>
        <tbody>
          {warZoneRows.map(wz => {
            const wzExpanded = expandedWz.has(wz.war_zone);
            const regions = regionRows.filter(r => r.war_zone === wz.war_zone);
            return (
              <Fragment key={wz.war_zone}>
                <tr className="bg-primary/10 font-medium">
                  <td className="border p-2">
                    <button onClick={() => toggleWz(wz.war_zone)} className="inline-flex items-center gap-1">
                      {wzExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{wz.war_zone}
                    </button>
                  </td>
                  {STORE_METRICS.map(m => (
                    <td key={m} className="border p-2"><input type="number" value={wz.metrics?.[m] ?? ''} onChange={e => setWzCell(wz.war_zone, m, e.target.value)} className="border rounded-md px-2 py-1 w-full text-sm text-right tabular-nums" /></td>
                  ))}
                  <td className="border p-2 text-right tabular-nums text-xs space-y-0.5">
                    {STORE_METRICS.map(m => {
                      const childSum = wzRegionSum(wz.war_zone, m);
                      const parentVal = Number(wz.metrics?.[m]) || 0;
                      const diff = childSum - parentVal;
                      return <div key={m} className={diff === 0 ? 'text-green-600' : 'text-red-600'}>{METRIC_NAME[m].slice(0, 2)} {childSum.toLocaleString()}{diff !== 0 && <span className="ml-1">({diff > 0 ? '+' : ''}{diff.toLocaleString()})</span>}</div>;
                    })}
                  </td>
                </tr>
                {wzExpanded && regions.map(r2 => {
                  const r2Key = `${wz.war_zone}|${r2.region_l2}`;
                  const r2Expanded = expandedR2.has(r2Key);
                  const stores = branchRows.filter(b => b.war_zone === wz.war_zone && b.region_l2 === r2.region_l2);
                  return (
                    <Fragment key={r2Key}>
                      <tr className="bg-slate-50">
                        <td className="border p-2 pl-6">
                          <button onClick={() => toggleR2(r2Key)} className="inline-flex items-center gap-1 text-gray-700">
                            {r2Expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{r2.region_l2 || '-'}
                          </button>
                        </td>
                        {STORE_METRICS.map(m => (
                          <td key={m} className="border p-2"><input type="number" value={r2.metrics?.[m] ?? ''} onChange={e => setR2Cell(wz.war_zone, r2.region_l2, m, e.target.value)} className="border rounded-md px-2 py-1 w-full text-sm text-right tabular-nums" /></td>
                        ))}
                        <td className="border p-2 text-right tabular-nums text-xs space-y-0.5">
                          {STORE_METRICS.map(m => {
                            const childSum = r2StoreSum(wz.war_zone, r2.region_l2, m);
                            const parentVal = Number(r2.metrics?.[m]) || 0;
                            const diff = childSum - parentVal;
                            return <div key={m} className={diff === 0 ? 'text-green-600' : 'text-red-600'}>{METRIC_NAME[m].slice(0, 2)} {childSum.toLocaleString()}{diff !== 0 && <span className="ml-1">({diff > 0 ? '+' : ''}{diff.toLocaleString()})</span>}</div>;
                          })}
                        </td>
                      </tr>
                      {r2Expanded && stores.map(store => (
                        <tr key={store.branch_num}>
                          <td className="border p-2 pl-12 text-gray-700"><span className="text-xs text-gray-400 mr-2">{store.branch_num}</span>{store.branch_name}</td>
                          {STORE_METRICS.map(m => (
                            <td key={m} className="border p-2"><input type="number" value={store.metrics?.[m] ?? ''} onChange={e => setStoreCell(store.branch_num, m, e.target.value)} className="border rounded-md px-2 py-1 w-full text-sm text-right tabular-nums" /></td>
                          ))}
                          <td className="border p-2"></td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
