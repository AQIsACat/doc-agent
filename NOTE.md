# Doc-Agent 项目知识清单

> 用法：这份清单只记「第一层知识」（心智模型 / 决策依据）。
> 第二层（API 用法）记名字就够，用的时候查官方文档。
> 第三层（框架内部实现）完全不用管。

---

## 0. 一次请求的完整旅程

理解这一条，其他都能挂上去。

```text
HTTP 请求进来
  ↓
genReqId         生成/透传 request-id
  ↓
helmet           ⚠️ 注意：helmet 是 onRequest 钩子
  ↓
cors             预检(OPTIONS)在这里可能直接 204 返回，不进入业务
  ↓
rate-limit       超过阈值直接 429
  ↓
【路由匹配】     没匹配到 → notFoundHandler(404)
  ↓
onRequest hook   路由级：authenticate（校验 JWT）
  ↓
schema 校验      body/query/params 不符合 → throw 400（进 errorHandler）
  ↓
handler          业务逻辑
  ↓
onSend           序列化 + 插件追加响应头
  ↓
onResponse       慢请求日志（reply.elapsedTime）
  ↓
任何环节抛错 → setErrorHandler 统一输出 { error, code, details? }
```

关键认知：**SSE 路由一旦 `reply.hijack()`，从「handler 之后」的整条链路（onSend、插件追加的头、序列化）全部跳过。**

---

## 1. 配置层（config.ts）

### 1.1 环境变量必须在启动时校验

- **结论**：用 zod `safeParse(process.env)`，失败就 `process.exit(1)`。
- **为什么**：配置错误属于「部署期错误」，越早暴露越好。如果等到某个接口被调用才发现 `DATABASE_URL` 为空，故障已经发生在用户侧。
- **后果**：没有校验时，典型表现是「服务能启动、能访问 /health，但某个功能 500」，排查时容易被误导。
- **位置**：`src/config.ts`

### 1.2 业务代码不直接读 process.env

- **结论**：所有环境变量集中到 `config`，其它文件只 `import { config }`。
- **为什么**：`process.env.XXX` 是隐式依赖，散落各处后无法一眼看出「这个服务需要哪些配置」，也无法统一做类型和默认值。
- **位置**：`lib/db.ts` / `lib/redis.ts` / `services/llm.ts` / `server.ts` 全部改成读 `config`

### 1.3 JWT_SECRET 强制 ≥ 32 字符

- **结论**：schema 里写 `min(32)`，不给默认值。
- **为什么**：弱密钥等于没有鉴权 —— 攻击者可以离线爆破出密钥后伪造任意用户。
- **反面教材**：改造前是 `process.env.JWT_SECRET || 'super-secret-key'`，生产忘配就等于把后门开源了。
- **注意**：**不要给密钥兜底默认值**，缺了就应该启动失败。

### 1.4 `isProd` 只控制两件事

- **结论**：日志格式（JSON vs pretty）、错误详情是否对客户端暴露。
- **为什么**：这两个是「环境差异」的正常诉求；业务逻辑不应该按环境分支，否则测试环境和生产行为不一致。

---

## 2. Fastify 框架层

### 2.1 zod 不是 Fastify 内置的

- **结论**：Fastify 内置的是 **JSON Schema** 校验；zod 通过 `fastify-type-provider-zod` 把 zod schema **编译成 JSON Schema** 才能挂上去。
- **为什么容易混淆**：写起来像"Fastify 支持 zod"，实际是第三方适配器。换 `@sinclair/typebox` 是同一位置的另一种选择。
- **环境变量校验和 Fastify 完全无关**，那是裸调 `z.object().safeParse(process.env)`。

### 2.2 插件作用域：`fastify-plugin` 是分水岭

