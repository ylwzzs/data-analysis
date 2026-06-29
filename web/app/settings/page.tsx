import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">
          <div className="mb-6">
            <h2 className="text-2xl font-bold">设置</h2>
            <p className="text-muted-foreground">平台配置与集成</p>
          </div>

          <div className="max-w-3xl space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>企业微信集成</CardTitle>
                    <CardDescription>OAuth 认证与消息推送</CardDescription>
                  </div>
                  <Badge variant="secondary">未配置</Badge>
                </div>
              </CardHeader>
              <CardContent className="text-sm">
                <Row label="CorpID" value="未设置" />
                <Row label="AgentID" value="未设置" />
                <Row label="OAuth 回调域" value="未设置" />
                <p className="mt-4 text-xs text-muted-foreground">
                  在 deploy/.env 中配置 WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET 后启用。
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>平台信息</CardTitle>
                <CardDescription>系统版本与运行状态</CardDescription>
              </CardHeader>
              <CardContent className="text-sm">
                <Row label="版本" value="v1.0.0 (Beta)" />
                <Row label="后端" value="InsForge" />
                <Row label="数据库" value="PostgreSQL 15" />
                <Row label="计算引擎" value="DuckDB" />
                <Row label="对象存储" value="MinIO" />
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
