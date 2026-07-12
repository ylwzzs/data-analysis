// web/app/admin/targets/[id]/page.tsx
// 分解：批量编辑表（战区/二级区域 合并单元格 + 门店×动态指标列）+ 汇总校验 + 下载/上传
'use client';
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Download, Upload, CheckCircle } from 'lucide-react';
import { useParams } from 'next/navigation';

export default function BreakdownPage() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<any[]>([]);
  const [balance, setBalance] = useState<any>({});
  const [metrics, setMetrics] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const r = await fetch(`/api/admin/targets/breakdown?parent_id=${id}`); const j = await r.json();
    setRows(j.rows || []); setBalance(j.balance || {});
    setMetrics(Object.keys(j.balance || {}).length ? Object.keys(j.balance) : (j.rows?.[0]?.metrics ? Object.keys(j.rows[0].metrics) : ['sale']));
  };
  useEffect(() => { load(); }, []);

  // 按 branch_num 改某指标值
  const setCell = (branch_num: string, m: string, v: string) => setRows(rs => rs.map(r => r.branch_num === branch_num ? { ...r, metrics: { ...r.metrics, [m]: v } } : r));
  const save = async () => {
    const diffs = metrics.filter(m => (Number(balance[m]?.total) || 0) - sumOf(m) !== 0);
    if (diffs.length && !confirm(`有 ${diffs.length} 个指标分解与总目标有差额，确认保存？`)) return;
    const payload = rows.map(r => ({ branch_num: r.branch_num, metrics: Object.fromEntries(metrics.map(m => [m, Number(r.metrics?.[m] || 0)])) }));
    const r = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), sbc: '3120', rows: payload }) });
    const j = await r.json();
    if (j.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); load(); } else alert('失败:' + JSON.stringify(j));
  };
  const sumOf = (m: string) => rows.reduce((s, r) => s + (Number(r.metrics?.[m]) || 0), 0);

  // 导入 Excel：解析返行后按 branch_num 合并填 metrics（保留门店基础信息）
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try {
      const r = await fetch('/api/admin/targets/template', { method: 'POST', body: fd });
      const j = await r.json();
      if (j.rows) {
        const byBn = Object.fromEntries(j.rows.map((x: any) => [x.branch_num, x.metrics]));
        setRows(rs => rs.map(rw => byBn[rw.branch_num] ? { ...rw, metrics: { ...rw.metrics, ...byBn[rw.branch_num] } } : rw));
        alert(`已导入 ${j.count} 条，请核对后点「保存分解」`);
      } else {
        alert('解析失败：' + (j.error || JSON.stringify(j)));
      }
    } catch (err) {
      alert('解析失败：' + String(err));
    }
    e.target.value = ''; // 清空 input 允许重选同文件
  };

  // 按 战区 + 二级区域 排序，算合并 rowSpan
  const sorted = [...rows].sort((a, b) => (a.war_zone || '').localeCompare(b.war_zone || '') || (a.region_l2 || '').localeCompare(b.region_l2 || ''));
  const spanOf = (keyFn: (r: any) => string) => {
    const spans = new Array(sorted.length).fill(0);
    for (let i = 0; i < sorted.length;) { let j = i + 1; while (j < sorted.length && keyFn(sorted[j]) === keyFn(sorted[i])) j++; spans[i] = j - i; i = j; }
    return spans;
  };
  const wzSpans = spanOf(r => r.war_zone || '');
  const l2Spans = spanOf(r => (r.war_zone || '') + '|' + (r.region_l2 || ''));

  return (
    <div className="p-4">
      <a href="/admin/targets" className="text-primary text-sm inline-flex items-center gap-1"><ArrowLeft size={14} /> 返回目标列表</a>
      <h1 className="text-xl font-bold my-2">目标分解</h1>
      <div className="mb-3 flex items-center gap-2">
        <a href={`/api/admin/targets/template?parent_id=${id}`} download className="inline-flex items-center gap-1.5 border border-primary text-primary px-3 py-1 text-sm rounded-md hover:bg-primary/5">
          <Download size={14} /> 下载模板
        </a>
        <input type="file" accept=".xlsx,.xls" ref={fileInputRef} onChange={handleImport} className="hidden" />
        <button onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-1.5 border border-primary text-primary px-3 py-1 text-sm rounded-md hover:bg-primary/5">
          <Upload size={14} /> 导入分解
        </button>
        <button onClick={save} className="bg-primary text-white px-3 py-1 text-sm rounded-md inline-flex items-center gap-1.5 hover:bg-primary/90">保存分解</button>
        {saved && <span className="text-green-600 text-sm inline-flex items-center gap-1"><CheckCircle size={14} /> 已保存</span>}
      </div>

      <table className="text-sm border-collapse" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <thead><tr className="bg-gray-100">
          <th className="border p-2 text-left w-32">战区(一级)</th>
          <th className="border p-2 text-left w-28">二级区域</th>
          <th className="border p-2 text-left">门店号</th>
          <th className="border p-2 text-left">门店名</th>
          {metrics.map(m => <th key={m} className="border p-2 text-left w-28">{METRIC_NAME[m] || m}</th>)}
        </tr></thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.branch_num}>
              {wzSpans[i] > 0 && <td rowSpan={wzSpans[i]} className="border p-2 bg-primary/10 align-top font-medium">{r.war_zone || '-'}</td>}
              {l2Spans[i] > 0 && <td rowSpan={l2Spans[i]} className="border p-2 align-top text-gray-600">{r.region_l2 || '-'}</td>}
              <td className="border p-2">{r.branch_num}</td>
              <td className="border p-2">{r.branch_name}</td>
              {metrics.map(m => (
                <td key={m} className="border p-2">
                  <input type="number" value={r.metrics?.[m] ?? ''} onChange={e => setCell(r.branch_num, m, e.target.value)} className="border rounded px-1 w-24 text-sm text-right" style={{ fontVariantNumeric: 'tabular-nums' }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const METRIC_NAME: Record<string, string> = { sale: '销售总额', purchase: '拿货量', wholesale: '批发额' };