- **结论**：用 `fp()` 包装 → 装饰器/hook 提升到父作用域；不包装 → 只在自己这个子作用域生效。
- **为什么**：`app.register(fn)` 默认会创建一个**新的封装上下文**（类似子容器）。你在里面 `decorate('authenticate')`，外面根本看不见。
- **后果**：不包装时典型报错是 `app.authenticate is not a function`。
- **位置**：`plugins/auth.ts` / `plugins/error-handler.ts` / `plugins/health.ts` 全部用 `fp()` 包装

### 2.3 错误处理「挂在哪个作用域」比「注册顺序」更重要

- **结论**：`setErrorHandler` 是实例级设置，同作用域内与注册顺序无关；关键是**必须挂在根实例上**。
- **为什么**：错误处理会沿着封装链向上查找。挂在根上 → 所有子插件都能兜住；写在普通插件里 → 只兜住那一个插件的路由。
- **常见误解**："必须最先注册才能抓到后面的错" —— 因果关系错了，真正的原因是作用域。
- **实践建议**：仍然放在注册路由之前，纯粹为了可读性（先定义规则，再定义路由）。

### 2.4 路由前缀用 `prefix`，不要写死在路径里

- **结论**：`app.register(chatRoutes, { prefix: '/api' })`，路由文件里只写 `/chat`。
- **为什么**：改版本前缀（`/api` → `/v1`）时只改一处；也便于把一个模块整体挂到不同前缀下。
- **注意**：加了 prefix 后，**路由文件里的路径必须去掉前缀**，否则会变成 `/api/api/chat`（404）。这是迁移时最容易漏的一步。

### 2.5 schema 校验发生在 handler 之前

- **结论**：校验失败直接 400，不会进入 handler。
- **为什么**：省掉一次数据库查询；而且校验逻辑和业务逻辑解耦，handler 里可以放心用 `request.body`，不需要 `as any`。
- **收益**：`routes/sessions.ts` 里三个手写函数（`parseClampedInt` / `normalizeSessionId` / `getUserId`）全部删除。

### 2.6 分页参数的「收敛」 vs 「拒绝」

- **结论**：超出范围时**收敛到边界值**，非法格式回退默认值：
  ```ts
  limit: z.coerce.number().int().min(1).catch(20).transform((v) => Math.min(v, 200))
  ```
- **为什么**：这是**保持原有行为**。改造前用的是 `parseClampedInt`（收敛），如果改成 `max(200)` 会变成 400，属于破坏性变更。
- **教训**：重构时要先确认「原行为是什么」，而不是「我认为怎样更合理」。

---

## 3. 错误处理（plugins/error-handler.ts）

### 3.1 全应用只有一个错误出口

- **结论**：路由里只 `throw`，响应格式由 `setErrorHandler` 统一决定。
- **为什么**：前端只需要处理一种响应结构 `{ error, code, details? }`；新增接口不会因为「忘了写 send」导致格式不一致。

### 3.2 四类错误必须分流

| 类型 | 判定方式 | 输出 | 日志级别 |
|---|---|---|---|
| 业务错误 | `instanceof AppError` | 原状态码 + 原 message | 5xx→error，4xx→warn |
| 参数校验失败 | `error.validation` 存在 | 400 + `VALIDATION_ERROR` + 字段详情 | warn |
| 框架错误 | 有 `statusCode` | 保留原状态码 | warn |
| 未知错误 | 其它 | 500 + `INTERNAL_ERROR` | error |

### 3.3 ⚠️ 4xx 绝对不能兜成 500

- **结论**：框架错误要按 `statusCode` 映射，不能只特判几个就 fallthrough 到 500。
- **为什么**：非法 JSON、body 过大、content-type 错误这些都是**客户端的错**，返回 500 会污染服务端错误率监控，前端也无法正确处理。
- **踩坑记录**：初版只特判了 401/429/413，导致「非法 JSON」返回 500，实测才发现。
- **正确做法**：用映射表兜住整个 4xx 段。

### 3.4 生产环境不返回内部错误信息

