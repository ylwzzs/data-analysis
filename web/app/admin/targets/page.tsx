// web/app/admin/targets/page.tsx
// D 目标后台：列表(达成率) + 新建表单 + 提前固化 + CSV导入入口
'use client';
import { useState, useEffect } from 'react';

export default function TargetsPage() {
  const [data, setData] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState('');

  const load = async () => {
    const r = await fetch('/api/admin/targets');
    const j = await r.json();
    setData(j.data || []);
  };
  useEffect(() => { load(); }, []);

  const closeTarget = async (id: number) => {
    if (!confirm(`提前结束并固化目标 ${id}？`)) return;
    const r = await fetch('/api/admin/targets/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    const j = await r.json();
    setMsg(j.ok ? `目标 ${id} 已固化` : `失败: ${JSON.stringify(j)}`);
    load();
  };

  const pct = (v: any) => v != null ? (Number(v) * 100).toFixed(1) + '%' : '-';
  const money = (v: any, u: any) => v != null ? `${v}${u || ''}` : '-';

  return (
    <div style={{ padding: 16 }}>
      <h1>目标与达成率</h1>
      <button onClick={() => setShowForm(!showForm)}>{showForm ? '收起' : '新建目标'}</button>
      <button onClick={load} style={{ marginLeft: 8 }}>刷新</button>
      {msg && <span style={{ marginLeft: 12, color: '#666' }}>{msg}</span>}
      {showForm && <TargetForm onSaved={() => { setShowForm(false); load(); }} />}
      <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            {['名称', '品牌/店', '战区', '周期', '指标', '目标', '实际', '达成', '进度', '数据', '状态', '操作'].map(h =>
              <th key={h} style={{ padding: 6, border: '1px solid #ddd', textAlign: 'left' }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((r: any) => (
            <tr key={`${r.target_id}-${r.metric_code}`}>
              <td style={cell}>{r.name}</td>
              <td style={cell}>{r.system_book_code}/{r.branch_num}</td>
              <td style={cell}>{r.war_zone || '-'}</td>
              <td style={cell}>{r.start_date}~{r.end_date}</td>
              <td style={cell}>{r.metric_name}</td>
              <td style={cell}>{money(r.target_value, r.unit)}</td>
              <td style={cell}>{money(r.actual_value, r.unit)}</td>
              <td style={cell}>{pct(r.achievement_rate)}</td>
              <td style={cell}>{pct(r.progress_rate)}</td>
              <td style={cell}>{r.data_status}</td>
              <td style={cell}>{r.status}</td>
              <td style={cell}>{r.status === 'active' && <button onClick={() => closeTarget(r.target_id)}>提前结束</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const cell: React.CSSProperties = { padding: 6, border: '1px solid #ddd' };

function TargetForm({ onSaved }: { onSaved: () => void }) {
  const [f, setF] = useState({ name: '', system_book_code: '3120', branch_num: '', start_date: '', end_date: '', target_sale: '' });
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    if (!f.name || !f.branch_num || !f.start_date || !f.end_date || !f.target_sale) { setErr('请填全'); return; }
    const r = await fetch('/api/admin/targets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...f, metrics: [{ metric_code: 'sale', target_value: Number(f.target_sale) }], created_by: 'admin' }),
    });
    const j = await r.json();
    if (j.success) onSaved(); else setErr(j.error || '失败');
  };
  return (
    <div style={{ border: '1px solid #ddd', padding: 8, margin: '8px 0', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input placeholder="名称" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />
      <select value={f.system_book_code} onChange={e => setF({ ...f, system_book_code: e.target.value })}>
        <option value="3120">3120</option><option value="64188">64188</option>
      </select>
      <input placeholder="branch_num" value={f.branch_num} onChange={e => setF({ ...f, branch_num: e.target.value })} />
      <input type="date" value={f.start_date} onChange={e => setF({ ...f, start_date: e.target.value })} />
      <input type="date" value={f.end_date} onChange={e => setF({ ...f, end_date: e.target.value })} />
      <input placeholder="销售目标(元)" value={f.target_sale} onChange={e => setF({ ...f, target_sale: e.target.value })} />
      <button onClick={submit}>保存</button>
      {err && <span style={{ color: 'red' }}>{err}</span>}
    </div>
  );
}
