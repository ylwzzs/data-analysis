// web/app/reports/targets/[id]/loading.tsx
// 看板取数期间骨架（page.tsx Server Component 取数时显示）
// 响应式：移动端 max-w-md 单列/2列，PC max-w-7xl 4列/3列（同一文件 md 断点自适应，避免移动闪PC骨架）
export default function Loading() {
  return (
    <div className="mx-auto max-w-md md:max-w-7xl p-3 md:p-6 space-y-3 md:space-y-5">
      <div className="h-5 w-28 md:h-6 md:w-48 animate-pulse rounded bg-slate-200" />
      {/* KPI 卡：移动2列，PC4列 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 md:h-24 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        ))}
      </div>
      {/* 趋势+排行：移动单列，PC 2:1 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
        <div className="md:col-span-2 h-48 md:h-72 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        <div className="h-48 md:h-72 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
      </div>
      {/* 交叉表 */}
      <div className="h-64 md:h-96 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
    </div>
  );
}
