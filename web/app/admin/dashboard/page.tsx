import Link from 'next/link';

interface CollectStats {
  total: number;
  enabled: number;
  successToday: number;
  failedToday: number;
}

async function getCollectStats(): Promise<CollectStats> {
  const defaultStats: CollectStats = { total: 0, enabled: 0, successToday: 0, failedToday: 0 };

  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_INSFORGE_URL}/api/admin/collect-stats`, {
      headers: {
        'Authorization': `Bearer ${process.env.INSFORGE_API_KEY}`,
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      console.error('Failed to fetch stats:', res.status);
      return defaultStats;
    }

    return await res.json();
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    return defaultStats;
  }
}

export default async function AdminDashboard() {
  const stats = await getCollectStats();
  const unconfigured = stats.total - stats.enabled;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">管理仪表盘</h1>

      {/* 数据源状态 */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-lg p-6 shadow-sm">
          <div className="text-3xl font-bold text-green-600">{stats.enabled}</div>
          <div className="text-sm text-gray-500 mt-1">数据源正常</div>
        </div>
        <div className="bg-white rounded-lg p-6 shadow-sm">
          <div className="text-3xl font-bold text-yellow-600">0</div>
          <div className="text-sm text-gray-500 mt-1">数据源告警</div>
        </div>
        <div className="bg-white rounded-lg p-6 shadow-sm">
          <div className="text-3xl font-bold text-gray-400">{unconfigured}</div>
          <div className="text-sm text-gray-500 mt-1">未配置凭证</div>
        </div>
      </div>

      {/* 今日采集 */}
      <div className="bg-white rounded-lg p-6 shadow-sm mb-8">
        <h2 className="font-bold mb-4">今日采集</h2>
        <div className="flex gap-8">
          <div>
            <span className="text-2xl font-bold text-green-600">{stats.successToday}</span>
            <span className="text-sm text-gray-500 ml-2">成功</span>
          </div>
          <div>
            <span className="text-2xl font-bold text-red-600">{stats.failedToday}</span>
            <span className="text-sm text-gray-500 ml-2">失败</span>
          </div>
        </div>
      </div>

      {/* 快捷入口 */}
      <div className="grid grid-cols-3 gap-4">
        <Link
          href="/admin/sources"
          className="bg-white rounded-lg p-6 shadow-sm hover:shadow-md transition border border-transparent hover:border-blue-200"
        >
          <div className="text-2xl mb-2">📦</div>
          <div className="font-bold">数据源配置</div>
          <div className="text-sm text-gray-500 mt-1">管理数据源和凭证</div>
        </Link>
        <Link
          href="/admin/sources/tasks"
          className="bg-white rounded-lg p-6 shadow-sm hover:shadow-md transition border border-transparent hover:border-blue-200"
        >
          <div className="text-2xl mb-2">⚡</div>
          <div className="font-bold">采集任务</div>
          <div className="text-sm text-gray-500 mt-1">配置采集频率</div>
        </Link>
        <Link
          href="/admin/sources/monitor"
          className="bg-white rounded-lg p-6 shadow-sm hover:shadow-md transition border border-transparent hover:border-blue-200"
        >
          <div className="text-2xl mb-2">📈</div>
          <div className="font-bold">监控面板</div>
          <div className="text-sm text-gray-500 mt-1">查看执行日志</div>
        </Link>
      </div>
    </div>
  );
}