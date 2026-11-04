import fp from 'fastify-plugin';
import { pool } from '../lib/db.js';
import { redis } from '../lib/redis.js';

/**
 * 健康检查插件。
 *
 * 为什么要拆成两个接口：
 * - /health（liveness）：只回答"进程还活着吗"，不查任何外部依赖。
 *   如果这里查数据库，数据库抖动就会导致容器被不断重启，反而放大了故障。
 * - /ready（readiness）：回答"现在能接流量吗"，需要依赖都正常。
 *   失败时只是把实例从负载均衡摘掉，不重启它。
 */
export default fp(async (app) => {
  // 只做内存层面的检查，永远是 200（进程还能响应就说明活着）
  app.get('/health', async () => ({ ok: true, ts: Date.now() }));

  app.get('/ready', async (request, reply) => {
    try {
      // SELECT 1 是最轻量的"能连上并且能执行 SQL"的探活方式
      // （比 SELECT * FROM 某表更安全：不依赖任何业务表存在）
      await pool.query('SELECT 1');
      // PING 检查 Redis 连接是否可用（ioredis 会自动重连，这里确认当前可用）
      await redis.ping();
      return { ok: true };
    } catch (err) {
      // 503 Service Unavailable：明确告诉调度器"我现在不能接流量"
      request.log.error({ err }, 'readiness check failed');
      return reply.code(503).send({ ok: false });
    }
  });
});