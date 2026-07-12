// web/app/admin/targets/page.tsx
// 目标分解：总目标列表 + 创建总目标(多指标) + 分解到门店(批量编辑/上传)+汇总校验
'use client';
import { useState, useEffect } from 'react';

export default function TargetsPage() {
  const [list, setList] = useState<any[]>([]);
  const [show, setShow] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const load = async () => { const r = await fetch('/api/admin/targets'); const j = await r.json(); setList((j.data || []).filter((t: any) => t.target_level !== 'breakdown' || t.parent_target_id === null)); };
  useEffect(() => { load(); }, []);
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-3">目标管理</h1>
      <div className="mb-3"><button onClick={() => { setShow(!show); setEdit(null); }} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">{show ? '收起' : '新建总目标'}</button></div>
      {show && <TotalForm onSaved={() => { setShow(false); load(); }} edit={edit} />}
      <table className="w-full text-sm border-collapse mt-2">
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
    </div>
  );
}

// 创建总目标（多指标默认全选可叉）
function TotalForm({ onSaved, edit }: { onSaved: () => void; edit: any }) {
  const ALL = [{ code: 'sale', name: '销售总额' }, { code: 'purchase', name: '拿货量' }, { code: 'wholesale', name: '批发额' }];
  const [picked, setPicked] = useState<string[]>(['sale', 'purchase', 'wholesale']);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [name, setName] = useState(''); const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    if (!name || !start || !end || picked.length === 0) { setErr('请填全'); return; }
    const r = await fetch('/api/admin/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, start_date: start, end_date: end, metrics: picked.map(m => ({ metric_code: m, target_value: Number(vals[m] || 0) })) }) });
    const j = await r.json(); if (j.ok) onSaved(); else setErr(j.error || '失败');
  };
  return (
    <div className="border rounded p-3 mb-3 bg-gray-50">
      <div className="flex gap-2 mb-2 flex-wrap">
        <input placeholder="目标名称" value={name} onChange={e => setName(e.target.value)} className="border px-2 py-1 text-sm rounded" />
        <input type="date" value={start} onChange={e => setStart(e.target.value)} className="border px-2 py-1 text-sm rounded" />
        <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border px-2 py-1 text-sm rounded" />
      </div>
      <div className="flex gap-2 flex-wrap mb-2">
        {ALL.map(m => (
          <span key={m.code} onClick={() => setPicked(picked.includes(m.code) ? picked.filter(x => x !== m.code) : [...picked, m.code])}
            className={`px-3 py-1 text-sm rounded-full cursor-pointer border ${picked.includes(m.code) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-500'}`}>
            {m.name} {picked.includes(m.code) && '✕'} {picked.includes(m.code) && <input type="number" placeholder="值" value={vals[m.code] || ''} onClick={e => e.stopPropagation()} onChange={e => setVals({ ...vals, [m.code]: e.target.value })} className="w-16 ml-1 text-black px-1" />}
          </span>
        ))}
      </div>
      <button onClick={submit} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">保存总目标</button>
      {err && <span className="text-red-600 ml-2 text-sm">{err}</span>}
    </div>
  );
}
