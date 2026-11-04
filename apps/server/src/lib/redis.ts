import { Redis } from 'ioredis';
// 统一从 config 取配置，不再到处读 process.env
import { config } from '../config.js';

/**
 * 全局唯一的 Redis 客户端实例。
 * ioredis 内部自带连接池/多路复用，一个实例服务整个进程即可，不要每次请求都 new。
 */
export const redis = new Redis(config.REDIS_URL, {
  // 单条命令最多重试 3 次。设太大时，Redis 挂掉会让请求长时间卡住；
  // 设成 3 次后快速失败，上层 catch 后降级为直接查数据库。
  maxRetriesPerRequest: 3,
  // true 表示立即连接；false 则要手动 await redis.connect()
  lazyConnect: false,
  // 断线重连策略：重试间隔从 100ms 线性增长，最多 2s 一次（永不放弃）
  retryStrategy(times) {
    return Math.min(times * 100, 2_000);
  },
});

// 连接成功只用于确认启动正常，方便排查"到底连上没"
redis.on('connect', () => {
  console.log('[redis] connected');
});

// 必须监听 error，否则 ioredis 会抛出未捕获的 'error' 事件导致进程崩溃。
// 这里只打日志，实际请求失败由各个调用点的 catch 处理。
redis.on('error', (err) => {
  console.error('[redis] error:', err.message);
});

/**
 * 优雅关闭时调用：先 quit（等待已发出的命令执行完），
 * 失败再 disconnect（强制断开 socket），避免进程退出时句柄悬挂。
 */
export const closeRedis = async (): Promise<void> => {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
};