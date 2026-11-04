// 尽早加载 .env。放在最前面，保证后续所有模块 import 时 process.env 已就绪。
import 'dotenv/config';
// Node 内置的 UUID 生成，用于没有传 x-request-id 时兜底
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

// config 里已经做过环境变量校验，这里的值一定是合法且类型正确的
import { config, isProd } from './config.js';
import { closeDb, dbReady } from './lib/db.js';
import { closeRedis } from './lib/redis.js';
import errorHandler from './plugins/error-handler.js';
import authPlugin from './plugins/auth.js';
import healthPlugin from './plugins/health.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chat.js';
import { sessionRoutes } from './routes/sessions.js';

const app = Fastify({
  // 生产环境输出 JSON（给日志采集器）；开发环境用 pino-pretty 输出彩色可读日志
  logger: isProd
    ? { level: config.LOG_LEVEL }
    : {
        level: config.LOG_LEVEL,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            // SYS 表示用系统本地时区，方便对着本地时间排查
            translateTime: 'SYS:HH:MM:ss',
            // pid/hostname 每条日志都一样，省略掉能显著变短
            ignore: 'pid,hostname',
          },
        },
      },
  // 请求 ID：优先用调用方传的 x-request-id（便于全链路追踪），没有就自己生成
  genReqId: (req) =>
    (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  // 让 Fastify 的 request.body/query/params 都按 zod schema 推导类型
}).withTypeProvider<ZodTypeProvider>();

// 告诉 Fastify 用 zod 做校验和序列化（配合各路由的 schema 使用）
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// ===== 插件注册顺序很重要 =====

// 1) 错误处理必须最先注册，后面任何插件/路由抛的错才会被它统一接管
await app.register(errorHandler);

// 2) 安全响应头（X-Frame-Options、X-Content-Type-Options 等）。
//    关掉 CSP 是因为纯 API 服务不返回 HTML，开着反而可能影响 /docs 等页面
await app.register(helmet, { contentSecurityPolicy: false });

// 3) 跨域。原来写的是 origin: true（允许任何站点），生产环境风险太大，改为白名单
await app.register(cors, {
  // 支持逗号分隔多个来源，配置里统一按逗号切开并去掉空格
  origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()),
  // 允许浏览器携带 cookie（以后换 HttpOnly 方案时需要）
  credentials: true,
  // 【易错点】默认 methods 只有 GET,HEAD,POST，
  // 重命名(PATCH) 和删除(DELETE) 会因为预检失败被浏览器拦截，必须显式加上
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
});

// 4) JWT。密钥来自校验过的配置，不会再出现 'super-secret-key' 这种兜底弱密钥
await app.register(jwt, { secret: config.JWT_SECRET });

// 5) 全局限流：每个 IP 每分钟 100 次。
//    单个接口可以在路由配置里用 config.rateLimit 覆盖（如登录 5 次/分钟）
await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  // 按 IP 限流；注意这里拿不到 request.user（鉴权发生在路由钩子里，晚于全局限流）
  keyGenerator: (request) => request.ip,
});

// 6) 自定义鉴权插件：注册 app.authenticate 装饰器
await app.register(authPlugin);

// ===== 全局钩子 =====

// 慢请求日志：业务日志之外的一层兜底，用来发现"接口悄悄变慢"
app.addHook('onResponse', async (request, reply) => {
  // elapsedTime 是 Fastify 统计的从收到请求到响应完成的总耗时（毫秒）
  const ms = Math.round(reply.elapsedTime);
  // 阈值 1 秒：超过就告警，可通过改这里调整敏感度
  if (ms > 1_000) {
    request.log.warn(
      { ms, method: request.method, url: request.url, status: reply.statusCode },
      'slow request',
    );
  }
});

// ===== 路由注册 =====

// 健康检查：公开，不需要登录（负载均衡要能直接探活）
await app.register(healthPlugin);

// 公开路由：注册/登录。用 prefix 统一前缀，
// 这样路由文件里只写 '/register'、'/login'，改前缀时只改这一处。
await app.register(authRoutes, { prefix: '/api/auth' });

// 受保护路由：插件内部已经 addHook('onRequest', app.authenticate)，
// 所以这里不需要再维护"哪些路径要放行"的白名单。
await app.register(chatRoutes, { prefix: '/api' });
await app.register(sessionRoutes, { prefix: '/api' });

// 等数据库就绪（内部会检查 pgmigrations 版本）。
// 数据库不可用时这里会抛错，进程退出，避免带病启动。
await dbReady;

// 真正开始监听。用 config 而不是 process.env，保证类型和默认值一致
await app.listen({ port: config.PORT, host: config.HOST });

app.log.info({ env: config.NODE_ENV, port: config.PORT }, 'server started');

// ===== 优雅关闭 =====

/**
 * 收到停止信号后要做的事：
 * 1. app.close() 停止接收新请求，并等待"正在处理"的请求结束
 * 2. 关掉 Redis / 数据库连接池
 * 3. 正常退出
 *
 * 为什么重要：直接 kill 会切断正在进行的 SSE 和数据库事务，
 * 容器编排（K8s/Docker）滚动发布时会造成用户请求失败。
 */
const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');

  // 兜底：如果 10 秒还没关完（比如某个请求卡住），强制退出，避免容器一直挂着
  const forceExit = setTimeout(() => {
    app.log.error('graceful shutdown timeout, forcing exit');
    process.exit(1);
  }, 10_000);
  // unref：这个定时器本身不应该阻止进程正常退出
  forceExit.unref();

  try {
    await app.close();
    // 先关 Redis 再关数据库，顺序不重要，但两者都必须关
    await closeRedis();
    await closeDb();
    clearTimeout(forceExit);
    app.log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
};

// SIGTERM：docker stop / k8s 滚动更新默认发送
// SIGINT：终端 Ctrl+C
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));