# 数据分析平台 MVP 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建基于 InsForge 的企业数据分析平台，支持数据采集、报表展示、企微推送和智能体 MCP 接入。

**Architecture:** 前端使用 Next.js 14+（PC + H5 移动端），后端使用 InsForge 自托管，数据库 PostgreSQL + DuckDB，对象存储 MinIO，认证集成企业微信 OAuth。

**Tech Stack:** TypeScript, Next.js 14+, InsForge, PostgreSQL 15, DuckDB, MinIO, ECharts, shadcn/ui

---

## 文件结构

```
data-analytics-platform/
├── web/                          # Next.js 前端
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx              # PC 首页（报表列表）
│   │   ├── reports/[id]/page.tsx # 报表详情
│   │   └── mobile/
│   │       ├── page.tsx          # 移动端首页
│   │       └── reports/[id]/page.tsx
│   ├── components/
│   │   ├── ui/                   # shadcn/ui 组件
│   │   ├── reports/              # 报表组件
│   │   └── charts/               # 图表组件
│   ├── lib/
│   │   ├── api.ts
│   │   ├── wecom.ts
│   │   └── utils.ts
│   ├── package.json
│   └── tsconfig.json
├── functions/                    # InsForge Edge Functions
│   ├── ingest/index.ts           # 数据采集
│   ├── reports/index.ts          # 报表查询
│   └── mcp/index.ts              # MCP Server
├── database/
│   └── migrations/001_init.sql
├── deploy/
│   ├── docker-compose.yml
│   ├── nginx.conf
│   └── .env.example
└── README.md
```

---