- **结论**：`error: isProd ? '服务器内部错误' : error.message`。
- **为什么**：未知错误的 message 里可能含 SQL 语句、文件路径、内网地址，属于信息泄露。
- **注意**：业务错误（AppError）的 message 是**写给用户看的**，可以原样返回，不受这条限制。

### 3.5 日志不要记录请求体

- **结论**：warn 级只记 `{ code, method, url }`，不记 body。
- **为什么**：登录请求的 body 里有明文密码。日志通常会被采集到第三方平台，等于把密码外泄。

---

## 4. 鉴权（plugins/auth.ts + @fastify/jwt）

### 4.1 JWT 是无状态的，只验两件事

- **结论**：`request.jwtVerify()` 只校验**签名**和**过期时间**。
- **为什么重要**：这意味着**退登无法真正生效** —— token 在过期前一直有效，服务端无法撤销。需要「立即失效」时，必须引入黑名单（Redis）或改用 session。
- **当前方案的取舍**：简单、无状态、易水平扩展；代价是无法主动踢人。

### 4.2 `userId` 在运行时是字符串

- **结论**：`JwtPayload.userId` 声明成 `string`，签发时 `String(user.id)`。
- **为什么**：`pg` 会把 `BIGSERIAL`（int8）读成字符串 `"1"`。如果类型写 `number`，TS 会骗你，运行时比较和拼接都会出错。
- **位置**：`plugins/auth.ts` 的 `JwtPayload`、`routes/auth.ts` 的 `app.jwt.sign`

### 4.3 用「路由级 hook」而不是「全局白名单」

- **结论**：
  ```ts
  // 受保护插件内部
  app.addHook('onRequest', app.authenticate);
  ```
- **为什么**：改造前是全局 `onRequest` 里用 `request.url.startsWith('/api/auth/')` 放行。这种写法有两个问题：
  1. 新增 `/api/auth-admin` 会被误放行
  2. 新增受保护路由时容易忘记加白名单之外的处理
- **正确心智**：**默认全都要登录，公开路由显式不挂 hook**（安全默认）。

### 4.4 声明合并让类型可用

- **结论**：`declare module '@fastify/jwt'` 扩展 `FastifyJWT`，`declare module 'fastify'` 扩展 `FastifyInstance`。
- **为什么**：不写的话 `request.user` 是 `unknown`，每个路由都要手写 `as` 断言，类型形同虚设。

### 4.5 401 / 403 / 404 的选择

- **结论**：访问别人的会话 → 返回 **404**（不是 403）。
- **为什么**：403 等于告诉攻击者「这个会话确实存在，只是你没权限」，可以用来探测资源是否存在。404 不泄露存在性。
- **实现方式**：SQL 里 `WHERE user_id = $1 AND session_id = $2`，查不到就是 404。

---

## 5. 安全：三个机制不要混为一谈

这是最容易答错的一块，必须分开记。

| 要解决的问题 | 用哪个机制 | 代码位置 |
|---|---|---|
| 暴力破解密码 | **限流**（登录 5 次/分钟） | `routes/auth.ts` 的 `config.rateLimit` |
| 枚举用户名（试探哪些账号存在） | **统一错误文案**（用户不存在和密码错返回一样） | `if (!user) throw unauthorized('用户名或密码错误')` |
| 新账号密码太弱 | **注册时**要求 8 位 | `registerSchema` 的 `min(8)` |
| 老用户能正常登录 | **登录不校验最小长度** | `loginSchema` 的 `min(1)` |

### 5.1 ⚠️ 登录的密码校验比注册松，不是安全问题，是兼容问题

- **结论**：注册 `min(8)`，登录 `min(1)`。
- **为什么**：库里已有 6~7 位密码的老用户。如果登录也要求 8 位，他们输入**正确**的密码也会被 400 拦住，永远登不进来。
- **踩坑记录**：改造时两个接口共用一个 schema，实测 `admin/123456` 登录被 400 拦截才发现。
- **口诀**：**注册提高下限（面向未来），登录不设下限（尊重历史）。**

