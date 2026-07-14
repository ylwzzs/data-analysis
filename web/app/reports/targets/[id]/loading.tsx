// web/app/reports/targets/[id]/loading.tsx
// 看板取数期间骨架（page.tsx Server Component 取数时显示，避免刷新闪空）
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl p-6 space-y-5">
      <div className="h-6 w-48 animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map(i => <div key={i} className="h-24 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />)}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 h-72 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        <div className="h-72 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
      </div>
      <div className="h-96 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
    </div>
  );
}
