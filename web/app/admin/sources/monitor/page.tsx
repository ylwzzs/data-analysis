// web/app/admin/collect-monitor/page.tsx
'use client';

import { useState, useEffect } from 'react';

interface Log {
  id: string;
  task_id: string;
  status: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  rows_collected: number;
  error_message: string;
  collect_tasks: {
    name: string;
    data_sources: { name: string };
  };
}

export default function CollectMonitorPage() {
  const [stats, setStats] = useState({
    total: 0,
    enabled: 0,
    disabled: 0,
    success_today: 0,
    failed_today: 0
  });
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchData() {
    try {
      // 获取统计数据
      const statsRes = await fetch('/api/admin/collect-stats');
      const statsData = await statsRes.json();
      setStats(statsData);

      // 获取最近日志
      const logsRes = await fetch('/api/admin/collect-logs?limit=20');
      const logsData = await logsRes.json();
      setLogs(logsData.data || []);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  }




  function formatDuration(ms: number) {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">采集监控</h1>

      {loading ? (
        <div className="text-center py-10 text-gray-500">加载中...</div>
      ) : (
        <>
          {/* 统计卡片 */}
          <div className="grid grid-cols-5 gap-4 mb-6">
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-gray-800">{stats.total}</div>
              <div className="text-sm text-gray-500">总任务数</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-green-600">{stats.enabled}</div>
              <div className="text-sm text-gray-500">启用</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-gray-400">{stats.disabled}</div>
              <div className="text-sm text-gray-500">禁用</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-green-500">{stats.success_today}</div>
              <div className="text-sm text-gray-500">今日成功</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-red-500">{stats.failed_today}</div>
              <div className="text-sm text-gray-500">今日失败</div>
            </div>
          </div>

          {/* 最近执行记录 */}
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b font-bold">最近执行记录</div>
            {logs.length === 0 ? (
              <div className="p-10 text-center text-gray-500">暂无执行记录</div>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">任务</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">数据源</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">状态</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">开始时间</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">耗时</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">采集数量</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">错误信息</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">{log.collect_tasks?.name || '-'}</td>
                      <td className="px-4 py-3 text-sm">{log.collect_tasks?.data_sources?.name || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs ${
                          log.status === 'success' ? 'bg-green-50 text-green-600' :
                          log.status === 'running' ? 'bg-blue-50 text-blue-600' :
                          'bg-red-50 text-red-600'
                        }`}>
                          {log.status === 'success' ? '成功' :
                           log.status === 'running' ? '运行中' : '失败'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {new Date(log.started_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm">{formatDuration(log.duration_ms)}</td>
                      <td className="px-4 py-3 text-sm">{log.rows_collected || 0}</td>
                      <td className="px-4 py-3 text-sm text-red-600">
                        {log.error_message || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}