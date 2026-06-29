"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const menuItems = [
  { id: "reports", label: "报表中心", icon: "📊" },
  { id: "sources", label: "数据源", icon: "📁" },
  { id: "settings", label: "设置", icon: "⚙️" },
];

interface SidebarProps {
  activeItem?: string;
  onItemClick?: (id: string) => void;
}

export function Sidebar({ activeItem = "reports", onItemClick }: SidebarProps) {
  return (
    <aside className="w-64 border-r bg-gray-50 min-h-[calc(100vh-64px)]">
      <nav className="p-4 space-y-2">
        {menuItems.map((item) => (
          <Button
            key={item.id}
            variant={activeItem === item.id ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start",
              activeItem === item.id && "bg-gray-200"
            )}
            onClick={() => onItemClick?.(item.id)}
          >
            <span className="mr-2">{item.icon}</span>
            {item.label}
          </Button>
        ))}
      </nav>
    </aside>
  );
}
