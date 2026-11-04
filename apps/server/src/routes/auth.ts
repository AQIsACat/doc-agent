import type { FastifyInstance } from 'fastify';
// ZodTypeProvider 负责把 zod schema 推导成 request.body / query / params 的类型
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { createUser, findUserByUsername } from '../lib/db.js';
import { conflict, isUniqueViolation, unauthorized } from '../lib/errors.js';
import { config } from '../config.js';

// 用户名规则抽出来复用：注册和登录都必须满足，否则查库都没意义
const usernameSchema = z
  .string()
  // trim 会先去掉首尾空格，避免 "  admin  " 和 "admin" 变成两个账号
  .trim()
  .min(3, '用户名至少 3 个字符')
  .max(32, '用户名最多 32 个字符')
  .regex(/^[a-zA-Z0-9_-]+$/, '用户名只能包含字母、数字、下划线和短横线');

// 注册时的密码规则：下限 8 位提高安全性；
// 上限 72 位是因为 bcrypt 只处理前 72 字节，再长也会被静默截断，还会白白消耗 CPU。
const registerSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8, '密码至少 8 位').max(72, '密码最多 72 位'),
});

// 登录只校验"非空 + 长度上限"，不校验最小长度。
// 原因：历史上已有用户的密码可能是 6 位，如果这里也要求 8 位，老用户会直接登不进来。
const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, '请输入密码').max(72, '密码最多 72 位'),
});

export async function authRoutes(app: FastifyInstance) {
  // 拿到带 zod 类型推导的实例。之后的 r.post(...) 里 request.body 就是强类型的。
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 注册接口。注意路径不带 /api/auth 前缀：
  // 外层注册时用了 { prefix: '/api/auth' }，Fastify 会自动拼上。
  r.post(
    '/register',
    // schema.body 让 Fastify 在进入 handler 之前就完成校验，
    // 校验失败会直接抛 400，不会浪费一次数据库查询。
    { schema: { body: registerSchema } },
    async (request, reply) => {
      // 这里的解构已经过校验，类型安全，不需要 as any
      const { username, password } = request.body as { username: string; password: string };

      // 先查一次给出友好提示（这一步不是并发安全的，真正的兜底在下面的 try/catch）
      const existing = await findUserByUsername(username);
      if (existing) throw conflict('用户名已存在', 'USERNAME_TAKEN');

      // 10 是 cost factor：越大越安全但越慢。生产常用 10~12。
      // 不再手动 genSalt，bcrypt.hash 内部会自动生成随机盐。
      const hash = await bcrypt.hash(password, 10);

      try {
        const user = await createUser(username, hash);
        // 201 Created 比 200 更准确；id 转成字符串，和 JWT 载荷里的类型保持一致
        return reply.code(201).send({ id: String(user.id), username: user.username });
      } catch (err) {
        // 并发场景：两个请求同时通过了上面的存在性检查，
        // 此时数据库的 UNIQUE 约束会拦下第二个，这里翻译成友好的 409。
        if (isUniqueViolation(err)) throw conflict('用户名已存在', 'USERNAME_TAKEN');
        // 其他数据库错误交给全局 errorHandler 变成 500
        throw err;
      }
    },
  );

  // 登录接口
  r.post(
    '/login',
    {
      schema: { body: loginSchema },
      // 单独给登录接口更严格的限流：每分钟最多 5 次，
      // 用来对抗撞库/爆破（全局限流是 100 次/分钟）。
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { username, password } = request.body as { username: string; password: string };

      const user = await findUserByUsername(username);
      // 用户不存在和密码错误返回完全相同的提示，
      // 否则攻击者可以靠响应差异枚举出"哪些用户名真实存在"。
      if (!user) throw unauthorized('用户名或密码错误');

      // bcrypt.compare 内部会从 hash 中取出盐，用同样的参数重新计算并比对
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) throw unauthorized('用户名或密码错误');

      // 签发 JWT。userId 统一转字符串（pg 的 BIGSERIAL 读出来就是字符串）。
      const token = app.jwt.sign(
        { userId: String(user.id), username: user.username },
        { expiresIn: config.JWT_EXPIRES_IN },
      );

      return { token, username: user.username };
    },
  );
}