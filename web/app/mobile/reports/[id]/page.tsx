import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

// 移动端报表详情路径重定向到统一的响应式详情页
// 详情页会自动根据 UA 检测设备类型并渲染对应布局
export default async function MobileReportPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/reports/${id}`);
}
