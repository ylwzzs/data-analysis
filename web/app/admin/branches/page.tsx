// web/app/admin/branches/page.tsx
// 门店维护：3 tab（门店列表 ext 行内编辑 / 区域战区映射 / 未映射预警）
'use client';
import { useState, useEffect } from 'react';

export default function BranchesPage() {
  const [tab, setTab] = useState<'list' | 'region' | 'unmapped'>('list');
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-4">门店维护</h1>
      <div className="flex gap-2 border-b mb-4">
        {([['list', '门店列表'], ['region', '区域→战区映射'], ['unmapped', '未映射区域预警']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm ${tab === k ? 'bg-blue-600 text-white rounded-t' : 'text-gray-600'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'list' && <BranchList />}
      {tab === 'region' && <RegionMap />}
      {tab === 'unmapped' && <Unmapped />}
    </div>
  );
}

// ===== 门店列表（base 只读 + ext 行内编辑）=====
function BranchList() {
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState({ war_zone: '', region: '', city: '', q: '' });
  const [edit, setEdit] = useState<any>(null); // 当前编辑 ext 的行
  const pageSize = 20;

  const load = async () => {
    const q = new URLSearchParams({ sbc: '3120', page: String(page), page_size: String(pageSize), ...filter } as any);
    const r = await fetch(`/api/admin/branches?${q}`);
    const j = await r.json();
    setData(j.data || []); setTotal(j.total || 0);
  };
  useEffect(() => { load(); }, [page]);

  const saveExt = async () => {
    await fetch('/api/admin/branches', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system_book_code: '3120', branch_num: edit.branch_num, custom_group: edit.custom_group, note: edit.note }) });
    setEdit(null); load();
  };

  return (
    <div>
      <div className="flex gap-2 mb-3 flex-wrap">
        <input placeholder="战区" value={filter.war_zone} onChange={e => setFilter({ ...filter, war_zone: e.target.value })} className="border px-2 py-1 text-sm rounded" />
        <input placeholder="区域" value={filter.region} onChange={e => setFilter({ ...filter, region: e.target.value })} className="border px-2 py-1 text-sm rounded" />
        <input placeholder="城市" value={filter.city} onChange={e => setFilter({ ...filter, city: e.target.value })} className="border px-2 py-1 text-sm rounded" />
        <input placeholder="搜索 门店号/名称" value={filter.q} onChange={e => setFilter({ ...filter, q: e.target.value })} className="border px-2 py-1 text-sm rounded flex-1 min-w-[160px]" />
        <button onClick={() => { setPage(1); load(); }} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">查询</button>
      </div>
      <table className="w-full text-sm border-collapse">
        <thead><tr className="bg-gray-100">{['门店号', '名称', '区域', '战区', '城市', '启用', '分组(ext)', '备注(ext)', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {data.map((r: any) => (
            <tr key={r.branch_num}>
              <td className="border p-2">{r.branch_num}</td>
              <td className="border p-2">{r.branch_name}</td>
              <td className="border p-2">{r.region_name}</td>
              <td className="border p-2">{r.war_zone || <span className="text-red-600">⚠ 未映射</span>}</td>
              <td className="border p-2">{r.city}</td>
              <td className="border p-2">{r.is_active ? '✅' : '❌'}</td>
              <td className="border p-2">{r.custom_group || '-'}</td>
              <td className="border p-2">{r.note || '-'}</td>
              <td className="border p-2"><button onClick={() => setEdit({ ...r })} className="text-blue-600">编辑ext</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 text-sm text-gray-600">共 {total} 条 ·
        <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-2">上一页</button>
        第 {page} 页
        <button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)} className="px-2">下一页</button>
      </div>

      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white p-4 rounded shadow w-96" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold mb-2">编辑 ext：{edit.branch_name}</h3>
            <label className="text-sm">自定义分组<input value={edit.custom_group || ''} onChange={e => setEdit({ ...edit, custom_group: e.target.value })} className="border w-full px-2 py-1 mb-2 rounded" /></label>
            <label className="text-sm">备注<input value={edit.note || ''} onChange={e => setEdit({ ...edit, note: e.target.value })} className="border w-full px-2 py-1 mb-3 rounded" /></label>
            <div className="flex gap-2 justify-end"><button onClick={() => setEdit(null)} className="px-3 py-1 text-sm">取消</button><button onClick={saveExt} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">保存</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 区域→战区映射（dim_region 行内编辑）=====
function RegionMap() {
  const [data, setData] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const load = async () => { const r = await fetch('/api/admin/regions'); const j = await r.json(); setData(j.data || []); };
  useEffect(() => { load(); }, []);
  const save = async () => {
    await fetch('/api/admin/regions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) });
    setEdit(null); load();
  };
  return (
    <div>
      <p className="text-sm text-gray-600 mb-2">改这里 → 所有该 region 的门店战区归属立即生效（报表战区维度由此算）。</p>
      <table className="w-full text-sm border-collapse">
        <thead><tr className="bg-gray-100">{['区域 region_name', '战区 war_zone', '子区域', '显示名', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {data.map((r: any) => (
            <tr key={r.region_name}>
              <td className="border p-2">{r.region_name}</td>
              <td className="border p-2">{r.war_zone || <span className="text-red-600">⚠ 待补</span>}</td>
              <td className="border p-2">{r.sub_region}</td>
              <td className="border p-2">{r.display_name}</td>
              <td className="border p-2"><button onClick={() => setEdit({ ...r })} className="text-blue-600">编辑</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white p-4 rounded shadow w-96" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold mb-2">编辑映射：{edit.region_name}</h3>
            {[['war_zone', '战区'], ['sub_region', '子区域'], ['display_name', '显示名']].map(([k, label]) => (
              <label key={k} className="text-sm">{label}<input value={edit[k] || ''} onChange={e => setEdit({ ...edit, [k]: e.target.value })} className="border w-full px-2 py-1 mb-2 rounded" /></label>
            ))}
            <div className="flex gap-2 justify-end"><button onClick={() => setEdit(null)} className="px-3 py-1 text-sm">取消</button><button onClick={save} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">保存</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 未映射预警 =====
function Unmapped() {
  const [data, setData] = useState<any[]>([]);
  const load = async () => { const r = await fetch('/api/admin/regions/unmapped'); const j = await r.json(); setData(j.data || []); };
  useEffect(() => { load(); }, []);
  return (
    <div>
      <p className="text-sm text-gray-600 mb-2">dim_branch 里有但 dim_region 没映射的区域（补上战区才能算战区报表）：</p>
      {data.length === 0 ? <p className="text-green-600">✅ 全部区域已映射</p> : (
        <table className="w-full text-sm border-collapse">
          <thead><tr className="bg-gray-100"><th className="border p-2 text-left">区域</th><th className="border p-2 text-left">门店数</th></tr></thead>
          <tbody>{data.map((r: any) => <tr key={r.region_name}><td className="border p-2">{r.region_name}</td><td className="border p-2">{r.branch_count}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
