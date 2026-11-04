import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getSessionDetail,
  listUserSessions,
  removeSession,
  updateSessionTitle,
} from '../lib/session.js';
import { notFound } from '../lib/errors.js';

// 路径参数：sessionId 只做长度和空值约束，
// 因为前端用的是 UUID，格式校验意义不大，交给业务即可。
const sessionParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
});

// 列表分页参数。
// 这里刻意用 catch + transform 而不是 max()，是为了保持改造前的行为：
// - limit=999  → 收敛成 200（不报错）
// - limit=abc  → 回退默认 20
// - 不传 limit → 默认 20
// coerce 负责把 query string "20" 转成数字 20。
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).catch(20).transform((v) => Math.min(v, 200)),
  offset: z.coerce.number().int().min(0).catch(0).transform((v) => Math.min(v, 1_000_000)),
});

// 详情分页：beforeId 是游标（上一页最早一条消息的 id），用于"加载更早的消息"
const detailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeId: z.coerce.number().int().positive().optional(),
});

// 重命名：trim 后不能为空，最长 100 字
const renameBodySchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(100, '标题最多 100 个字符'),
});

export async function sessionRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 在这个插件作用域内统一挂鉴权：
  // 这里注册的所有路由都自动需要登录，不会出现"漏加鉴权"的问题。
  app.addHook('onRequest', app.authenticate);

  // GET /api/sessions —— 历史记录列表（按更新时间倒序）
  r.get('/sessions', { schema: { querystring: listQuerySchema } }, async (request) => {
    // userId 来自 JWT，SQL 里必然带上它，保证 A 用户查不到 B 用户的数据
    const { userId } = request.user;
    const { limit, offset } = request.query;

    const data = await listUserSessions(userId, limit, offset);
    // 把实际生效的分页参数一起返回，方便前端知道是否被收敛
    return { data, limit, offset };
  });

  // GET /api/sessions/:sessionId/messages —— 会话上下文详情
  r.get(
    '/sessions/:sessionId/messages',
    { schema: { params: sessionParamsSchema, querystring: detailQuerySchema } },
    async (request) => {
      const { userId } = request.user;
      const { sessionId } = request.params;
      const { limit, beforeId } = request.query;

      // 查询内部同时按 user_id 过滤，所以别人的会话查出来就是 null
      const detail = await getSessionDetail(userId, sessionId, limit, beforeId);
      // 返回 404 而不是 403：不向攻击者泄露"这个会话是否存在"
      if (!detail) throw notFound('会话不存在');
      return detail;
    },
  );

  // PATCH /api/sessions/:sessionId —— 重命名
  r.patch(
    '/sessions/:sessionId',
    { schema: { params: sessionParamsSchema, body: renameBodySchema } },
    async (request) => {
      const { userId } = request.user;
      const session = await updateSessionTitle(
        userId,
        request.params.sessionId,
        request.body.title,
      );
      // 更新影响 0 行说明会话不属于当前用户或不存在
      if (!session) throw notFound('会话不存在');
      return { data: session };
    },
  );

  // DELETE /api/sessions/:sessionId —— 删除会话及其全部消息
  r.delete(
    '/sessions/:sessionId',
    { schema: { params: sessionParamsSchema } },
    async (request) => {
      const { userId } = request.user;
      const deleted = await removeSession(userId, request.params.sessionId);
      if (!deleted) throw notFound('会话不存在');
      return { ok: true };
    },
  );
}