### 5.2 bcrypt 只处理前 72 字节

- **结论**：`max(72)`。
- **为什么**：超过 72 字节的部分会被**静默截断**，用户以为密码更长更安全，实际没有；而且超长密码会白白消耗 CPU，可被用来做 DoS。

### 5.3 CORS 三件套

```ts
origin: config.CORS_ORIGIN.split(',').map(s => s.trim()),  // 白名单，不用 origin: true
credentials: true,
methods: ['GET','HEAD','POST','PATCH','DELETE','OPTIONS'], // ⚠️ 必须显式加
```

- **为什么不能用 `origin: true`**：等于允许任何网站带着用户 cookie 调用你的接口。
- **为什么 must 显式写 methods**：默认只有 `GET,HEAD,POST`。本项目用了 `PATCH`（重命名）和 `DELETE`（删除），不加上就会被浏览器预检拦截。
- **预检的特点**：`OPTIONS` 请求**不带 Authorization**（浏览器规范），所以鉴权必须在 cors 之后，否则预检永远 401。`@fastify/cors` 在 `onRequest` 里短路处理，正好满足。

### 5.4 日志里的隐私

- **结论**：生产环境不打印 `llmMessages`（完整对话内容）。
- **位置**：`routes/chat.ts` 的 `if (!isProd) request.log.debug(...)`

---

## 6. 数据库与迁移

### 6.1 migrations 是 schema 的**唯一**源头

- **结论**：本地、测试、生产启动前都跑 `pnpm db:migrate`，不存在"本地 initDb、上线用迁移"。
- **为什么**：两套定义 = 两个真相 = 必然漂移。典型表现是"本地能存 10 万字，生产列只有 varchar(2000)"。
- **位置**：`apps/server/migrations/`、`lib/db.ts` 的 `dbReady` 只查版本不建表

### 6.2 「迁移」≠「db:migrate」

- **迁移**是名词：一个 `.sql` 文件（一条变更记录）
- **`db:migrate`** 是动词：把所有**未执行过**的迁移应用上去
- **`pgmigrations`** 是账本：记录哪些已经执行过

### 6.3 ⚠️ 已执行的迁移文件绝对不能改

两个独立危害：

1. **改动静默失效**（单人就会踩）
   ```text
   你给 init.sql 加了一句 CREATE INDEX
   → 再跑 db:migrate 什么都不执行（已记录）
   → 本地库其实没有这个索引，但你以为加了
   ```
2. **环境之间结构漂移**
   ```text
   同事 A 执行过 v1 → 他的库是 v1
   你改成 v2 提交 → 同事 B 执行得到 v2
   同事 A 再拉代码跑 migrate → 什么也不跑，他还是 v1
   ```

**唯一允许改的时机**：还没被任何数据库执行过（可先 `db:rollback` 回退再改）。一旦提交并有人跑过 → 只能新增修复迁移。

### 6.4 应用启动不做 DDL

- **结论**：`dbReady` 只 `SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1`，查不到就让应用启动失败。
- **为什么**：
  - 多实例并发执行 DDL 会产生锁竞争
  - 大表建索引会让启动超时
  - 应用账号不应该有 DDL 权限
- **这叫 fail fast**：宁可起不来，也不要带着旧 schema 跑新代码。

### 6.5 部署顺序是固定的

```text
备份数据库 → pnpm db:migrate → 启动/滚动更新应用 → 健康检查
```

- **为什么先迁移**：新代码可能依赖新列/新表。
- **为什么迁移要独立执行**：多副本部署时不能让每个容器都跑迁移（advisory lock 会冲突）。

### 6.6 事务的三段式

```ts
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // ... 多条 SQL
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();   // ⚠️ 必须在 finally，否则连接泄漏
}
```

