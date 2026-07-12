// web/app/admin/targets/page.tsx
// 目标管理：总目标列表 + 新建总目标(Modal 明细表式 指标=行) + 分解入口
'use client';
import { useState, useEffect } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';

export default function TargetsPage() {
  const [list, setList] = useState<any[]>([]);
  const [show, setShow] = useState(false);
  const load = async () => {
    const r = await fetch('/api/admin/targets'); const j = await r.json();
    setList((j.data || []).filter((t: any) => t.target_level !== 'breakdown' || t.parent_target_id === null));
  };
  useEffect(() => { load(); }, []);
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-3">目标管理</h1>
      <div className="mb-3"><button onClick={() => setShow(true)} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">新建总目标</button></div>
      <table className="w-full text-sm border-collapse">
        <thead><tr className="bg-gray-100">{['名称', '品牌', '周期', '指标', '目标', '达成', '状态', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {list.map((t: any) => (
            <tr key={`${t.target_id}-${t.metric_code}`}>
              <td className="border p-2">{t.name}</td><td className="border p-2">{t.system_book_code}</td>
              <td className="border p-2">{t.start_date}~{t.end_date}</td>
              <td className="border p-2">{t.metric_name}</td><td className="border p-2">{t.target_value}{t.unit}</td>
              <td className="border p-2">{t.achievement_rate != null ? (Number(t.achievement_rate) * 100).toFixed(0) + '%' : '-'}</td>
              <td className="border p-2">{t.status}</td>
              <td className="border p-2"><a href={`/admin/targets/${t.target_id}`} className="text-blue-600">分解</a></td>
            </tr>
          ))}
        </tbody>
      </table>
      {show && <TotalForm onSaved={() => { setShow(false); load(); }} onClose={() => setShow(false)} />}
    </div>
  );
}

const METRICS = [
  { code: 'sale', name: '销售总额' },
  { code: 'purchase', name: '拿货量' },
  { code: 'wholesale', name: '批发额' },
];

// 新建总目标：Modal + 指标明细表（每行一个指标，增删行）
function TotalForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
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
      body: JSON.stringify({ name, start_date: start, end_date: end, metrics: valid.map(r => ({ metric_code: r.metric_code, target_value: Number(r.target_value) })) }),
    });
    const j = await r.json();
    if (j.ok) onSaved(); else setErr(j.error || '保存失败');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-w-[92vw] max-h-[92vh] overflow-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-lg">新建总目标</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="col-span-1"><label className="text-xs text-gray-500">目标名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="7月经营目标" className="border rounded w-full px-2 py-1.5 text-sm" /></div>
          <div><label className="text-xs text-gray-500">开始日期</label><input type="date" value={start} onChange={e => setStart(e.target.value)} className="border rounded w-full px-2 py-1.5 text-sm" /></div>
          <div><label className="text-xs text-gray-500">结束日期</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border rounded w-full px-2 py-1.5 text-sm" /></div>
        </div>

        <label className="text-xs text-gray-500">指标明细 <span className="text-gray-400">（每行一个指标，可增删）</span></label>
        <table className="w-full text-sm border-collapse mt-1 mb-3">
          <thead><tr className="bg-gray-100">
            <th className="border p-2 text-left font-normal w-[45%]">指标</th>
            <th className="border p-2 text-left font-normal">目标值</th>
            <th className="border p-2 text-left font-normal w-12">操作</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="border p-1">
                  <select value={r.metric_code} onChange={e => setRow(i, { metric_code: e.target.value })} className="border rounded w-full px-2 py-1 text-sm bg-white">
                    <option value="">请选择...</option>
                    {METRICS.map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
                  </select>
                </td>
                <td className="border p-1"><input type="number" value={r.target_value} onChange={e => setRow(i, { target_value: e.target.value })} placeholder="目标值" className="border rounded w-full px-2 py-1 text-sm text-right" /></td>
                <td className="border p-1 text-center"><button onClick={() => delRow(i)} className="text-gray-400 hover:text-red-600 inline-flex items-center justify-center" title="删除该行"><Trash2 size={14} /></button></td>
              </tr>
            ))}
            <tr><td colSpan={3} className="border p-0"><button onClick={addRow} className="w-full py-2 text-sm text-blue-600 hover:bg-blue-50 inline-flex items-center justify-center gap-1"><Plus size={14} /> 添加指标行</button></td></tr>
          </tbody>
        </table>

        {err && <div className="text-red-600 text-sm mb-2">{err}</div>}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button onClick={onClose} className="border border-gray-300 px-4 py-1.5 text-sm rounded hover:bg-gray-50">取消</button>
          <button onClick={submit} className="bg-blue-600 text-white px-4 py-1.5 text-sm rounded hover:bg-blue-700">保存总目标</button>
        </div>
      </div>
    </div>
  );
}
