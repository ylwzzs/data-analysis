import { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { LayoutDashboard, Package, Store, Target, Users, Settings } from 'lucide-react';

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const cookieStore = await cookies();
  const wecomName = cookieStore.get('wecom_name')?.value || '管理员';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/dashboard" className="font-bold text-lg">
            数据分析平台
          </Link>
          <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded">
            管理后台
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{wecomName}</span>
          <Link href="/" className="text-sm text-primary hover:underline">
            返回前台
          </Link>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-[200px] bg-white border-r min-h-[calc(100vh-57px)]">
          <nav className="p-4 space-y-2">
            <NavItem href="/admin/dashboard" icon={<LayoutDashboard size={16} />}>仪表盘</NavItem>
            <div className="pt-2">
              <NavItem href="/admin/sources" icon={<Package size={16} />}>数据源</NavItem>
              <div className="ml-6 mt-1 space-y-1">
                <SubNavItem href="/admin/sources">配置</SubNavItem>
                <SubNavItem href="/admin/sources/tasks">采集任务</SubNavItem>
                <SubNavItem href="/admin/sources/monitor">监控面板</SubNavItem>
              </div>
            </div>
            <div className="pt-2">
              <NavItem href="/admin/branches" icon={<Store size={16} />}>门店维护</NavItem>
            </div>
            <div className="pt-2">
              <NavItem href="/admin/targets" icon={<Target size={16} />}>目标管理</NavItem>
            </div>
            <div className="pt-4 border-t">
              <NavItem href="#" icon={<Users size={16} />} disabled>用户管理</NavItem>
              <NavItem href="#" icon={<Settings size={16} />} disabled>系统设置</NavItem>
            </div>
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

function NavItem({ href, icon, children, disabled }: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 cursor-not-allowed">
        {icon}
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded">
      {icon}
      {children}
    </Link>
  );
}

function SubNavItem({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="block px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded">
      {children}
    </Link>
  );
}
