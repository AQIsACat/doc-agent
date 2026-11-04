import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getHistory, saveHistory, truncateHistory } from '../lib/session.js';
import { streamChat, LlmTimeoutError, type LlmMessage } from '../services/llm.js';
import { openSseStream } from '../lib/sse.js';
import { isProd } from '../config.js';

// 对话请求体校验。
// 上限的意义：message 8000 字既防止超长 prompt 烧 token，也防止恶意超大 body。
const chatBodySchema = z.object({
  sessionId: z.string().trim().min(1, 'sessionId 不能为空').max(128, 'sessionId 过长'),
  message: z.string().trim().min(1, '消息不能为空').max(8000, '消息过长'),
  systemMessage: z.string().max(4000, 'systemMessage 过长').optional(),
});

const historyQuerySchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
});

export async function chatRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 本插件下所有路由都要求登录
  app.addHook('onRequest', app.authenticate);

  // POST /api/chat —— 流式对话（SSE）
  r.post('/chat', { schema: { body: chatBodySchema } }, async (request, reply) => {
    const { sessionId, message, systemMessage } = request.body;
    const { userId } = request.user;

    // 1. 读历史（Redis -> PG）。system 不落库，这里再过滤一次是防御性写法
    const rawHistory = await getHistory(userId, sessionId);
    const history = rawHistory.filter((m) => m.role !== 'system');

    // 2. 组装发给模型的上下文：
    //    [system?] + [最近 6 轮历史] + [本轮用户消息]
    //    system 只在调用模型时临时拼，不写进数据库（否则每轮都会重复存一份）
    const llmMessages: LlmMessage[] = [
      ...(systemMessage ? [{ role: 'system' as const, content: systemMessage }] : []),
      ...truncateHistory(history).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // 调试用：把发给模型的完整 payload 打出来。
    // 只在非生产环境开，生产日志里出现用户对话属于隐私泄露。
    if (!isProd) {
      request.log.debug({ llmMessages }, 'llm payload');
    }

    // 3. 中断控制：客户端断开（用户点停止 / 关页面）时要立刻停掉模型调用，
    //    否则会继续烧 token。
    const abortController = new AbortController();
    let aborted = false;

    const onClose = () => {
      // 加锁避免重复触发（close 和 aborted 可能都触发）
      if (aborted) return;
      aborted = true;
      request.log.info({ sessionId }, 'client disconnected, aborting model call');
      abortController.abort();
    };

    // 监听底层 socket 的 close 事件（最可靠：无论是正常结束还是异常断开都会触发）
    reply.raw.on('close', onClose);

    // 4. 打开 SSE：内部会 hijack + 写响应头 + 启动心跳
    const sse = openSseStream(reply);

    let assistantContent = '';
    let completed = false;
    const startedAt = Date.now();

    try {
      // 逐 token 转发给前端，同时累积完整回答用于落库
      for await (const token of streamChat(llmMessages, abortController.signal)) {
        assistantContent += token;
        sse.send({ delta: token });
      }
      completed = true;
    } catch (err) {
      // 分三类处理，避免"超时"被误报成"用户取消"
      if (err instanceof LlmTimeoutError) {
        request.log.warn({ sessionId, timeoutMs: err.timeoutMs }, 'llm timeout');
        // code 是给前端做分支用的稳定标识，message 是给用户看的文案
        sse.sendEvent('error', {
          code: 'MODEL_TIMEOUT',
          message: '模型响应超时，请重试',
        });
      } else if (err instanceof Error && err.name === 'AbortError') {
        // 用户主动取消属于正常行为，用 info 级别，不算错误
        request.log.info({ sessionId }, 'chat stream aborted by client');
      } else {
        request.log.error({ err, sessionId }, 'chat stream failed');
        sse.sendEvent('error', {
          code: 'MODEL_ERROR',
          message: '模型服务异常，请稍后重试',
        });
      }
    } finally {
      // 一定要解绑监听器，否则 reply 对象上会残留引用
      reply.raw.off('close', onClose);

      // 5. 只有"正常跑完 + 没被中断 + 有内容"才写库。
      //    中断或报错时不落库，避免存下半截回答污染上下文。
      if (!aborted && completed && assistantContent) {
        await saveHistory(userId, sessionId, [
          { role: 'user', content: message },
          { role: 'assistant', content: assistantContent },
        ]).catch((e) => {
          // 落库失败不能让用户已经看到的回答白等，所以只记录日志、不抛出
          request.log.error({ err: e, sessionId }, 'save history failed');
        });
      }

      // 结构化收尾日志：耗时、字数、是否完成/中断，方便排查"为什么没存上"
      request.log.info(
        {
          sessionId,
          durationMs: Date.now() - startedAt,
          chars: assistantContent.length,
          completed,
          aborted,
        },
        'chat finished',
      );

      // end() 内部会清心跳、写 data: [DONE]、关闭连接
      sse.end();
    }
  });

  // GET /api/chat/history —— 兼容旧前端：返回最近上下文（不落库、不带分页）
  r.get(
    '/chat/history',
    { schema: { querystring: historyQuerySchema } },
    async (request) => {
      const { userId } = request.user;
      const history = await getHistory(userId, request.query.sessionId);

      // 只返回可序列化的纯数据，并过滤掉 system
      return {
        data: history
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
          })),
      };
    },
  );
}