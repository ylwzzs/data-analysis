'use client';
import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, type Node, type Edge, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

type NodeData = {
  id: string;
  name: string;
  measure_type: string;
  formula: string | null;
  additive: boolean;
  cost_sensitive: boolean;
};

export default function MetricGraphTab() {
  const [nodes0, setNodes] = useState<NodeData[]>([]);
  const [edges0, setEdges] = useState<{ source: string; target: string }[]>([]);
  const [hl, setHl] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/admin/semantic/metrics')
      .then((r) => r.json())
      .then((j) => {
        setNodes(j.nodes || []);
        setEdges(j.edges || []);
      });
  }, []);

  const rfNodes: Node[] = useMemo(() => {
    const bases = nodes0.filter((n) => n.measure_type === 'base');
    const derived = nodes0.filter((n) => n.measure_type === 'derived');
    const mk = (n: NodeData, x: number, y: number): Node => ({
      id: n.id,
      position: { x, y },
      data: {
        label: (
          <div
            className={`px-2 py-1 rounded text-xs ${n.measure_type === 'base' ? 'bg-blue-600 text-white' : 'bg-amber-500 text-white'}`}
          >
            <div className="font-bold">{n.name}</div>
            <div className="opacity-75 font-mono">
              {n.id}
              {n.cost_sensitive ? ' · 成本' : ''}
            </div>
          </div>
        ),
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });
    const baseNodes = bases.map((n, i) => mk(n, 0, i * 70));
    const derivedNodes = derived.map((n, i) => mk(n, 420, i * 70));
    return [...baseNodes, ...derivedNodes];
  }, [nodes0]);

  const rfEdges: Edge[] = edges0.map((e, i) => ({
    id: `e${i}`,
    source: e.source,
    target: e.target,
    animated: true,
  }));

  const onNodeClick = (_: unknown, node: Node) => {
    const chain = new Set<string>([node.id]);
    const visitUp = (id: string) =>
      edges0
        .filter((e) => e.source === id)
        .forEach((e) => {
          if (!chain.has(e.target)) {
            chain.add(e.target);
            visitUp(e.target);
          }
        });
    const visitDown = (id: string) =>
      edges0
        .filter((e) => e.target === id)
        .forEach((e) => {
          if (!chain.has(e.source)) {
            chain.add(e.source);
            visitDown(e.source);
          }
        });
    visitUp(node.id);
    visitDown(node.id);
    setHl(chain);
  };

  const opacityOf = (id: string) => (hl.size > 0 && !hl.has(id) ? 0.25 : 1);
  const rfNodesStyled = rfNodes.map((n) => ({ ...n, style: { opacity: opacityOf(n.id) } }));

  return (
    <div style={{ height: 500 }}>
      <ReactFlow nodes={rfNodesStyled} edges={rfEdges} onNodeClick={onNodeClick} fitView>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      <p className="text-xs text-gray-500 mt-2">
        蓝=base（事实表聚合），琥珀=derived（运算）。点击节点高亮依赖链。
      </p>
    </div>
  );
}
