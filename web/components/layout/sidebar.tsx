"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const menuItems = [
  { id: "reports", label: "报表中心", icon: "📊", href: "/" },
  { id: "settings", label: "设置", icon: "⚙️", href: "/settings" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r bg-gray-50 min-h-[calc(100vh-64px)]">
      <nav className="p-4 space-y-2">
        {menuItems.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                "flex w-full items-center justify-start rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-gray-200 text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <span className="mr-2">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