- **为什么 `release()` 必须放 finally**：抛异常时不 release，连接池会被逐渐占满，最终所有请求都卡在"等待连接"。

### 6.7 索引要匹配查询，不是越多越好

- **本项目查询**：`WHERE user_id = $1 AND session_id = $2 ORDER BY id DESC`
- **对应索引**：`(user_id, session_id, id)` —— 等值条件在前，排序字段在后，可以同时满足过滤和排序
- **待优化**：`idx_session_created (session_id, created_at)` 可能是冗余的（已有上面那个复合索引）
- **验证方法**：`EXPLAIN ANALYZE` 看是否走 Index Scan、是否出现 `Sort`（出现说明索引没覆盖排序）

### 6.8 OFFSET 分页的深翻页问题

- **现象**：`OFFSET 100000` 时数据库仍要扫描并丢弃前 10 万行，越翻越慢
- **已采用的方案**：消息列表用**游标分页**（`beforeId` + `id < $4`）
- **待优化**：会话列表还在用 `offset`

### 6.9 时间字段用 BIGINT 存毫秒的取舍

- **现状**：`created_at BIGINT`（`Date.now()`）
- **好处**：和前端 JS 时间戳零转换
- **代价**：SQL 里做时间范围查询/`date_trunc` 很别扭；数据库层面无法用 `timestamptz` 的能力
- **生产更常见**：`timestamptz`。如果改造，需要迁移 + 双写过渡

---

## 7. 缓存（Redis）

### 7.1 cache-aside 三段式

```text
查缓存 → 命中返回 → 未命中查 DB → 回填缓存
```

- **位置**：`lib/session.ts` 的 `getHistory` / `listUserSessions` / `getSessionDetail`

### 7.2 ⚠️ 写操作要「写前失效 + 写后失效」两次

- **为什么不是只失效一次**：
  ```text
  时刻1：写请求 → 删缓存
  时刻2：读请求 → 缓存空 → 查 DB（旧值）→ 回填旧值到缓存
  时刻3：写请求 → 写库完成
  → 缓存里是【旧值】，且永远不会自动纠正（除非 TTL 到期）
  ```
- **写后再次失效**可以吃掉这个窗口里被回填的脏数据。
- **更彻底的做法**（生产）：延迟双删 / 订阅 binlog / 版本号。当前方案是"够用级"。

### 7.3 缓存 key 必须带上 userId

- **结论**：`user:{userId}:v1:session:{sessionId}:messages`
- **为什么**：只带 sessionId 的话，A 用户命中 B 用户的缓存 = 越权泄露数据。

### 7.4 key 里带 `CACHE_VERSION`

- **为什么**：缓存结构变更时改版本号（v1→v2），旧 key 自然失效，不需要写清理脚本。

### 7.5 Redis 失败必须降级

- **结论**：所有 Redis 调用都 `.catch(() => {})`，失败就当没缓存。
- **为什么**：Redis 是**加速层**不是**数据源**，它挂了不应该让整个服务不可用。
- **反例**：如果 Redis 异常直接抛错，一次 Redis 抖动会让所有对话请求 500。

---

## 8. SSE / 流式输出

### 8.1 `reply.hijack()` 的真正含义

- **结论**：告诉 Fastify「这个响应我接管了」，从此刻起**跳过 Fastify 的整个响应管道**。
- **被跳过的内容包括**：
  - `onSend` 钩子
  - 所有插件通过 `reply.header()` 挂的头（**CORS、rate-limit 头都在这里**）
  - 返回值序列化
- **所以必须**：
  ```ts
  const inherited = reply.getHeaders();  // 先抢救
  reply.hijack();
  reply.raw.writeHead(200, { ...inherited, 'Content-Type': 'text/event-stream' });
  ```
