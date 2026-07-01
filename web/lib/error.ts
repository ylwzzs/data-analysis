// web/lib/error.ts
/**
 * 应用错误类型
 * 用于统一错误处理和友好的用户提示
 */

export interface AppError {
  type: 'network' | 'auth' | 'not_found' | 'server' | 'unknown';
  message: string;      // 用户友好的消息
  details?: string;     // 开发详情（仅 console）
  retry?: boolean;      // 是否可重试
}

/**
 * 将任意错误转换为友好的 AppError
 */
export function wrapError(error: unknown): AppError {
  // 网络错误
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return {
      type: 'network',
      message: '网络连接失败，请检查网络后重试',
      retry: true,
    };
  }

  // PostgREST/HTTP 错误
  if (error && typeof error === 'object') {
    const err = error as { code?: string; status?: number; message?: string };

    // 401 未授权
    if (err.status === 401 || err.code === 'PGRST301') {
      return {
        type: 'auth',
        message: '登录已过期，请重新登录',
        retry: false,
      };
    }

    // 404 不存在
    if (err.status === 404) {
      return {
        type: 'not_found',
        message: '请求的资源不存在',
        retry: false,
      };
    }

    // 500 服务器错误
    if (err.status && err.status >= 500) {
      return {
        type: 'server',
        message: '服务器繁忙，请稍后再试',
        details: err.message,
        retry: true,
      };
    }
  }

  // 默认未知错误
  return {
    type: 'unknown',
    message: '发生未知错误，请重试',
    retry: true,
  };
}

/**
 * 获取用户友好的错误消息
 */
export function getUserFriendlyMessage(error: unknown): string {
  return wrapError(error).message;
}

/**
 * 检查错误是否可重试
 */
export function isRetryable(error: unknown): boolean {
  return wrapError(error).retry ?? false;
}
