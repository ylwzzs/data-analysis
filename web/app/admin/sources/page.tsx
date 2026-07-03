// web/app/admin/data-sources/page.tsx
'use client';

import { useState, useEffect } from 'react';

interface DataSource {
  id: string;
  name: string;
  description: string;
  api_endpoint?: string;
  auth_type: string;
  auth_config: any;
  enabled?: boolean;
  auth_credentials: {
    expires_at: string;
    last_updated: string;
  } | null;
}

export default function DataSourcesPage() {
  const [sources, setSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingSource, setEditingSource] = useState<DataSource | null>(null);

  useEffect(() => {
    fetchSources();
  }, []);

  async function fetchSources() {
    try {
      const res = await fetch('/api/admin/data-sources');
      const { data } = await res.json();
      setSources(data || []);
    } catch (error) {
      console.error('Failed to fetch data sources:', error);
    } finally {
      setLoading(false);
    }
  }

  function getCredentialStatus(source: DataSource) {
    if (!source.auth_credentials) {
      return { text: '未配置', color: 'text-gray-500', bg: 'bg-gray-100' };
    }

    if (source.auth_credentials.expires_at) {
      const expiresAt = new Date(source.auth_credentials.expires_at);
      const now = new Date();
      const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

      if (daysLeft <= 0) {
        return { text: '已过期', color: 'text-red-600', bg: 'bg-red-50' };
      } else if (daysLeft <= 3) {
        return { text: `${daysLeft}天后过期`, color: 'text-yellow-600', bg: 'bg-yellow-50' };
      }
    }

    return { text: '已配置', color: 'text-green-600', bg: 'bg-green-50' };
  }

  async function deleteSource(id: string) {
    if (!confirm('确定删除此数据源？')) return;

    await fetch(`/api/admin/data-sources?id=${id}`, { method: 'DELETE' });
    fetchSources();
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">数据源管理</h1>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition"
        >
          新建数据源
        </button>
      </div>

      {loading ? (
        <div className="text-center py-10 text-gray-500">加载中...</div>
      ) : sources.length === 0 ? (
        <div className="text-center py-10 text-gray-500">
          暂无数据源，点击上方按钮创建
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">名称</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">鉴权类型</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">凭证状态</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">描述</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sources.map((source) => {
                const status = getCredentialStatus(source);
                return (
                  <tr key={source.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{source.name}</td>
                    <td className="px-4 py-3 text-sm">{source.auth_type}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${status.bg} ${status.color}`}>
                        {status.text}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">{source.description || '-'}</td>
                    <td className="px-4 py-3 space-x-2">
                      <button
                        onClick={() => setEditingSource(source)}
                        className="text-blue-500 hover:underline text-sm"
                      >
                        配置凭证
                      </button>
                      <button
                        onClick={() => deleteSource(source.id)}
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

      {/* 新建数据源弹窗 */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold mb-4">新建数据源</h2>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const formData = new FormData(e.target);
              const body = Object.fromEntries(formData.entries());

              await fetch('/api/admin/data-sources', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  ...body,
                  auth_config: { fields: [{ name: 'token', expire_days: 5 }] }
                })
              });

              setShowModal(false);
              fetchSources();
            }}>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">名称</label>
                <input name="name" className="w-full border rounded px-3 py-2" required />
              </div>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">鉴权类型</label>
                <select name="auth_type" className="w-full border rounded px-3 py-2">
                  <option value="token">Token</option>
                  <option value="api_key">API Key</option>
                  <option value="oauth">OAuth</option>
                  <option value="basic">Basic Auth</option>
                  <option value="none">无鉴权</option>
                </select>
              </div>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">描述</label>
                <textarea name="description" className="w-full border rounded px-3 py-2" rows={2} />
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

      {/* 配置凭证弹窗 */}
      {editingSource && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold mb-2">配置凭证</h2>
            <p className="text-sm text-gray-500 mb-4">
              数据源: {editingSource.name} ({editingSource.auth_type})
            </p>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const formData = new FormData(e.target);
              const credentials: Record<string, string> = {};
              formData.forEach((value, key) => {
                credentials[key] = value.toString();
              });

              await fetch(`/api/admin/data-sources/${editingSource.id}/credentials`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  credentials,
                  expires_at: formData.get('expires_at') || null
                })
              });

              setEditingSource(null);
              fetchSources();
            }}>
              {editingSource.auth_type === 'token' && (
                <>
                  <div className="mb-4">
                    <label className="block text-sm font-medium mb-1">Token</label>
                    <input name="token" className="w-full border rounded px-3 py-2" required />
                  </div>
                  <div className="mb-4">
                    <label className="block text-sm font-medium mb-1">过期时间</label>
                    <input name="expires_at" type="date" className="w-full border rounded px-3 py-2" />
                  </div>
                </>
              )}
              {editingSource.auth_type === 'api_key' && (
                <>
                  <div className="mb-4">
                    <label className="block text-sm font-medium mb-1">App ID</label>
                    <input name="app_id" className="w-full border rounded px-3 py-2" required />
                  </div>
                  <div className="mb-4">
                    <label className="block text-sm font-medium mb-1">App Secret</label>
                    <input name="app_secret" type="password" className="w-full border rounded px-3 py-2" required />
                  </div>
                </>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingSource(null)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
                >
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}