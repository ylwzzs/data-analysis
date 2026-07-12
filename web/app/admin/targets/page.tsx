// web/app/admin/targets/page.tsx
// 目标管理：两类目标(总部hq出库按品类 / 门店store销售配送) + 列表分两区 + 按类型新建
'use client';
import { useState, useEffect } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';

const HQ_METRICS = [
  { code: 'outbound_amt', name: '出库金额' },
  { code: 'outbound_profit', name: '出库毛利' },
];
const HQ_CATEGORIES = ['水果', '标品耗材'];
const STORE_METRICS = [
  { code: 'sale', name: '销售总额' },
  { code: 'delivery', name: '配送' },
];

export default function TargetsPage() {
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState<null | 'hq' | 'store'>(null);
  const load = async () => {
    const r = await fetch('/api/admin/targets'); const j = await r.json();
    setList((j.data || []).filter((t: any) => t.target_level !== 'breakdown' || t.parent_target_id === null));
  };
  useEffect(() => { load(); }, []);

  const hq = list.filter(t => t.target_type === 'hq');
  const store = list.filter(t => t.target_type !== 'hq');

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-4">目标管理</h1>
      <div className="mb-4 flex gap-2">
        <button onClick={() => setForm('hq')} className="bg-primary text-white px-4 py-1 text-sm rounded-md">新建总部目标</button>
        <button onClick={() => setForm('store')} className="bg-primary text-white px-4 py-1 text-sm rounded-md">新建门店目标</button>
      </div>

      <h2 className="font-bold mb-2 mt-4">总部目标 <span className="text-xs text-gray-500 font-normal">（出库金额/毛利，按品类水果/标品耗材，不拆门店）</span></h2>
      <table className="w-full text-sm border-collapse tabular-nums mb-6">
        <thead><tr className="bg-gray-100">{['名称', '周期', '指标', '目标', '达成', '状态', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {hq.length === 0 && <tr><td colSpan={7} className="border p-2 text-gray-400 text-center">暂无总部目标</td></tr>}
          {hq.map(t => (
            <tr key={`${t.target_id}-${t.metric_code}`}>
              <td className="border p-2">{t.name}</td><td className="border p-2">{t.start_date}~{t.end_date}</td>
              <td className="border p-2">{t.metric_name}</td><td className="border p-2">{Number(t.target_value).toLocaleString()}{t.unit}</td>
              <td className="border p-2">{t.achievement_rate != null ? (Number(t.achievement_rate) * 100).toFixed(0) + '%' : '-'}</td>
              <td className="border p-2">{t.status}</td>
              <td className="border p-2"><a href={`/admin/targets/${t.target_id}`} className="text-primary">查看品类分解</a></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-bold mb-2">门店目标 <span className="text-xs text-gray-500 font-normal">（销售/配送，分解到门店）</span></h2>
      <table className="w-full text-sm border-collapse tabular-nums">
        <thead><tr className="bg-gray-100">{['名称', '品牌', '周期', '指标', '目标', '达成', '状态', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {store.length === 0 && <tr><td colSpan={8} className="border p-2 text-gray-400 text-center">暂无门店目标</td></tr>}
          {store.map(t => (
            <tr key={`${t.target_id}-${t.metric_code}`}>
              <td className="border p-2">{t.name}</td><td className="border p-2">{t.system_book_code}</td>
              <td className="border p-2">{t.start_date}~{t.end_date}</td>
              <td className="border p-2">{t.metric_name}</td><td className="border p-2">{Number(t.target_value).toLocaleString()}{t.unit}</td>
              <td className="border p-2">{t.achievement_rate != null ? (Number(t.achievement_rate) * 100).toFixed(0) + '%' : '-'}</td>
              <td className="border p-2">{t.status}</td>
              <td className="border p-2"><a href={`/admin/targets/${t.target_id}`} className="text-primary">分解</a></td>
            </tr>
          ))}
        </tbody>
      </table>

      {form === 'hq' && <HqForm onSaved={() => { setForm(null); load(); }} onClose={() => setForm(null)} />}
      {form === 'store' && <StoreForm onSaved={() => { setForm(null); load(); }} onClose={() => setForm(null)} />}
    </div>
  );
}

function HqForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [grid, setGrid] = useState<Record<string, Record<string, string>>>(
    Object.fromEntries(HQ_CATEGORIES.map(c => [c, Object.fromEntries(HQ_METRICS.map(m => [m.code, '']))]))
  );
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (cat: string, code: string, v: string) => setGrid(g => ({ ...g, [cat]: { ...g[cat], [code]: v } }));
  const sumOf = (code: string) => HQ_CATEGORIES.reduce((s, c) => s + (Number(grid[c]?.[code]) || 0), 0);

  const submit = async () => {
    setErr('');
    if (!name || !start || !end) { setErr('请填名称和周期'); return; }
    if (HQ_CATEGORIES.some(c => HQ_METRICS.some(m => !grid[c][m.code]))) { setErr('请填满 4 个目标值'); return; }
    setBusy(true);
    const totalMetrics = HQ_METRICS.map(m => ({ metric_code: m.code, target_value: sumOf(m.code) }));
    const r1 = await fetch('/api/admin/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, start_date: start, end_date: end, target_type: 'hq', metrics: totalMetrics }) });
    const j1 = await r1.json();
    if (!j1.ok) { setBusy(false); setErr(j1.error || '建总目标失败'); return; }
    const rows = HQ_CATEGORIES.map(c => ({ category: c, metrics: Object.fromEntries(HQ_METRICS.map(m => [m.code, Number(grid[c][m.code]) || 0])) }));
    const r2 = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: j1.target_id, rows }) });
    const j2 = await r2.json();
    setBusy(false);
    if (j2.ok) onSaved(); else setErr(j2.error || '品类分解失败');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-w-[92vw] p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-lg">新建总部目标</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="col-span-1"><label className="text-xs text-gray-500">目标名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="7月总部出库目标" className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-gray-500">开始日期</label><input type="date" value={start} onChange={e => setStart(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-gray-500">结束日期</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
        </div>
        <label className="text-xs text-gray-500">按品类填目标值（自动汇总=水果+标品耗材）</label>
        <table className="w-full text-sm border-collapse mt-1 mb-4 tabular-nums">
          <thead><tr className="bg-gray-100">
            <th className="border p-2 text-left font-normal">品类</th>
            {HQ_METRICS.map(m => <th key={m.code} className="border p-2 text-left font-normal">{m.name}(元)</th>)}
          </tr></thead>
          <tbody>
            {HQ_CATEGORIES.map(cat => (
              <tr key={cat}>
                <td className="border p-2">{cat}</td>
                {HQ_METRICS.map(m => <td key={m.code} className="border p-2"><input type="number" value={grid[cat][m.code]} onChange={e => set(cat, m.code, e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm text-right tabular-nums" /></td>)}
              </tr>
            ))}
            <tr className="bg-gray-50 font-medium">
              <td className="border p-2">合计</td>
              {HQ_METRICS.map(m => <td key={m.code} className="border p-2 text-right">{sumOf(m.code).toLocaleString()}</td>)}
            </tr>
          </tbody>
        </table>
        {err && <div className="text-red-600 text-sm mb-2">{err}</div>}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button onClick={onClose} className="border border-gray-300 px-4 py-1 text-sm rounded-md hover:bg-gray-50">取消</button>
          <button disabled={busy} onClick={submit} className="bg-primary text-white px-4 py-1 text-sm rounded-md hover:bg-primary/90 disabled:opacity-50">保存</button>
        </div>
      </div>
    </div>
  );
}

function StoreForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [rows, setRows] = useState<{ metric_code: string; target_value: string }[]>([{ metric_code: 'sale', target_value: '' }]);
  const [err, setErr] = useState('');
  const setRow = (i: number, patch: Partial<{ metric_code: string; target_value: string }>) => setRows(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const addRow = () => setRows([...rows, { metric_code: '', target_value: '' }]);
  const delRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i));

  const submit = async () => {
    setErr('');
    if (!name || !start || !end) { setErr('请填名称和周期'); return; }
    const valid = rows.filter(r => r.metric_code && r.target_value);
    if (valid.length === 0) { setErr('至少填一个指标及其目标值'); return; }
    const dup = new Set(valid.map(r => r.metric_code));
    if (dup.size !== valid.length) { setErr('指标不能重复'); return; }
    const r = await fetch('/api/admin/targets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, start_date: start, end_date: end, target_type: 'store', metrics: valid.map(r => ({ metric_code: r.metric_code, target_value: Number(r.target_value) })) }),
    });
    const j = await r.json();
    if (j.ok) onSaved(); else setErr(j.error || '保存失败');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-w-[92vw] max-h-[92vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-lg">新建门店目标</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="col-span-1"><label className="text-xs text-gray-500">目标名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="7月门店目标" className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-gray-500">开始日期</label><input type="date" value={start} onChange={e => setStart(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-gray-500">结束日期</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
        </div>
        <label className="text-xs text-gray-500">指标明细 <span className="text-gray-400">（每行一个指标，可增删）</span></label>
        <table className="w-full text-sm border-collapse mt-1 mb-4">
          <thead><tr className="bg-gray-100">
            <th className="border p-2 text-left font-normal w-[45%]">指标</th>
            <th className="border p-2 text-left font-normal">目标值</th>
            <th className="border p-2 text-left font-normal w-12">操作</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="border p-1">
                  <select value={r.metric_code} onChange={e => setRow(i, { metric_code: e.target.value })} className="border rounded-md w-full px-2 py-1 text-sm bg-white">
                    <option value="">请选择...</option>
                    {STORE_METRICS.map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
                  </select>
                </td>
                <td className="border p-1"><input type="number" value={r.target_value} onChange={e => setRow(i, { target_value: e.target.value })} placeholder="目标值" className="border rounded-md w-full px-2 py-1 text-sm text-right tabular-nums" /></td>
                <td className="border p-1 text-center"><button onClick={() => delRow(i)} className="text-gray-400 hover:text-red-600 inline-flex items-center justify-center"><Trash2 size={14} /></button></td>
              </tr>
            ))}
            <tr><td colSpan={3} className="border p-0"><button onClick={addRow} className="w-full py-2 text-sm text-primary hover:bg-primary/10 inline-flex items-center justify-center gap-1"><Plus size={14} /> 添加指标行</button></td></tr>
          </tbody>
        </table>
        {err && <div className="text-red-600 text-sm mb-2">{err}</div>}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button onClick={onClose} className="border border-gray-300 px-4 py-1 text-sm rounded-md hover:bg-gray-50">取消</button>
          <button onClick={submit} className="bg-primary text-white px-4 py-1 text-sm rounded-md hover:bg-primary/90">保存总目标</button>
        </div>
      </div>
    </div>
  );
}
