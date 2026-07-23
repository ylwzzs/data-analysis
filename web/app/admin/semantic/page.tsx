'use client';
import { useState } from 'react';
import DictionaryTab from './components/DictionaryTab';
import HealthTab from './components/HealthTab';
import DimensionTreeTab from './components/DimensionTreeTab';
import MetricGraphTab from './components/MetricGraphTab';

const TABS = [
  { key: 'dict', label: '字典' },
  { key: 'health', label: '健康' },
  { key: 'tree', label: '维度层级' },
  { key: 'graph', label: '依赖图' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function SemanticPage() {
  const [tab, setTab] = useState<TabKey>('dict');
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-4">语义层</h1>
      <div className="flex gap-1 border-b mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm rounded-t ${tab === t.key ? 'bg-primary text-white' : 'text-gray-600 hover:bg-gray-100'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'dict' && <DictionaryTab />}
      {tab === 'health' && <HealthTab />}
      {tab === 'tree' && <DimensionTreeTab />}
      {tab === 'graph' && <MetricGraphTab />}
    </div>
  );
}
