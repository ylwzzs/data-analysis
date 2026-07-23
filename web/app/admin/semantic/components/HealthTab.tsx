'use client';
import { useState, useEffect } from 'react';

type DiffCol = { name: string; maxValue: number };
type Audit = {
  view: string;
  diffColumns: DiffCol[];
  status: 'ok' | 'warn';
  totals: Record<string, number>;
};

const viewName = (v: string) => v.replace(/^report_/, '').replace(/_v_audit$/, '');

export default function HealthTab() {
  const [audits, setAudits] = useState<Audit[]>([]);
  const [validations, setValidations] = useState<{ issue: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/semantic/health')
      .then((r) => r.json())
      .then((j) => {
        setAudits(j.audits || []);
        setValidations(j.validations || []);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="text-gray-400 text-sm">加载中…</div>;

  const auditBad = audits.filter((a) => a.status === 'warn').length;
  const valBad = validations.length;

  return (
    <div className="space-y-6">
      <div className="flex gap-4 text-sm">
        <span
          className={`px-3 py-1 rounded ${auditBad === 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
        >
          {auditBad === 0
            ? `✓ ${audits.length} 个视图 rollup 一致`
            : `✗ ${auditBad}/${audits.length} 个视图 rollup 异常`}
        </span>
        <span
          className={`px-3 py-1 rounded ${valBad === 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
        >
          {valBad === 0 ? '✓ 配置校验通过' : `✗ ${valBad} 项配置异常`}
        </span>
      </div>

      <div>
        <h3 className="font-bold mb-2">Rollup 自校验</h3>
        {audits.length === 0 ? (
          <p className="text-sm text-gray-400">暂无生成视图</p>
        ) : (
          <table className="w-full text-sm border">
            <thead className="bg-gray-50">
              <tr className="text-left">
                <th className="px-2 py-1">视图</th>
                <th className="px-2 py-1">差异列（最大偏差）</th>
                <th className="px-2 py-1">状态</th>
              </tr>
            </thead>
            <tbody>
              {audits.map((a) => (
                <tr key={a.view} className="border-t">
                  <td className="px-2 py-1 font-mono">{viewName(a.view)}</td>
                  <td className="px-2 py-1 tabular-nums">
                    {a.diffColumns.map((d) => (
                      <span
                        key={d.name}
                        className={`mr-3 ${d.maxValue < 0.01 ? 'text-gray-500' : 'text-red-600 font-bold'}`}
                      >
                        {d.name.replace(/_diff$/, '').replace(/_/g, ' ')}: {d.maxValue.toFixed(2)}
                      </span>
                    ))}
                  </td>
                  <td className="px-2 py-1">{a.status === 'ok' ? '🟢' : '🔴'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h3 className="font-bold mb-2">配置校验（validate_semantic_registry）</h3>
        {valBad === 0 ? (
          <p className="text-sm text-green-700">✓ 全部通过</p>
        ) : (
          <ul className="text-sm space-y-1">
            {validations.map((v, i) => (
              <li key={i} className="text-red-600">✗ {v.issue}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
