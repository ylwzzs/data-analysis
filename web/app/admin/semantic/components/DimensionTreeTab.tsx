'use client';
import { useState, useEffect, type JSX } from 'react';

type Dim = {
  dim_code: string;
  name: string;
  join_table: string;
  join_key: string;
  is_assessed_filter: boolean;
  enabled: boolean;
};
type Level = {
  dim_code: string;
  level_code: string;
  level_name: string;
  depth: number;
  key_column: string;
  name_column: string;
  parent_level: string | null;
};

export default function DimensionTreeTab() {
  const [dims, setDims] = useState<Dim[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/admin/semantic/dimensions')
      .then((r) => r.json())
      .then((j) => {
        setDims(j.dimensions || []);
        setLevels(j.levels || []);
      });
  }, []);

  const treeOf = (dimCode: string) => {
    const ls = levels.filter((l) => l.dim_code === dimCode);
    const childrenOf = (parent: string | null) =>
      ls.filter((l) => l.parent_level === parent);
    const render = (parent: string | null, depth: number): JSX.Element[] =>
      childrenOf(parent).map((l) => {
        const key = `${dimCode}/${l.level_code}`;
        const isCollapsed = collapsed.has(key);
        const kids = render(l.level_code, depth + 1);
        return (
          <li key={key}>
            <div className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 16 }}>
              {kids.length > 0 ? (
                <button
                  onClick={() => {
                    const s = new Set(collapsed);
                    s.has(key) ? s.delete(key) : s.add(key);
                    setCollapsed(s);
                  }}
                  className="text-xs w-4"
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
              ) : (
                <span className="w-4" />
              )}
              <span className="font-medium">{l.level_name}</span>
              <span className="text-xs text-gray-400 font-mono">{l.level_code}</span>
              <span className="text-xs text-gray-500">
                键:{l.key_column} 名:{l.name_column}
              </span>
            </div>
            {!isCollapsed && kids.length > 0 && <ul>{kids}</ul>}
          </li>
        );
      });
    return render(null, 0);
  };

  return (
    <div className="space-y-6">
      {dims.map((d) => (
        <div key={d.dim_code}>
          <h3 className="font-bold mb-2">
            {d.name} <span className="text-xs text-gray-400 font-mono">{d.dim_code}</span>
          </h3>
          <div className="text-xs text-gray-500 mb-1">
            维表:{d.join_table} · JOIN键:{d.join_key} {d.is_assessed_filter ? '· 考核白名单' : ''}
          </div>
          <ul className="text-sm">{treeOf(d.dim_code)}</ul>
        </div>
      ))}
    </div>
  );
}
