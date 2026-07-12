// web/app/admin/targets/[id]/page.tsx
// 分解：批量编辑表（战区/分组/门店×指标）+ 汇总校验 + 下载/上传
'use client';
import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';

export default function BreakdownPage() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<any[]>([]);
  const [balance, setBalance] = useState<any>({});
  const [metrics, setMetrics] = useState<string[]>([]);
  const load = async () => {
    const r = await fetch(`/api/admin/targets/breakdown?parent_id=${id}`); const j = await r.json();
    setRows(j.rows || []); setBalance(j.balance || {});
    const ms = (j.rows?.[0]?.metrics && Object.keys(j.rows[0].metrics)) || (j.balance && Object.keys(j.balance)) || ['sale'];
    setMetrics(ms);
  };
  useEffect(() => { load(); }, []);
  const setCell = (i: number, m: string, v: string) => { const nr = [...rows]; nr[i] = { ...nr[i], metrics: { ...nr[i].metrics, [m]: v } }; setRows(nr); };
  const save = async () => {
    const payload = rows.map(r => ({ branch_num: r.branch_num, metrics: Object.fromEntries(metrics.map(m => [m, Number(r.metrics?.[m] || 0)])) }));
    const r = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), sbc: '3120', rows: payload }) });
    const j = await r.json(); if (j.ok) { alert('已保存'); load(); } else alert('失败');
  };
  const sumOf = (m: string) => rows.reduce((s, r) => s + (Number(r.metrics?.[m]) || 0), 0);
  return (
    <div className="p-4">
      <a href="/admin/targets" className="text-blue-600 text-sm">← 返回目标列表</a>
      <h1 className="text-xl font-bold my-2">目标分解</h1>
      <div className="mb-3"><a href={`/api/admin/targets/template?parent_id=${id}`} className="text-blue-600 text-sm mr-3">⬇下载模板</a><button onClick={save} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">保存分解</button></div>
      <table className="w-full text-sm border-collapse">
        <thead><tr className="bg-gray-100">{['战区', '分组', '门店号', '门店名', ...metrics, ''].map((h, i) => <th key={i} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.branch_num}>
              <td className="border p-2">{r.war_zone || '-'}</td><td className="border p-2">{r.group || '-'}</td>
              <td className="border p-2">{r.branch_num}</td><td className="border p-2">{r.branch_name}</td>
              {metrics.map(m => <td key={m} className="border p-2"><input type="number" value={r.metrics?.[m] ?? ''} onChange={e => setCell(i, m, e.target.value)} className="border px-1 w-20 text-sm rounded" /></td>)}
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="bg-green-50 font-bold">
          <td className="border p-2" colSpan={4}>汇总校验</td>
          {metrics.map(m => { const tot = Number(balance[m]?.total) || 0; const s = sumOf(m); const diff = tot - s; return <td key={m} className="border p-2">Σ{s}/{tot} <span className={diff === 0 ? 'text-green-600' : 'text-red-600'}>{diff === 0 ? '✅' : `差${diff.toFixed(1)}`}</span></td>; })}
        </tr></tfoot>
      </table>
    </div>
  );
}
