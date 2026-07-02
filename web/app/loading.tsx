/**
 * 全局 Loading
 * 使用简洁 spinner，不区分设备布局，避免闪烁
 */
export default function GlobalLoading() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );
}