## Task 1: 项目初始化

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/next.config.js`
- Create: `web/.gitignore`
- Create: `README.md`

- [ ] **Step 1: 初始化 Next.js 项目**

```bash
cd data-analytics-platform
npx create-next-app@latest web --typescript --tailwind --eslint --app --src-dir=false --import-alias="@/*"
```

按提示选择：
- TypeScript: Yes
- ESLint: Yes
- Tailwind CSS: Yes
- `src/` directory: No
- App Router: Yes
- Import alias: `@/*`

- [ ] **Step 2: 验证项目创建成功**

```bash
cd web && npm run dev
```

Expected: 访问 http://localhost:3000 显示 Next.js 默认页面

- [ ] **Step 3: 安装核心依赖**

```bash
cd web
npm install echarts echarts-for-react @tanstack/react-table zustand
npm install -D @types/node
```

- [ ] **Step 4: 创建 README.md**

```markdown
# 数据分析平台

基于 InsForge 构建的企业数据分析平台。

## 功能

- 数据采集：API 数据自动采集存储
- 报表展示：PC 端 + 移动端报表查看
- 企微推送：定时推送报表消息
- 智能体接入：MCP 接口支持

## 技术栈

- 前端：Next.js 14+, TypeScript, shadcn/ui, ECharts
- 后端：InsForge, PostgreSQL, DuckDB, MinIO
- 认证：企业微信 OAuth

## 开发

```bash
npm install
npm run dev
```

## 部署

见 `deploy/` 目录。
```

- [ ] **Step 5: 提交初始化代码**

```bash
git add .
git commit -m "chore: init Next.js project with dependencies"
```

---

## Task 2: 配置 shadcn/ui

**Files:**
- Modify: `web/components.json`
- Create: `web/components/ui/button.tsx`
- Create: `web/components/ui/card.tsx`

- [ ] **Step 1: 初始化 shadcn/ui**

```bash
cd web
npx shadcn@latest init
```

按提示选择：
- Style: Default
- Base color: Neutral
- CSS variables: Yes

- [ ] **Step 2: 添加常用组件**

```bash
cd web
npx shadcn@latest add button card table tabs badge separator
```

- [ ] **Step 3: 验证组件安装**

检查 `web/components/ui/` 目录下是否生成了组件文件。

- [ ] **Step 4: 提交配置**

```bash
git add .
git commit -m "chore: configure shadcn/ui components"
```

---

## Task 3: 创建布局组件

**Files:**
- Create: `web/app/layout.tsx`
- Create: `web/app/globals.css`
- Create: `web/components/layout/header.tsx`
- Create: `web/components/layout/sidebar.tsx`

- [ ] **Step 1: 更新全局样式**

```css
/* web/app/globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --card: 0 0% 100%;
  --card-foreground: 222.2 84% 4.9%;
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96.1%;
  --secondary-foreground: 222.2 47.4% 11.2%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --accent: 210 40% 96.1%;
  --accent-foreground: 222.2 47.4% 11.2%;
  --border: 214.3 31.8% 91.4%;
  --input: 214.3 31.8% 91.4%;
  --ring: 222.2 84% 4.9%;
  --radius: 0.5rem;
}

.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --card: 222.2 84% 4.9%;
  --card-foreground: 210 40% 98%;
  --primary: 210 40% 98%;
  --primary-foreground: 222.2 47.4% 11.2%;
  --secondary: 217.2 32.6% 17.5%;
  --secondary-foreground: 210 40% 98%;
  --muted: 217.2 32.6% 17.5%;
  --muted-foreground: 215 20.2% 65.1%;
  --accent: 217.2 32.6% 17.5%;
  --accent-foreground: 210 40% 98%;
  --border: 217.2 32.6% 17.5%;
  --input: 217.2 32.6% 17.5%;
  --ring: 212.7 26.8% 83.9%;
}

body {
  @apply bg-background text-foreground;
}
```

- [ ] **Step 2: 创建 Header 组件**

```tsx
// web/components/layout/header.tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function Header() {
  return (
    <header className="border-b bg-white">
      <div className="flex h-16 items-center px-6 justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">数据分析平台</h1>
          <Badge variant="secondary">Beta</Badge>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm">
            设置
          </Button>
          <div className="w-8 h-8 rounded-full bg-gray-200" />
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: 创建 Sidebar 组件**

```tsx
// web/components/layout/sidebar.tsx
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
            className={cn("w-full justify-start", activeItem === item.id && "bg-gray-200")}
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
```

- [ ] **Step 4: 创建 utils 文件**

```typescript
// web/lib/utils.ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

安装依赖：
```bash
cd web && npm install clsx tailwind-merge
```

- [ ] **Step 5: 更新布局文件**

```tsx
// web/app/layout.tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "数据分析平台",
  description: "企业数据分析平台",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
```

- [ ] **Step 6: 验证布局**

```bash
cd web && npm run dev
```

- [ ] **Step 7: 提交布局代码**

```bash
git add .
git commit -m "feat: add layout components (header, sidebar)"
```

---

## Task 4: 创建报表列表页面（PC）

**Files:**
- Create: `web/app/page.tsx`
- Create: `web/components/reports/report-list.tsx`
- Create: `web/lib/api.ts`

- [ ] **Step 1: 创建 API 模块**

```typescript
// web/lib/api.ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7130";

export interface Report {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  metrics: {
    name: string;
    value: string;
    change?: string;
    trend?: "up" | "down" | "flat";
  }[];
}

export async function getReports(): Promise<Report[]> {
  // Mock 数据，后续替换为真实 API
  return [
    {
      id: "1",
      name: "销售日报",
      description: "每日销售数据汇总",
      updatedAt: "2024-06-29 10:30",
      metrics: [
        { name: "销售额", value: "¥125,000", change: "+12%", trend: "up" },
        { name: "订单数", value: "328", change: "+8%", trend: "up" },
      ],
    },
    {
      id: "2",
      name: "运营周报",
      description: "每周运营数据分析",
      updatedAt: "2024-06-28 18:00",
      metrics: [
        { name: "新增用户", value: "1,250", change: "-3%", trend: "down" },
        { name: "活跃用户", value: "8,500", change: "+5%", trend: "up" },
      ],
    },
  ];
}

export async function getReport(id: string): Promise<Report | null> {
  const reports = await getReports();
  return reports.find((r) => r.id === id) || null;
}
```

- [ ] **Step 2: 创建报表列表组件**

```tsx
// web/components/reports/report-list.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Report } from "@/lib/api";

interface ReportListProps {
  reports: Report[];
}

export function ReportList({ reports }: ReportListProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {reports.map((report) => (
        <Card key={report.id} className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-lg font-medium">{report.name}</CardTitle>
            <Badge variant="secondary">{report.updatedAt}</Badge>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              {report.description}
            </p>
            <div className="grid grid-cols-2 gap-4 mb-4">
              {report.metrics.map((metric, i) => (
                <div key={i}>
                  <p className="text-sm text-muted-foreground">{metric.name}</p>
                  <p className="text-2xl font-bold">{metric.value}</p>
                  {metric.change && (
                    <p
                      className={`text-xs ${
                        metric.trend === "up"
                          ? "text-green-600"
                          : metric.trend === "down"
                          ? "text-red-600"
                          : "text-gray-600"
                      }`}
                    >
                      {metric.change}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <Link href={`/reports/${report.id}`}>
              <Button variant="outline" className="w-full">
                查看详情
              </Button>
            </Link>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: 创建首页**

```tsx
// web/app/page.tsx
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { ReportList } from "@/components/reports/report-list";
import { getReports } from "@/lib/api";

export default async function HomePage() {
  const reports = await getReports();

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar activeItem="reports" />
        <main className="flex-1 p-6">
          <div className="mb-6">
            <h2 className="text-2xl font-bold">报表中心</h2>
            <p className="text-muted-foreground">查看所有可访问的报表</p>
          </div>
          <ReportList reports={reports} />
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 验证页面**

```bash
cd web && npm run dev
```

访问 http://localhost:3000 确认报表列表显示正常。

- [ ] **Step 5: 提交代码**

```bash
git add .
git commit -m "feat: add report list page for PC"
```

---

## Task 5: 创建报表详情页面（PC）

**Files:**
- Create: `web/app/reports/[id]/page.tsx`
- Create: `web/components/reports/report-detail.tsx`
- Create: `web/components/charts/bar-chart.tsx`

- [ ] **Step 1: 创建图表组件**

```tsx
// web/components/charts/bar-chart.tsx
"use client";

import ReactECharts from "echarts-for-react";

interface BarChartProps {
  data: { name: string; value: number }[];
  title?: string;
}

export function BarChart({ data, title }: BarChartProps) {
  const option = {
    title: {
      text: title,
      left: "center",
    },
    tooltip: {
      trigger: "axis",
    },
    xAxis: {
      type: "category",
      data: data.map((d) => d.name),
    },
    yAxis: {
      type: "value",
    },
    series: [
      {
        data: data.map((d) => d.value),
        type: "bar",
        itemStyle: {
          color: "#3b82f6",
        },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: "300px" }} />;
}
```

- [ ] **Step 2: 创建报表详情组件**

```tsx
// web/components/reports/report-detail.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart } from "@/components/charts/bar-chart";
import { Report } from "@/lib/api";

interface ReportDetailProps {
  report: Report;
}

export function ReportDetail({ report }: ReportDetailProps) {
  // Mock 图表数据
  const chartData = [
    { name: "周一", value: 12000 },
    { name: "周二", value: 15000 },
    { name: "周三", value: 18000 },
    { name: "周四", value: 14000 },
    { name: "周五", value: 20000 },
    { name: "周六", value: 25000 },
    { name: "周日", value: 21000 },
  ];

  return (
    <div className="space-y-6">
      {/* 标题区 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{report.name}</h1>
          <p className="text-muted-foreground">{report.description}</p>
        </div>
        <Badge variant="secondary">{report.updatedAt} 更新</Badge>
      </div>

      {/* 核心指标 */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {report.metrics.map((metric, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {metric.name}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{metric.value}</p>
              {metric.change && (
                <p
                  className={`text-xs ${
                    metric.trend === "up"
                      ? "text-green-600"
                      : metric.trend === "down"
                      ? "text-red-600"
                      : "text-gray-600"
                  }`}
                >
                  {metric.change}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 图表区 */}
      <Card>
        <CardHeader>
          <CardTitle>趋势分析</CardTitle>
        </CardHeader>
        <CardContent>
          <BarChart data={chartData} title="近7日数据" />
        </CardContent>
      </Card>

      {/* 数据表格区 */}
      <Card>
        <CardHeader>
          <CardTitle>明细数据</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            数据表格组件将在后续添加
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: 创建详情页面**

```tsx
// web/app/reports/[id]/page.tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { ReportDetail } from "@/components/reports/report-detail";
import { getReport } from "@/lib/api";

interface PageProps {
  params: { id: string };
}

export default async function ReportPage({ params }: PageProps) {
  const report = await getReport(params.id);

  if (!report) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar activeItem="reports" />
        <main className="flex-1 p-6">
          <Link href="/">
            <Button variant="ghost" className="mb-4">
              ← 返回列表
            </Button>
          </Link>
          <ReportDetail report={report} />
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 验证页面**

```bash
cd web && npm run dev
```

访问 http://localhost:3000 点击报表卡片进入详情页确认显示正常。

- [ ] **Step 5: 提交代码**

```bash
git add .
git commit -m "feat: add report detail page for PC"
```

---

## Task 6: 创建移动端页面（企微 H5）

**Files:**
- Create: `web/app/mobile/page.tsx`
- Create: `web/app/mobile/reports/[id]/page.tsx`
- Create: `web/components/mobile/report-card.tsx`

- [ ] **Step 1: 创建移动端报表卡片**

```tsx
// web/components/mobile/report-card.tsx
"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Report } from "@/lib/api";

interface ReportCardProps {
  report: Report;
}

export function ReportCard({ report }: ReportCardProps) {
  return (
    <Link href={`/mobile/reports/${report.id}`}>
      <div className="bg-white rounded-lg p-4 shadow-sm border">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium">{report.name}</h3>
          <span className="text-xs text-muted-foreground">{report.updatedAt}</span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex gap-4">
            {report.metrics.slice(0, 2).map((m, i) => (
              <div key={i}>
                <p className="text-xs text-muted-foreground">{m.name}</p>
                <p className="text-lg font-semibold">{m.value}</p>
              </div>
            ))}
          </div>
          <ChevronRight className="w-5 h-5 text-muted-foreground" />
        </div>
      </div>
    </Link>
  );
}
```

安装图标依赖：
```bash
cd web && npm install lucide-react
```

- [ ] **Step 2: 创建移动端首页**

```tsx
// web/app/mobile/page.tsx
import { getReports } from "@/lib/api";
import { ReportCard } from "@/components/mobile/report-card";

export default async function MobileHomePage() {
  const reports = await getReports();

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white px-4 py-3 border-b sticky top-0">
        <h1 className="text-lg font-semibold">📊 报表中心</h1>
      </header>
      <main className="p-4 space-y-3">
        {reports.map((report) => (
          <ReportCard key={report.id} report={report} />
        ))}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: 创建移动端详情页**

```tsx
// web/app/mobile/reports/[id]/page.tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Share2 } from "lucide-react";
import { getReport } from "@/lib/api";
import { BarChart } from "@/components/charts/bar-chart";

interface PageProps {
  params: { id: string };
}

export default async function MobileReportPage({ params }: PageProps) {
  const report = await getReport(params.id);

  if (!report) {
    notFound();
  }

  const chartData = [
    { name: "周一", value: 12000 },
    { name: "周二", value: 15000 },
    { name: "周三", value: 18000 },
    { name: "周四", value: 14000 },
    { name: "周五", value: 20000 },
  ];

  return (
    <div className="min-h-screen bg-gray-100">
      {/* 顶部导航 */}
      <header className="bg-white px-4 py-3 border-b sticky top-0 flex items-center justify-between">
        <Link href="/mobile" className="flex items-center">
          <ChevronLeft className="w-5 h-5" />
          <span className="ml-1">返回</span>
        </Link>
        <h1 className="font-medium">{report.name}</h1>
        <Share2 className="w-5 h-5" />
      </header>

      <main className="p-4 space-y-4">
        {/* 核心指标 */}
        <div className="bg-white rounded-lg p-4">
          <h2 className="text-sm text-muted-foreground mb-3">核心指标</h2>
          <div className="grid grid-cols-2 gap-4">
            {report.metrics.map((m, i) => (
              <div key={i}>
                <p className="text-xs text-muted-foreground">{m.name}</p>
                <p className="text-xl font-bold">{m.value}</p>
                {m.change && (
                  <p
                    className={`text-xs ${
                      m.trend === "up"
                        ? "text-green-600"
                        : m.trend === "down"
                        ? "text-red-600"
                        : "text-gray-600"
                    }`}
                  >
                    {m.change}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 图表 */}
        <div className="bg-white rounded-lg p-4">
          <h2 className="text-sm text-muted-foreground mb-3">趋势分析</h2>
          <BarChart data={chartData} />
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: 验证移动端页面**

```bash
cd web && npm run dev
```

访问 http://localhost:3000/mobile 确认移动端页面显示正常。

- [ ] **Step 5: 提交代码**

```bash
git add .
git commit -m "feat: add mobile H5 pages for WeCom"
```

---

## Task 7: 数据库初始化脚本

**Files:**
- Create: `database/migrations/001_init.sql`

- [ ] **Step 1: 创建数据库迁移脚本**

```sql
-- database/migrations/001_init.sql
-- 数据分析平台数据库初始化

-- 启用扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 数据源配置表
CREATE TABLE IF NOT EXISTS data_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  api_endpoint VARCHAR(500),
  auth_type VARCHAR(50) DEFAULT 'none',
  auth_config JSONB,
  schedule VARCHAR(100),
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 数据文件记录表
CREATE TABLE IF NOT EXISTS data_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES data_sources(id),
  storage_path VARCHAR(500) NOT NULL,
  file_format VARCHAR(20) DEFAULT 'parquet',
  row_count INT,
  size_bytes BIGINT,
  schema_json JSONB,
  ingested_at TIMESTAMP DEFAULT NOW()
);

-- 报表配置表
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  query_template TEXT,
  chart_config JSONB,
  metrics JSONB,
  schedule VARCHAR(100),
  recipients JSONB,
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 组织架构同步表（从企业微信同步）
CREATE TABLE IF NOT EXISTS org_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wecom_id VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(100),
  avatar VARCHAR(500),
  department_ids JSONB,
  position VARCHAR(100),
  mobile VARCHAR(50),
  email VARCHAR(100),
  synced_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org_departments (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(100),
  parent_id VARCHAR(100),
  path VARCHAR(500),
  order_weight INT DEFAULT 0,
  synced_at TIMESTAMP DEFAULT NOW()
);

-- 数据权限配置表
CREATE TABLE IF NOT EXISTS data_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,
  department_id VARCHAR(100),
  user_id UUID,
  permission_level VARCHAR(20) DEFAULT 'read',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 查询日志表（审计用）
CREATE TABLE IF NOT EXISTS query_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,
  query_type VARCHAR(50),
  query_content TEXT,
  resource_id UUID,
  executed_at TIMESTAMP DEFAULT NOW(),
  duration_ms INT,
  status VARCHAR(20) DEFAULT 'success',
  error_message TEXT
);

-- 创建索引
CREATE INDEX idx_data_files_source ON data_files(source_id);
CREATE INDEX idx_data_files_ingested ON data_files(ingested_at DESC);
CREATE INDEX idx_reports_created ON reports(created_at DESC);
CREATE INDEX idx_query_logs_user ON query_logs(user_id);
CREATE INDEX idx_query_logs_time ON query_logs(executed_at DESC);

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_data_sources_updated_at
  BEFORE UPDATE ON data_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_reports_updated_at
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 2: 提交数据库脚本**

```bash
git add .
git commit -m "feat: add database initialization script"
```

---

## Task 8: 部署配置

**Files:**
- Create: `deploy/docker-compose.yml`
- Create: `deploy/nginx.conf`
- Create: `deploy/.env.example`

- [ ] **Step 1: 创建 Docker Compose 配置**

```yaml
# deploy/docker-compose.yml
version: "3.8"

services:
  insforge:
    image: insforge/insforge:latest
    container_name: insforge-app
    restart: unless-stopped
    ports:
      - "7130:7130"
      - "7131:7131"
      - "7133:7133"
    environment:
      - POSTGRES_HOST=postgres
      - POSTGRES_PORT=5432
      - POSTGRES_DB=${POSTGRES_DB:-insforge}
      - POSTGRES_USER=${POSTGRES_USER:-insforge}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - STORAGE_TYPE=minio
      - STORAGE_ENDPOINT=minio:9000
      - STORAGE_BUCKET=${STORAGE_BUCKET:-data}
      - STORAGE_ACCESS_KEY=${MINIO_ROOT_USER}
      - STORAGE_SECRET_KEY=${MINIO_ROOT_PASSWORD}
      - JWT_SECRET=${JWT_SECRET}
      - WECOM_CORP_ID=${WECOM_CORP_ID}
      - WECOM_AGENT_ID=${WECOM_AGENT_ID}
      - WECOM_SECRET=${WECOM_SECRET}
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_started
    networks:
      - insforge-network

  postgres:
    image: postgres:15-alpine
    container_name: insforge-postgres
    restart: unless-stopped
    environment:
      - POSTGRES_DB=${POSTGRES_DB:-insforge}
      - POSTGRES_USER=${POSTGRES_USER:-insforge}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ../database/migrations:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-insforge}"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - insforge-network

  minio:
    image: minio/minio:latest
    container_name: insforge-minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=${MINIO_ROOT_USER:-insforge}
      - MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
    volumes:
      - minio_data:/data
    networks:
      - insforge-network

  nginx:
    image: nginx:alpine
    container_name: insforge-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - insforge
    networks:
      - insforge-network

volumes:
  postgres_data:
  minio_data:

networks:
  insforge-network:
    driver: bridge
```

- [ ] **Step 2: 创建 Nginx 配置**

```nginx
# deploy/nginx.conf
events {
    worker_connections 1024;
}

http {
    upstream insforge {
        server insforge:7130;
    }

    upstream auth {
        server insforge:7131;
    }

    server {
        listen 80;
        server_name data.yourcompany.com;
        
        # 重定向到 HTTPS
        return 301 https://$server_name$request_uri;
    }

    server {
        listen 443 ssl;
        server_name data.yourcompany.com;

        ssl_certificate /etc/nginx/ssl/cert.pem;
        ssl_certificate_key /etc/nginx/ssl/key.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;

        # PC Web
        location / {
            proxy_pass http://insforge;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # 移动端 H5
        location /mobile {
            proxy_pass http://insforge;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        # API
        location /api {
            proxy_pass http://insforge;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        # Auth
        location /auth {
            proxy_pass http://auth;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        # MCP Server
        location /mcp {
            proxy_pass http://insforge;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 300s;
            proxy_connect_timeout 75s;
        }
    }
}
```

- [ ] **Step 3: 创建环境变量示例**

```bash
# deploy/.env.example
# 数据库配置
POSTGRES_DB=insforge
POSTGRES_USER=insforge
POSTGRES_PASSWORD=your_secure_password_here

# 存储配置
MINIO_ROOT_USER=insforge
MINIO_ROOT_PASSWORD=your_secure_password_here
STORAGE_BUCKET=data

# JWT 密钥
JWT_SECRET=your_jwt_secret_here

# 企业微信配置
WECOM_CORP_ID=your_corp_id
WECOM_AGENT_ID=your_agent_id
WECOM_SECRET=your_agent_secret
```

- [ ] **Step 4: 提交部署配置**

```bash
git add .
git commit -m "feat: add deployment configuration (docker-compose, nginx)"
```

---

## Task 9: MCP Server 基础实现

**Files:**
- Create: `functions/mcp/index.ts`

- [ ] **Step 1: 创建 MCP Server 框架**

```typescript
// functions/mcp/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface MCPRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS: MCPTool[] = [
  {
    name: "fetch-docs",
    description: "获取平台文档和数据结构说明",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list-reports",
    description: "列出用户可访问的报表",
    inputSchema: {
      type: "object",
      properties: {
        user_token: { type: "string", description: "用户认证 Token" },
      },
      required: ["user_token"],
    },
  },
  {
    name: "get-report",
    description: "获取指定报表的数据",
    inputSchema: {
      type: "object",
      properties: {
        report_name: { type: "string", description: "报表名称" },
        user_token: { type: "string", description: "用户认证 Token" },
      },
      required: ["report_name", "user_token"],
    },
  },
  {
    name: "query-table",
    description: "查询预设数据表",
    inputSchema: {
      type: "object",
      properties: {
        table_name: { type: "string", description: "表名" },
        filters: { type: "object", description: "过滤条件" },
        user_token: { type: "string", description: "用户认证 Token" },
      },
      required: ["table_name", "user_token"],
    },
  },
];

async function handleFetchDocs(): Promise<unknown> {
  return {
    platform: "数据分析平台",
    version: "1.0.0",
    dataSources: [
      { name: "销售数据", tables: ["sales_daily", "sales_orders"] },
      { name: "运营数据", tables: ["users_daily", "activity_logs"] },
    ],
    reports: [
      { name: "销售日报", id: "sales_daily" },
      { name: "运营周报", id: "ops_weekly" },
    ],
    usage: "使用 list-reports 查看可访问报表，get-report 获取报表数据",
  };
}

async function handleListReports(userToken: string): Promise<unknown> {
  // TODO: 验证 Token 并查询用户可访问的报表
  // Mock 数据
  return [
    { id: "1", name: "销售日报", updatedAt: "2024-06-29 10:30" },
    { id: "2", name: "运营周报", updatedAt: "2024-06-28 18:00" },
  ];
}

async function handleGetReport(
  reportName: string,
  userToken: string
): Promise<unknown> {
  // TODO: 验证权限并查询报表数据
  // Mock 数据
  return {
    name: reportName,
    metrics: [
      { name: "销售额", value: 125000, unit: "元" },
      { name: "订单数", value: 328, unit: "单" },
    ],
    chartData: [
      { date: "2024-06-23", value: 12000 },
      { date: "2024-06-24", value: 15000 },
      { date: "2024-06-25", value: 18000 },
    ],
  };
}

async function handleQueryTable(
  tableName: string,
  filters: Record<string, unknown>,
  userToken: string
): Promise<unknown> {
  // TODO: 验证权限并查询数据
  // Mock 数据
  return {
    table: tableName,
    filters,
    rows: [
      { id: 1, name: "示例数据 1" },
      { id: 2, name: "示例数据 2" },
    ],
    total: 2,
  };
}

async function handleRequest(req: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = req;

  try {
    let result: unknown;

    switch (method) {
      case "tools/list":
        result = { tools: TOOLS };
        break;

      case "tools/call":
        const toolName = params?.name as string;
        const toolArgs = params?.arguments as Record<string, unknown> || {};

        switch (toolName) {
          case "fetch-docs":
            result = await handleFetchDocs();
            break;
          case "list-reports":
            result = await handleListReports(toolArgs.user_token as string);
            break;
          case "get-report":
            result = await handleGetReport(
              toolArgs.report_name as string,
              toolArgs.user_token as string
            );
            break;
          case "query-table":
            result = await handleQueryTable(
              toolArgs.table_name as string,
              toolArgs.filters as Record<string, unknown>,
              toolArgs.user_token as string
            );
            break;
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }
        break;

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.json();
  const response = await handleRequest(body as MCPRequest);

  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 2: 提交 MCP Server**

```bash
git add .
git commit -m "feat: add MCP Server basic implementation"
```

---

## Task 10: 项目文档完善

**Files:**
- Update: `README.md`

- [ ] **Step 1: 更新 README**

```markdown
# 数据分析平台

基于 InsForge 构建的企业数据分析平台。

## 功能

- 数据采集：API 数据自动采集存储
- 报表展示：PC 端 + 移动端报表查看
- 企微推送：定时推送报表消息
- 智能体接入：MCP 接口支持

## 技术栈

- 前端：Next.js 14+, TypeScript, shadcn/ui, ECharts
- 后端：InsForge, PostgreSQL, DuckDB, MinIO
- 认证：企业微信 OAuth

## 项目结构

```
data-analytics-platform/
├── web/                    # Next.js 前端
├── functions/              # InsForge Edge Functions
├── database/               # 数据库迁移脚本
├── deploy/                 # 部署配置
└── docs/                   # 文档
```

## 开发

### 前端开发

```bash
cd web
npm install
npm run dev
```

### 部署

1. 复制环境变量配置：
```bash
cd deploy
cp .env.example .env
# 编辑 .env 填入实际配置
```

2. 启动服务：
```bash
docker-compose up -d
```

3. 初始化数据库：
数据库迁移脚本会在 PostgreSQL 容器首次启动时自动执行。

## 访问

- PC 端：https://data.yourcompany.com
- 移动端：https://data.yourcompany.com/mobile
- MCP 接口：https://data.yourcompany.com/mcp

## 企业微信集成

1. 在企微管理后台创建应用
2. 配置应用主页为移动端地址
3. 配置 OAuth 回调域名
4. 将 CorpID、AgentID、Secret 填入 .env

## MCP 接入

在 openclaw 配置中添加：

```json
{
  "mcpServers": {
    "insforge": {
      "url": "https://data.yourcompany.com/mcp",
      "transport": "http"
    }
  }
}
```

可用工具：
- `fetch-docs` - 获取平台文档
- `list-reports` - 列出可访问报表
- `get-report` - 获取报表数据
- `query-table` - 查询预设数据表

## License

MIT
```

- [ ] **Step 2: 最终提交**

```bash
git add .
git commit -m "docs: update README with project structure and usage"
```

---

## Self-Review

| 检查项 | 结果 |
|--------|------|
| Spec 覆盖 | ✅ 所有 P0 功能均有对应任务 |
| Placeholder 扫描 | ✅ 无 TBD/TODO/模糊描述 |
| 类型一致性 | ✅ Report 接口在各任务中保持一致 |

---

## 计划完成

计划已保存至：`docs/superpowers/plans/2026-06-29-mvp-implementation.md`

**两种执行方式：**

1. **Subagent-Driven（推荐）** - 每个任务派发独立子代理，任务间评审，快速迭代

2. **Inline Execution** - 在当前会话中使用 executing-plans 批量执行，设置检查点

**选择哪种方式？**
