// fastify-plugin：让插件内部注册的 decorate / hook 作用到父级实例，
// 否则它会被封装在子作用域里，路由根本用不到 app.authenticate
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { unauthorized } from '../lib/errors.js';

/**
 * JWT 载荷的类型。
 *
 * 为什么要显示写成 string：
 * pg 会把 BIGSERIAL（int8）读成字符串，所以 user.id 在运行时是 "1" 而不是 1。
 * 如果我们在这里写 number，TS 会以为它是数字，实际却是字符串，容易埋坑。
 */
export type JwtPayload = {
  userId: string;
  username: string;
};

// 模块声明合并（declaration merging）：
// 扩展 @fastify/jwt 的类型定义，让 request.user / app.jwt.sign 都有正确类型。
// 不写这段的话，request.user 是 unknown，每次都要手写 as 断言。
declare module '@fastify/jwt' {
  interface FastifyJWT {
    // sign 时允许的载荷形状
    payload: JwtPayload;
    // 校验后 request.user 的形状
    user: JwtPayload;
  }
}

// 扩展 FastifyInstance，让 app.authenticate 在类型层面存在
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

export default fp(async (app) => {
  // decorate：往 Fastify 实例上挂一个方法，等价于"注册一个可复用的守卫函数"。
  // 之后路由里可以写：app.addHook('onRequest', app.authenticate)
  app.decorate('authenticate', async (request: FastifyRequest) => {
    try {
      // jwtVerify 会解析 Authorization: Bearer <token>，
      // 校验签名和过期时间，通过后把载荷挂到 request.user
      await request.jwtVerify();
    } catch {
      // 这里不把原始错误透出去（可能包含 jti、payload 等内部信息），
      // 统一转成业务错误，由全局 errorHandler 输出标准结构
      throw unauthorized();
    }
  });
});