- **踩坑记录**：不搬 CORS 头时，浏览器报 `No 'Access-Control-Allow-Origin' header`，表现是"发消息直接 Failed to fetch"，而 curl 测试完全正常（curl 不校验 CORS）。

### 8.2 心跳是必须的，不是优化

- **结论**：每 15s 写一个 `: ping\n\n` 注释帧。
- **为什么**：Nginx / 云负载均衡默认 60s 空闲就断开长连接。没有心跳时，用户"思考超过 1 分钟再继续"就会看到流断掉。

### 8.3 关闭判断要查两个状态

```ts
const isClosed = () => reply.raw.writableEnded || reply.raw.destroyed;
```

- `writableEnded`：我们主动 `end()` 过
- `destroyed`：客户端断开 / socket 出错
- **漏掉的后果**：往已关闭的流写入会抛 `ERR_STREAM_WRITE_AFTER_END`，导致进程里出现未捕获异常

### 8.4 中断 → 不落库

- **结论**：只有 `!aborted && completed && assistantContent` 才写数据库。
- **为什么**：用户点停止后，存下半截回答会污染后续上下文（模型以为之前就是这么说的）。

### 8.5 「用户取消」和「服务端超时」必须分开

- **现状**：两个信号都用 `AbortController`，SDK 抛的都是 `AbortError`，无法区分。
- **解法**：判断 `timeoutController.signal.aborted && !signal.aborted` → 抛自定义 `LlmTimeoutError`。
- **为什么重要**：日志要正确归因（是用户行为还是服务故障）；前端也要给不同提示（"已停止" vs "超时请重试"）。
- **反面教材**：初版在 `finally` 里无条件 `throw AbortError`，把超时也报成"客户端取消"。

### 8.6 `data: [DONE]` 是约定，不是协议

- SSE 协议本身没有"结束标记"，这是 OpenAI 流式接口的约定。
- 前端看到 `[DONE]` 就停止读取并认为生成完成。

### 8.7 前端必须做「缓冲拼接」

- **为什么**：一个 SSE 事件可能被 TCP 拆成两次 `read()`。直接对每次 chunk 做 `JSON.parse` 会随机失败。
- **做法**：累积到 buffer，按 `\n\n` 切分，**剩下不完整的留在 buffer 里等下次**。
- **位置**：`apps/web/src/lib/chat.ts`

---

## 9. 工程化 / 运维

### 9.1 `/health` 和 `/ready` 是两种语义，不是"缺一不可"

| 接口 | 检查什么 | 失败时调度器做什么 |
|---|---|---|
| `/health`（liveness） | **只检查进程自己**，绝不查依赖 | **重启**容器 |
| `/ready`（readiness） | 所有外部依赖（PG + Redis） | **摘掉流量**，不重启 |

- **为什么 `/health` 绝不能查数据库**：
  ```text
  DB 抖动 10s → 所有实例 /health 失败 → K8s 重启所有容器
  → 重启中的实例也不能服务 → DB 压力更大 → 雪崩
  ```
- **`/ready` 不只查数据库**：所有"没有它就无法正确服务"的依赖都要查（当前是 PG + Redis）。
- **注意**："主备切换"是数据库自己的事，应用只关心"能不能连上"。

### 9.2 优雅关闭要做的三件事

```ts
await app.close();   // 1. 停止接收新请求，等正在处理的请求完成
await closeRedis();  // 2. 关 Redis
await closeDb();     // 3. 关连接池
```

- **为什么**：直接 kill 会切断进行中的 SSE 和数据库事务；容器滚动发布时会造成用户请求失败。
- **必须有超时兜底**：10s 还没关完就 `process.exit(1)`，否则容器会一直卡在 terminating。
- **信号**：`SIGTERM`（docker stop / k8s 默认）、`SIGINT`（Ctrl+C）。

### 9.3 慢请求日志

