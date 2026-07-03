// web/app/admin/collect-tasks/page.tsx
'use client';

import { useState, useEffect } from 'react';

interface CollectTask {
  id: string;
  name: string;
  source_id: string;
  function_slug: string;
  schedule_cron: string;
  enabled: boolean;
  storage_type: string;
  storage_path: string;
  last_run_at: string;
  next_run_at: string;
  params: any;
  data_sources: { name: string; auth_type: string } | null;
  collect_logs?: Array<{
    status: string;
    started_at: string;
    rows_collected: number;
    error_message: string;
  }>;
}

export default function CollectTasksPage() {
  const [tasks, setTasks] = useState<CollectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [sources, setSources] = useState<any[]>([]);

  useEffect(() => {
    fetchTasks();
    fetchSources();
  }, []);

  async function fetchTasks() {
    try {
      const res = await fetch('/api/admin/collect-tasks');
      const { data } = await res.json();
      setTasks(data || []);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
    }
  }

  async function fetchSources() {
    try {
      const res = await fetch('/api/admin/data-sources');
      const { data } = await res.json();
      setSources(data || []);
    } catch (error) {
      console.error('Failed to fetch sources:', error);
    }
  }

  async function toggleEnabled(task: CollectTask) {
    await fetch(`/api/admin/collect-tasks?id=${task.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !task.enabled })
    });

    fetchTasks();
  }

  async function runNow(task: CollectTask) {
    if (!confirm('确定立即执行此任务？')) return;

    const res = await fetch(`/api/admin/collect-tasks?id=${task.id}`, { method: 'PATCH' });
    const result = await res.json();

    if (result.success) {
      alert(`任务执行成功，采集 ${result.rows_collected} 条数据`);
    } else {
      alert(`任务执行失败: ${result.error}`);
    }

    fetchTasks();
  }

  async function deleteTask(id: string) {
    if (!confirm('确定删除此任务？')) return;

    await fetch(`/api/admin/collect-tasks?id=${id}`, { method: 'DELETE' });
    fetchTasks();
  }

  function formatCron(cron: string) {
    const cronMap: Record<string, string> = {
      '0 * * * *': '每小时',
      '0 */6 * * *': '每 6 小时',
      '0 2 * * *': '每天凌晨 2 点',
      '0 2 * * 1': '每周一凌晨 2 点'
    };
    return cronMap[cron] || cron;
  }

  function getLastStatus(task: CollectTask) {
    if (!task.collect_logs || task.collect_logs.length === 0) {
      return { text: '未执行', color: 'text-gray-400' };
    }

    const lastLog = task.collect_logs[0];
    if (lastLog.status === 'success') {
      return { text: `成功 ${lastLog.rows_collected}条`, color: 'text-green-600' };
    } else if (lastLog.status === 'running') {
      return { text: '运行中', color: 'text-blue-600' };
    } else {
      return { text: '失败', color: 'text-red-600' };
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">采集任务管理</h1>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition"
        >
          新建任务
        </button>
      </div>

      {loading ? (
        <div className="text-center py-10 text-gray-500">加载中...</div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-10 text-gray-500">
          暂无采集任务，点击上方按钮创建
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">任务名称</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">数据源</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">频率</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">状态</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">最近执行</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">下次执行</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {tasks.map((task) => {
                const status = getLastStatus(task);
                return (
                  <tr key={task.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{task.name}</td>
                    <td className="px-4 py-3 text-sm">{task.data_sources?.name || '-'}</td>
                    <td className="px-4 py-3 text-sm">{formatCron(task.schedule_cron)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${
                        task.enabled ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {task.enabled ? '启用' : '禁用'}
                      </span>
                    </td>
                    <td className={`px-4 py-3 text-sm ${status.color}`}>
                      {status.text}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {task.next_run_at ? new Date(task.next_run_at).toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-3 space-x-2">
                      <button
                        onClick={() => runNow(task)}
                        className="text-blue-500 hover:underline text-sm"
                        disabled={!task.enabled}
                      >
                        立即执行
                      </button>
                      <button
                        onClick={() => toggleEnabled(task)}
                        className="text-gray-500 hover:underline text-sm"
                      >
                        {task.enabled ? '禁用' : '启用'}
                      </button>
                      <button
                        onClick={() => deleteTask(task.id)}
                        className="text-red-500 hover:underline text-sm"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 新建任务弹窗 */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold mb-4">新建采集任务</h2>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const formData = new FormData(e.target);

              await fetch('/api/admin/collect-tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  name: formData.get('name'),
                  source_id: formData.get('source_id'),
                  function_slug: formData.get('function_slug'),
                  schedule_cron: formData.get('schedule_cron'),
                  storage_type: formData.get('storage_type'),
                  storage_path: formData.get('storage_path')
                })
              });

              setShowModal(false);
              fetchTasks();
            }}>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">任务名称</label>
                <input name="name" className="w-full border rounded px-3 py-2" required />
              </div>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">数据源</label>
                <select name="source_id" className="w-full border rounded px-3 py-2" required>
                  {sources.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">Function Slug</label>
                <input name="function_slug" className="w-full border rounded px-3 py-2" required placeholder="collect-lemeng" />
              </div>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">执行频率</label>
                <select name="schedule_cron" className="w-full border rounded px-3 py-2">
                  <option value="0 * * * *">每小时</option>
                  <option value="0 */6 * * *">每 6 小时</option>
                  <option value="0 2 * * *">每天凌晨 2 点</option>
                  <option value="0 2 * * 1">每周一凌晨 2 点</option>
                </select>
              </div>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">存储类型</label>
                <select name="storage_type" className="w-full border rounded px-3 py-2">
                  <option value="oos">天翼云 OOS</option>
                  <option value="postgresql">PostgreSQL</option>
                </select>
              </div>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">存储路径</label>
                <input name="storage_path" className="w-full border rounded px-3 py-2" required placeholder="lemeng/sales/*.parquet" />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                  创建
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}