// 尽早加载 .env，保证下面 schema 读取 process.env 时变量已经就位。
// 注意：dotenv 默认【不覆盖】已存在的环境变量，所以终端里手动 export 的值优先。
import 'dotenv/config';
// zod 用来做「运行时校验 + 类型推导」：校验通过后 config 的字段类型是自动推出来的
import { z } from 'zod';

// 这里集中声明「应用需要哪些环境变量」以及「每个变量的类型和约束」。
// 好处：缺变量 / 类型错 / 值不合法，在启动阶段就失败，而不是等到某个接口被调用时才炸。
const schema = z.object({
  // 运行环境。用它来区分开发/生产行为（比如日志格式、错误详情是否暴露）
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 监听端口。process.env 里永远是字符串，coerce 负责 "3000" -> 3000
  PORT: z.coerce.number().int().positive().default(3000),
  // 监听地址。0.0.0.0 表示接受所有网卡连接（容器/局域网需要）
  HOST: z.string().default('0.0.0.0'),
  // 日志级别。限定枚举值，写错（比如 "verbose"）会直接启动失败
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // 数据库连接串，必填。min(1) 用来拦住空字符串（空串是"存在但无效"）
  DATABASE_URL: z.string().min(1),
  // Redis 连接串，本地开发给默认值，生产一般显式配置
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  // JWT 签名密钥。强制至少 32 字符，避免有人用 "123456" 这种弱密钥上线
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少需要 32 个字符'),
  // token 有效期，直接透传给 @fastify/jwt 的 expiresIn（"7d" / "2h" / 秒数）
  JWT_EXPIRES_IN: z.string().default('7d'),

  // 大模型 API Key 和地址，必填（没有它 /chat 一定用不了）
  DEEPSEEK_API_KEY: z.string().min(1),
  BASE_URL: z.string().url(),
  OPENAI_MODEL: z.string().default('deepseek-flash'),

  // 允许跨域的前端来源。多个用英文逗号分隔，例如 "http://a.com,http://b.com"
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

// safeParse 不会抛异常，而是返回 { success, data | error }，
// 这样我们可以自己决定怎么报错（下面手动打印后退出）。
const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // flatten().fieldErrors 会把错误按字段名分组，输出更易读，例如：
  // { DATABASE_URL: ['Required'], JWT_SECRET: ['JWT_SECRET 至少需要 32 个字符'] }
  console.error('[config] 环境变量校验失败:');
  console.error(parsed.error.flatten().fieldErrors);
  // 退出码 1 让 pm2 / docker / CI 能感知到"启动失败"，而不是带着错误配置继续跑
  process.exit(1);
}

// 导出校验后的强类型配置对象。业务代码只从这里取环境变量，
// 不再直接读 process.env，避免散落各处的隐式依赖。
export const config = parsed.data;

// 常用判断抽成常量，避免到处写 config.NODE_ENV === 'production'
export const isProd = config.NODE_ENV === 'production';