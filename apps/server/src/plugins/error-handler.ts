import fp from 'fastify-plugin';
// FastifyError 是 Fastify 内部错误的类型（带 statusCode / validation 等字段）
import type { FastifyError } from 'fastify';
import { AppError } from '../lib/errors.js';
import { isProd } from '../config.js';

/**
 * 全局错误处理插件。
 *
 * 目标：整个应用只有这一个地方决定"错误长什么样"。
 * 所有响应统一为 { error: string, code: string, details?: unknown }。
 * 路由里只管 throw，不用手写 reply.code().send()。
 */
export default fp(async (app) => {
  // setErrorHandler 会接管所有 handler 中抛出/被 reject 的错误，
  // 包括：业务 throw、zod 校验失败、Fastify 内部错误、未捕获异常。
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    // ===== 1. 我们自己抛的业务错误 =====
    if (error instanceof AppError) {
      // 5xx 说明是服务端问题，用 error 级别，方便告警系统捕获
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, error.message);
      } else {
        // 4xx 是客户端问题，用 warn 级别，避免污染错误告警
        // 注意：只记录 code/方法/路径，不记录 body，防止密码等敏感信息进日志
        request.log.warn(
          { code: error.code, method: request.method, url: request.url },
          error.message,
        );
      }
      // 业务错误把 message 原样返回给前端（这些文案本来就是写给用户看的）
      return reply
        .code(error.statusCode)
        .send({ error: error.message, code: error.code });
    }

    // ===== 2. 参数校验失败 =====
    // zod（通过 fastify-type-provider-zod）和原生 JSON Schema 校验失败时，
    // Fastify 会给出 error.validation 数组。这里统一转成 400 + 字段级错误。
    if ('validation' in error && error.validation) {
      return reply.code(400).send({
        error: '参数校验失败',
        code: 'VALIDATION_ERROR',
        // instancePath 是 JSON Pointer（如 "/username"），schemaPath 是兜底
        details: error.validation.map((v) => ({
          path: v.instancePath || v.schemaPath,
          message: v.message,
        })),
      });
    }

    // ===== 3. Fastify 框架层错误 =====
    // 例如：非法 JSON（400）、body 过大（413）、限流（429）、content-type 不支持（415）
    // 这些错误自带 statusCode，需要保留原状态码，不能一律变 500。
    const status = error.statusCode ?? 500;

    // 用一张映射表把「状态码 -> 稳定的业务 code」对齐，
    // 这样前端可以只认 code 而不依赖具体错误文案。
    const clientErrorCodes: Record<number, { code: string; message?: string }> = {
      400: { code: 'BAD_REQUEST' },
      401: { code: 'UNAUTHORIZED', message: '未登录或 Token 已过期' },
      403: { code: 'FORBIDDEN', message: '没有权限' },
      404: { code: 'NOT_FOUND' },
      405: { code: 'METHOD_NOT_ALLOWED' },
      408: { code: 'REQUEST_TIMEOUT' },
      413: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' },
      415: { code: 'UNSUPPORTED_MEDIA_TYPE' },
      429: { code: 'TOO_MANY_REQUESTS', message: '请求过于频繁' },
    };

    const known = clientErrorCodes[status];
    if (known) {
      request.log.warn({ status, code: known.code, url: request.url }, error.message);
      return reply.code(status).send({
        // 有预设文案就用预设的，没有就透出框架原始错误（如"Body is not valid JSON..."）
        error: known.message ?? error.message,
        code: known.code,
      });
    }

    // ===== 4. 未知错误 =====
    // 走到这里通常是代码 bug 或依赖故障（数据库断开等）。
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      // 生产环境绝不把内部错误信息（SQL、文件路径、堆栈）返回给客户端
      error: isProd ? '服务器内部错误' : error.message,
      code: 'INTERNAL_ERROR',
    });
  });

  // 路由不存在时不再返回 Fastify 默认的 HTML/纯文本，而是统一 JSON 结构
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: `路由不存在: ${request.method} ${request.url}`,
      code: 'NOT_FOUND',
    });
  });
});