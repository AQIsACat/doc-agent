/**
 * 业务错误基类。
 *
 * 设计意图：让「业务上可预期的错误」（用户名已存在、会话不存在…）
 * 和「程序 bug / 第三方故障」区分开。
 * - statusCode：最终返回给客户端的 HTTP 状态码
 * - code：给前端做分支判断的稳定标识（前端不要靠中文文案判断）
 * - message：给人看的提示文案
 *
 * 继承原生 Error 是为了能直接 `throw`，并且保留堆栈。
 */
export class AppError extends Error {
  constructor(
    // readonly：构造后不可修改，避免错误对象被中途篡改
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    // 把 message 传给原生 Error，堆栈和 message 才会正常
    super(message);
    // 设置 name 后，日志里能直接看出是 AppError 而不是普通 Error
    this.name = 'AppError';
  }
}

// 下面是一组「快捷构造器」，让路由里可以写 `throw notFound('会话不存在')`，
// 而不是 `throw new AppError(404, 'NOT_FOUND', '会话不存在')`。
// 注意：这些函数只负责创建错误对象，不负责发送响应。

// 400：请求参数本身有问题
export const badRequest = (message: string, code = 'BAD_REQUEST') =>
  new AppError(400, code, message);

// 401：没登录 / token 失效
export const unauthorized = (message = '未登录或 Token 已过期') =>
  new AppError(401, 'UNAUTHORIZED', message);

// 403：登录了但没权限
export const forbidden = (message = '没有权限') =>
  new AppError(403, 'FORBIDDEN', message);

// 404：资源不存在（也用于"不属于当前用户"，避免泄露资源是否存在）
export const notFound = (message = '资源不存在') =>
  new AppError(404, 'NOT_FOUND', message);

// 409：状态冲突，例如用户名已存在
export const conflict = (message: string, code = 'CONFLICT') =>
  new AppError(409, code, message);

// 429：限流
export const tooManyRequests = (message = '请求过于频繁') =>
  new AppError(429, 'TOO_MANY_REQUESTS', message);

// 500：服务端内部错误（少数需要显式返回 5xx 的业务场景）
export const internal = (message = '服务器内部错误') =>
  new AppError(500, 'INTERNAL_ERROR', message);

/**
 * 判断是否是 PostgreSQL 的唯一约束冲突。
 *
 * 为什么需要：`SELECT` 检查 + `INSERT` 之间存在并发窗口，
 * 两个请求可能同时通过检查，最终由数据库的 UNIQUE 约束兜底。
 * 23505 是 Postgres 的 unique_violation 错误码。
 *
 * 用 unknown 而不是 any：调用方传入的 catch 变量默认是 unknown，
 * 这里显式做类型收窄，避免误用。
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}