- **结论**：`onResponse` 里判断 `reply.elapsedTime > 1000` 就打 warn。
- **为什么**：业务日志只记"成功/失败"，记不了"变慢了"。慢请求往往是故障的前兆（比如索引失效、连接池不够）。

### 9.4 requestId

- **结论**：优先用上游传的 `x-request-id`，没有就 `randomUUID()`。
- **为什么**：微服务/网关场景下，同一个用户请求会跨多个服务，用同一个 id 才能把日志串起来。

---

## 10. 前端配套

### 10.1 服务端才是历史记录的真相来源

- **结论**：登录后先拉 `/api/sessions` 合并本地，再按需拉详情。
- **为什么**：改造前会话只存在 localStorage，清空后前端生成新 UUID → 查一个不存在的 sessionId → 页面空白。
- **心智**：localStorage 是**缓存/草稿**，不是数据源。

### 10.2 前端表单校验要和后端对齐

- **现状**：注册 8 位、登录不限，两端一致。
- **为什么**：不一致时会出现"前端放行、后端 400"的割裂体验；或者更糟 —— 前端比后端松，用户以为能注册，提交后才报错。

### 10.3 错误事件要解析 JSON

```ts
const parsed = JSON.parse(data) as { code?: string; message?: string };
throw new Error(parsed.message ?? '模型服务异常');
```

- **为什么**：后端 SSE 错误帧是 `{"code":"MODEL_TIMEOUT","message":"..."}`。直接把整个字符串 `throw` 出去，用户会看到一坨 JSON。

---

## 11. 已知坑清单（踩过的）

- CORS `methods` 默认只有 `GET,HEAD,POST` → `PATCH`/`DELETE` 预检被浏览器拦截
- `reply.hijack()` 后必须 `reply.getHeaders()` 抢救 CORS / 限流头，否则浏览器报 `Failed to fetch`（curl 测不出来）
- 错误处理不能一律 500 → 4xx 必须保留原状态码（非法 JSON 曾经被兜成 500）
- 登录密码校验不能和注册一样严 → 老用户会被 400 拦住（`admin/123456` 实测复现）
- `/health` 绝不能查数据库 → 否则依赖抖动会引发滚动重启雪崩
- 改已执行的迁移文件 = 改动**静默不生效** + 环境漂移（不是"会报错"）
- 加了 `prefix` 后路由文件里的路径必须去掉前缀，否则变成 `/api/api/xxx`
- 普通插件里的 `decorate` 外部看不见，必须 `fastify-plugin` 包装
- 分页参数重构要确认原行为（收敛 vs 拒绝），否则是破坏性变更
- 缓存写操作只删一次会有并发回填脏数据的窗口

---

## 12. 还没做的（第 1 件后半段）

- [ ] 外键：`chat_message.user_id` → `users.id`（当前是 TEXT 无约束，可以插出不存在的用户）
- [ ] 索引审计：`idx_session_created` 是否冗余，用 `EXPLAIN ANALYZE` 验证
- [ ] 会话列表的 `OFFSET` 深分页改造
- [ ] 时间字段从 `BIGINT` 迁到 `timestamptz`（需双写过渡）
- [ ] 迁移账号与应用账号的权限分离（应用账号不给 DDL 权限）

---

## 13. 自我检验题

不看代码，能答出下面这些就算过：

1. 为什么 `/ready` 要查 Redis，`/health` 却什么都不查？
2. 为什么两个插件要包 `fastify-plugin`？不包会怎样？
3. 为什么 `hijack` 之后 CORS 头会消失？怎么修？
4. 登录密码为什么允许比注册短？
5. 防爆破、防枚举、密码强度分别靠什么实现？
6. 迁移文件为什么执行后不能改？说出两个独立的危害。
7. `dbReady` 为什么不建表？它失败意味着什么？
8. 为什么写缓存要失效两次？
9. 为什么"用户取消"和"超时"要抛不同的错误？
10. 为什么用户点了停止就不该把半截回答存库？