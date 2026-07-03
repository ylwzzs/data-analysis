import { ExternalLink, AlertCircle, CheckCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Token 提取工具使用指南
 */
export default function TokenExtractorPage() {
  const bookmarkletCode = `javascript:(function(){var s=document.createElement('script');s.src='https://data.shanhaiyiguo.com/lemeng-token-extractor.js';document.body.appendChild(s);})();`;

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">乐檬 Token 提取工具</h1>
        <p className="text-muted-foreground mt-2">
          一键提取乐檬系统 Token，无需懂技术，简单三步完成
        </p>
      </div>

      {/* 使用步骤 */}
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold">
                1
              </span>
              添加书签工具
            </CardTitle>
            <CardDescription>将"提取乐檬Token"按钮拖到浏览器书签栏</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold text-blue-900">操作说明</p>
                <ol className="list-decimal list-inside space-y-1 mt-2 text-sm text-blue-800">
                  <li>确保浏览器书签栏已显示（Chrome: Ctrl/Cmd + Shift + B）</li>
                  <li>用鼠标按住下方按钮，拖到书签栏</li>
                  <li>松开鼠标，书签会自动添加</li>
                </ol>
              </div>
            </div>

            <div className="mt-4 p-4 bg-gray-100 rounded-lg">
              <a
                href={bookmarkletCode}
                onClick={(e) => e.preventDefault()}
                className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg cursor-move hover:bg-blue-700 transition-colors"
                draggable
              >
                📌 提取乐檬 Token
              </a>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold">
                2
              </span>
              登录乐檬系统
            </CardTitle>
            <CardDescription>在浏览器中登录您的乐檬账号</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <a
                href="https://account.lemengcloud.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm font-medium hover:bg-muted hover:text-foreground transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                打开乐檬登录页
              </a>
              <span className="text-sm text-muted-foreground">
                新窗口打开，登录后回来继续
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold">
                3
              </span>
              提取 Token
            </CardTitle>
            <CardDescription>点击书签工具，自动提取并复制 Token</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
              <CheckCircle className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold text-green-900">操作步骤</p>
                <ol className="list-decimal list-inside space-y-1 mt-2 text-sm text-green-800">
                  <li>在乐檬页面中，点击书签栏的"提取乐檬Token"</li>
                  <li>系统会自动提取 Token 并复制到剪贴板</li>
                  <li>回到数据分析平台粘贴使用</li>
                </ol>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 常见问题 */}
      <Card>
        <CardHeader>
          <CardTitle>常见问题</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-1">Q: 提示"未找到乐檬 Token"？</h3>
            <p className="text-sm text-muted-foreground">
              A: 请确保您已在乐檬系统中登录，并且停留在乐檬的页面内（不要在其他网站点击书签）
            </p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Q: Token 有效期多久？</h3>
            <p className="text-sm text-muted-foreground">
              A: 乐檬 Token 有效期约 5 天，过期后需要重新提取
            </p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Q: 书签添加失败？</h3>
            <p className="text-sm text-muted-foreground">
              A: 如果拖拽添加失败，可以手动创建书签：
              <ol className="list-decimal list-inside mt-1 text-xs bg-gray-100 p-2 rounded">
                <li>右键书签栏 → 添加书签</li>
                <li>名称填写：提取乐檬Token</li>
                <li>URL/地址填写下方代码：</li>
              </ol>
              <code className="block mt-2 p-2 bg-gray-100 rounded text-xs break-all">
                {bookmarkletCode}
              </code>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 视频教程占位 */}
      <Card>
        <CardHeader>
          <CardTitle>视频教程</CardTitle>
          <CardDescription>30 秒快速学会（待补充）</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="aspect-video bg-gray-100 rounded-lg flex items-center justify-center text-muted-foreground">
            视频教程制作中...
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
