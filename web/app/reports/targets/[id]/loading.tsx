// web/app/reports/targets/[id]/loading.tsx
// 看板取数期间骨架，按 cookie device_type 分移动/PC 骨架（避免移动端取数时闪 PC 骨架）
import { cookies } from "next/headers";

export default async function Loading() {
  const device = (await cookies()).get("device_type")?.value;
  if (device === "mobile") {
    return (
      <div className="mx-auto max-w-md p-3 space-y-3">
        <div className="h-5 w-28 animate-pulse rounded bg-slate-200" />
        <div className="grid grid-cols-2 gap-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
          ))}
        </div>
        <div className="h-48 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        <div className="h-48 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-7xl p-6 space-y-5">
      <div className="h-6 w-48 animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 h-72 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        <div className="h-72 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
      </div>
      <div className="h-96 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
    </div>
  );
}
