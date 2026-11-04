# Doc-Agent 自测题（10 道）

> 配套文档：[NOTE.md](./NOTE.md)

## 怎么用

1. **先不看答案**，用嘴把自己的理解说出来（说出来比在想更难，能暴露"以为自己懂"）。
2. 说不下去 = 没掌握，去看 NOTE.md 对应章节。
3. 再展开 `<details>` 对答案，重点看「你漏了什么」而不是「你对了几分」。
4. 三天后再测一次。能连续两次不看资料答全，才算真的会。

**评分标准**

| 等级 | 标准 |
|---|---|
| ✅ 掌握 | 能说出结论 + 原因 + 一个具体后果 |
| 🟡 半懂 | 能说出结论，说不出原因（= 背的，不算会） |
| ❌ 不会 | 结论也说错 |

**自评记录**

| 题号 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |

---

## 第 1 题　`/ready` 和 `/health` 的职责边界

> 为什么 `/ready` 要查 Redis，`/health` 却什么都不查？

**考点**：两个接口服务于两种完全不同的调度决策。

<details>
<summary>查看答案</summary>

### 它们服务于不同的人

| 接口 | 谁在调 | 失败后做什么 |
|---|---|---|
| `/health`（liveness） | K8s / Docker | **重启容器** |
| `/ready`（readiness） | 负载均衡 / Service | **摘掉流量，不重启** |

### 为什么 `/health` 绝不能查数据库

```
数据库抖动 10 秒
  ↓
所有实例的 /health 全部失败
  ↓
K8s 判定"所有容器都挂了" → 全部重启
  ↓
重启中的容器也无法服务 → 请求全部失败
  ↓
数据库压力反而更大 → 抖动时间更长
  ↓
雪崩
```

`/health` 的唯一职责是回答「**这个进程还活着吗**」。只要它能返回 200，就说明事件循环没卡死、进程没崩。它连数据库都不该碰。

### 为什么 `/ready` 要查 Redis（不只是数据库）

`/ready` 回答的是「**我现在能不能正确服务请求**」。

判断标准是：**没有它，请求就会失败或降级到不可接受**。

本项目里：

```ts
await pool.query('SELECT 1');   // 没有 PG，一切业务都做不了
await redis.ping();             // 没有 Redis，对话上下文全丢（虽然会降级查库，但性能崩溃）
```

以后加了对象存储 / 消息队列，也应该加到这里。

### 一个常见误解

> "数据库主备切换好了才能接流量"

主备切换是**数据库自己**的事，应用完全不感知。应用只关心一件事：**我这条 SQL 能不能执行成功**。主库挂了、备库顶上，只要连接成功 `/ready` 就是 200。

### 一句话版本

> `/health` 只回答"我还活着吗"（挂了就重启）；`/ready` 回答"我现在能干活吗"（挂了就摘流量）。前者绝不查依赖，否则依赖抖动会引发全员重启雪崩。

### 代码位置

- `apps/server/src/plugins/health.ts`

</details>

---

## 第 2 题　`fastify-plugin` 到底改变了什么

> 为什么两个插件要包 `fastify-plugin`？不包会怎样？

**考点**：Fastify 的封装（encapsulation）模型。

<details>
<summary>查看答案</summary>

### Fastify 默认是「封装」的

```ts
app.register(somePlugin);   // 默认会创建一个【子作用域】
```

在子作用域里：

- `decorate()` 加的东西，**父级和兄弟看不见**
- `addHook()` 加的钩子，**只作用于这个子作用域的路由**
- `setErrorHandler()` 设的处理函数，**只管这个子作用域**

### `fastify-plugin` 做的事

```ts
export default fp(async (app) => {
  app.decorate('authenticate', ...);
});
```

`fp()` 会告诉 Fastify：**这个插件的内容要提升到父作用域**。

### 不包的后果

| 插件 | 不包的报错 |
|---|---|
| `plugins/auth.ts` | `app.authenticate is not a function`（路由里调不到） |
| `plugins/error-handler.ts` | 错误处理只在那个子容器生效，业务路由的错误走 Fastify 默认响应（格式不统一） |
| `plugins/health.ts` | 路由注册在子作用域，`/health` 实际能访问（因为路由是注册而非装饰），但如果有装饰器就不行 |

### 怎么判断该不该包

```text
这个插件是在「给应用加能力」还是「在应用里加一组路由/逻辑」？
                                   ↓
             加能力（decorate/hook/errorHandler）  → 用 fp()
             只是注册一批路由                        → 可以用普通 async 函数
```

本次改造里，三个 plugin 都是「加能力」，所以全部 `fp()`。

### 一句话版本

> `app.register()` 默认开子容器，`fp()` 把它拍平到父级。凡是 `decorate` / 全局 hook / `setErrorHandler` 的插件，必须包。

### 代码位置

- `apps/server/src/plugins/auth.ts`
- `apps/server/src/plugins/error-handler.ts`
- `apps/server/src/plugins/health.ts`

</details>

---

## 第 3 题　`hijack` 与 CORS 头

> 为什么 `hijack` 之后 CORS 头会消失？怎么修？

**考点**：Fastify 响应管道被打断后，插件挂的头不会自动落地。

<details>
<summary>查看答案</summary>

### 头的生命周期

```text
@fastify/cors 执行 reply.header('access-control-allow-origin', '...')
  ↓
这个头只是【挂】在 reply 对象上，还在内存里
  ↓
正常流程：handler 返回 → Fastify 序列化 → onSend → 真正 writeHead 到 socket
  ↓
hijack 了 → 你直接 reply.raw.writeHead() → 上面那条链整个跳过
  ↓
头永远挂着，客户端收不到
```

所以丢的不只是 CORS：

- `@fastify/rate-limit` 的 `x-ratelimit-*`
- 任何你在 handler 里 `reply.header()` 设过的头

### 修复

```ts
const inherited = reply.getHeaders();   // 1. 先抢救出来
reply.hijack();                          // 2. 再接管
reply.raw.writeHead(200, {               // 3. 手工带上
  ...inherited,
  'Content-Type': 'text/event-stream; charset=utf-8',
});
```

### 为什么这个 bug 特别阴

| 测试方式 | 结果 |
|---|---|
| `curl` 发请求 | ✅ 完全正常（curl 不校验 CORS） |
| 浏览器发请求 | ❌ `Failed to fetch` |

只有真跑浏览器才能发现。这是「单元测试/接口测试通过但线上挂掉」的典型代表。

### 一句话版本

> `hijack` 让你绕过 Fastify 的响应管道，插件挂在 reply 上的头（CORS、限流）不会自动写出去，必须 `getHeaders()` + 手动带上。

### 代码位置

- `apps/server/src/lib/sse.ts` 的 `openSseStream`

</details>

---

## 第 4 题　登录密码为什么可以更短

> 登录密码为什么允许比注册短？

**考点**：这是兼容性问题，不是安全问题。

<details>
<summary>查看答案</summary>

### 真实原因：不改写历史

```text
改造前：前端注册最低 6 位，后端不校验长度
  ↓
库里已经有一批 6~7 位密码的老用户
  ↓
改造时给 register 加了 min(8)
  ↓
如果 login 复用同一个 schema
  ↓
老用户输入【正确】的 6 位密码 → 被 400 "密码最多.../至少 8 位" 拦住
  ↓
他永远登不进来
```

这不是理论推演，是改造时实测发现的：`admin/123456` 登录返回 400。

### 正确做法

```ts
// 注册：提高新账号下限
const registerSchema = z.object({
  password: z.string().min(8, '密码至少 8 位').max(72),
});

// 登录：只校验非空，不校验长度下限
const loginSchema = z.object({
  password: z.string().min(1, '请输入密码').max(72),
});
```

### 两个 schema 的职责不同

| | 注册 | 登录 |
|---|---|---|
| 目的 | **约束新数据** | **校验已有数据** |
| 能不能加新规则 | 可以（面向未来） | 不行（历史已存在） |
| 密码长度 | `min(8)` | `min(1)` |

### 顺带：为什么上限都是 72

bcrypt 只处理前 72 字节，超出的部分被**静默截断**。设 `max(72)` 是为了明确告诉用户，而不是让他以为 100 位密码更安全。

### 一句话版本

> 注册提高下限（管未来），登录不设下限（尊重历史）。这不是安全策略差异，是数据兼容差异。

### 代码位置

- `apps/server/src/routes/auth.ts`
- `apps/web/src/components/LoginPage.tsx`

</details>

---

## 第 5 题　三个安全机制不要混

> 防爆破、防枚举、密码强度分别靠什么实现？

**考点**：三个独立问题，三个独立手段。

<details>
<summary>查看答案</summary>

| 要防的事 | 攻击者想干什么 | 对应手段 | 代码位置 |
|---|---|---|---|
| **暴力破解** | 不断试密码，撞出来 | **限流**：登录 5 次/分钟 | `routes/auth.ts` 的 `config.rateLimit` |
| **枚举用户名** | 试探哪些账号真实存在（为下一步爆破做准备） | **统一错误文案**：用户不存在和密码错误返回一模一样 | `if (!user) throw unauthorized('用户名或密码错误')` |
| **弱密码** | 用户自己设 `123456` | **注册时**要求 8 位 | `registerSchema` 的 `min(8)` |

### 为什么不能互相替代

- 只有限流：攻击者可以换 IP 慢慢试，用户名还是能被枚举出来
- 只有统一文案：攻击者可以无限试密码
- 只有密码强度：已存在的弱密码账号依然危险

三个都要有。

### 一个典型的错误答案

> "登录不校验长度是为了防止别人恶意重试获取用户名"

这句话把三件事揉成一团，而且逻辑不通 —— **密码长度校验和防枚举没有任何关系**。防枚举靠的是「两种失败返回相同提示」，和长度无关。

而且真正的风险点在于：**限制长度会让合法用户登不进来**，副作用远大于收益。

### 一句话版本

> 限流防爆破、统一文案防枚举、注册 min(8) 管密码强度 —— 三件事三个机制，别混着记。

### 代码位置

- `apps/server/src/routes/auth.ts`

</details>

---

## 第 6 题　迁移文件为什么执行后不能改

> 迁移文件为什么执行后不能改？说出**两个独立的**危害。

**考点**：迁移是「变更日志」，不是「当前结构快照」。

<details>
<summary>查看答案</summary>

### 危害 ①：改动静默失效（单人开发就会踩）

```text
你本地库已经跑过 init.sql，pgmigrations 里有记录
  ↓
你给 init.sql 加了一句 CREATE INDEX
  ↓
再跑 pnpm db:migrate → 什么都不执行（init 已有记录）
  ↓
你的本地库【没有】这个索引
  ↓
但你以为加了，还基于这个假设去优化查询、判断性能
```

**注意**：不会报错。这是最坑的地方 —— 不是"报错提醒你"，而是"安静地什么都不做"。

### 危害 ②：环境之间结构漂移

```text
同事 A 执行过 v1        → 他的库 = v1
你改成 v2 并提交        → 新同事 B 执行得到 v2
同事 A 再拉代码跑 migrate → 什么也不跑，他还是 v1
  ↓
团队里同时存在两套结构，且没人知道
```

### 两个危害是独立的

- 就算你一个人开发，也会踩 ①
- 就算你只改注释，也会踩 ②（因为文件内容变了，但语义没变，最难排查）

### 唯一允许改的时机

```text
这个迁移【没有被任何数据库执行过】
  ↓
例如：刚 create 出来还没 migrate
或者：本地跑过但还没提交，可以先 db:rollback 再改
```

一旦提交并被别人/别的环境执行过 → **只能新增一条修复迁移**。

### 正确的补救方式

发现 `init.sql` 漏了索引：

```bash
# ❌ 回去改 init.sql
# ✅ 新增一个迁移
pnpm db:create add-missing-index --migration-file-language sql
```

### 一句话版本

> 迁移是不可篡改的变更日志。改了不会重跑（静默失效），还会让不同环境跑到不同版本的 SQL（漂移）。

### 代码位置

- `apps/server/migrations/*.sql`
- `apps/server/scripts/db-status.mjs`（`pgmigrations` 就是账本）

</details>

---

## 第 7 题　`dbReady` 为什么不建表

> `dbReady` 为什么不建表？它失败意味着什么？

**考点**：应用启动的职责边界 + fail fast。

<details>
<summary>查看答案</summary>

### 现在的 `dbReady` 只做一件事

```ts
export const dbReady = (async () => {
  const { rows } = await pool.query(
    'SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1',
  );
  console.log(`[pg] connected, schema version: ${rows[0]?.name}`);
})();
```

只查迁移版本，不执行任何 DDL。

### 为什么启动时不能建表（四个理由）

| # | 理由 | 具体后果 |
|---|---|---|
| 1 | **多实例并发** | 3 个副本同时启动，同时 `CREATE INDEX` → 锁等待、启动超时 |
| 2 | **大表阻塞** | 表有 1000 万行时建索引要几十秒，启动时间不可控 |
| 3 | **权限过大** | 应用账号有 DDL 权限 = 一个 SQL 注入就能 `DROP TABLE` |
| 4 | **无法回滚/审计** | 没有版本记录，不知道上次改了什么、怎么退回去 |

### 它失败意味着什么

```text
失败 = 数据库连不上，或者【没有跑过迁移】
  ↓
应用直接退出（fail fast）
```

**这是故意的**。宁可起不来，也不要带着旧 schema 跑新代码 —— 那种情况下的 500 会让你以为是业务 bug，实际是 schema 不匹配，排查成本高十倍。

### 部署时的正确顺序

```text
备份 → pnpm db:migrate → 启动应用 → 健康检查
```

迁移是**部署流程的一步**，不是**应用启动的一部分**。

### 一个容易混淆的点

> "那本地开发怎么办？每次都要手动跑迁移？"

是的。而且这是好事：新同事 clone 后只要 `createdb` + `pnpm db:migrate`，就能得到和所有人完全一致的结构。如果让应用自动建表，每个人库里的结构都会因为执行时机不同而略有差异。

### 一句话版本

> 启动只检查版本、不建表（避免并发/阻塞/权限/审计问题）；失败即退出，是刻意的 fail fast。

### 代码位置

- `apps/server/src/lib/db.ts` 的 `dbReady`
- `apps/server/src/server.ts` 的 `await dbReady`

</details>

---

## 第 8 题　为什么写缓存要失效两次

> 为什么写缓存要失效两次？

**考点**：cache-aside 模式的并发漏洞。

<details>
<summary>查看答案</summary>

### 只删一次的漏洞

```text
时刻 1：写请求 W → 删除缓存
时刻 2：读请求 R → 缓存空 → 查数据库（读到【旧值】）
时刻 3：写请求 W → 写库完成
时刻 4：读请求 R → 把【旧值】回填到缓存
  ↓
缓存里长期是旧值，直到 TTL 到期
```

问题是：**读请求在「删除缓存」之后、「写库完成」之前查库，拿到的是旧数据，然后把它写回缓存。**

### 两次失效如何解决

```ts
await redis.del(key);              // ① 写库前删：防止读到旧缓存
await insertMessages(...);          // 写库
await redis.del(key);              // ② 写库后再删：清掉上面窗口里被回填的旧值
```

第二次删除把「时刻 4 回填的脏数据」抹掉。

### 为什么 ① 不能省

如果只在写库后删：写库期间读请求可能一直命中旧缓存，而且如果第二次删除失败，脏数据一直存在。前面先删一次能大幅缩小窗口。

### 更彻底的方案（生产级）

| 方案 | 说明 |
|---|---|
| 延迟双删 | 第二次删除延迟几百毫秒，进一步覆盖主从延迟 |
| 订阅 binlog（Canal/Debezium） | 数据库变更驱动缓存失效，最可靠 |
| 版本号 | 缓存里带版本，读时比对 |
| 直接不缓存 | 数据量小时最简单可靠 |

当前方案是「够用级」：TTL + 双删。

### 一句话版本

> 只删一次会留下「读请求用旧值回填缓存」的窗口；写前删 + 写后删，第二次把脏数据抹掉。

### 代码位置

- `apps/server/src/lib/session.ts` 的 `saveHistory` / `invalidateSessionCaches`

</details>

---

## 第 9 题　取消 vs 超时

> 为什么"用户取消"和"超时"要抛不同的错误？

**考点**：`AbortController` 的语义歧义。

<details>
<summary>查看答案</summary>

### 问题的根源

```ts
const timeoutController = new AbortController();
setTimeout(() => timeoutController.abort(), 30_000);
const merged = AbortSignal.any([signal, timeoutController.signal]);
```

两个信号合并后，**任意一个触发，SDK 抛出的都是 `AbortError`**。从错误本身看不出是谁触发的。

### 为什么必须区分

| 维度 | 用户取消 | 服务端超时 |
|---|---|---|
| 归因 | 用户的正常行为 | **服务/模型故障** |
| 日志级别 | `info`（不算错误） | `warn`（需要关注） |
| 前端提示 | "已停止生成" | "超时，请重试" |
| 监控指标 | 不应计入错误率 | 应该计入错误率 |

如果混在一起：

- 超时会伪装成"用户取消"，故障率看起来是 0（**监控瞎了**）
- 用户点停止会看到"模型服务异常"（**体验错乱**）

### 解法

```ts
catch (err) {
  if (timeoutController.signal.aborted && !signal.aborted) {
    throw new LlmTimeoutError(timeoutMs);   // 超时
  }
  throw err;                                 // 用户取消 / 其他网络错误
}
```

判据：**超时控制器触发了，但用户信号没触发** → 一定是超时。

### 反面教材

初版在 `finally` 里无条件 `throw new DOMException('Aborted', 'AbortError')`：

```ts
finally {
  clearTimeout(timeoutId);
  if (mergedSignal.aborted) throw new DOMException('Aborted', 'AbortError');
}
```

结果：连正常完成时也可能被误判；而且超时全被记成"客户端取消"。

### 一句话版本

> 两个 AbortSignal 合并后错误无法区分来源，必须靠"谁被触发"反推；否则超时会伪装成用户取消，监控和提示都会错。

### 代码位置

- `apps/server/src/services/llm.ts`
- `apps/server/src/routes/chat.ts` 的 catch 分支

</details>

---

## 第 10 题　中断时为什么不落库

> 为什么用户点了停止就不该把半截回答存库？

**考点**：上下文一致性。

<details>
<summary>查看答案</summary>

### 现在的条件

```ts
if (!aborted && completed && assistantContent) {
  await saveHistory(...);
}
```

三个条件缺一不可：

| 条件 | 含义 |
|---|---|
| `!aborted` | 客户端没断开 |
| `completed` | 流正常跑完（没抛错） |
| `assistantContent` | 有实际内容（避免存空消息） |

### 为什么半截回答不能存

```text
用户问："帮我写一个完整的登录接口"
模型输出到一半，用户点了停止
  ↓
如果存库：user 消息 + "import express from 'express'..." （半截）
  ↓
下一轮对话时，模型看到自己上次只说了半句
  ↓
它会以为上次的回答就是这样，可能接着半句话继续，或者误解上下文
```

更糟的情况：模型在写代码写到一半，下一轮问"帮我优化一下"，它会基于残缺代码优化。

### 那用户想看已经生成的部分怎么办

前端已经显示了，这就是"本次可见"。

如果想支持"保留已生成部分"，正确做法是：

1. 落库时打标记 `truncated: true` 或 `finish_reason: 'aborted'`
2. 下一轮拼上下文时，把这类消息**标记为不完整**，或者在提示里说明

而不是无脑当正常消息存进去。

### 反过来：为什么"正常完成"一定要存

因为历史的唯一真相来源是数据库（不是 localStorage）。不存的话刷新就丢了。

### 一个细节：`assistantContent` 非空

如果模型一个字都没输出就报错了，没必要往库里塞两条（user 有内容、assistant 空）。前端此时会把占位气泡删掉（`App.tsx` 里的 finally），数据库也不该留垃圾。

### 一句话版本

> 半截回答进入历史会污染后续上下文；只有"正常完成且有内容"才落库，中断和报错都不存。

### 代码位置

- `apps/server/src/routes/chat.ts` 的 `finally` 块
- `apps/web/src/App.tsx` 的 `sendMessage` finally（前端删占位气泡）

</details>

---

## 全部答完之后

如果 10 题里能 ✅ 8 题以上，可以进入下一阶段（第 1 件后半段：外键、索引 `EXPLAIN`、深分页）。

如果有 3 题以上是 🟡 或 ❌，建议先做一件事：**把对应章节的代码删掉重写一遍**。概念题答不出来，通常是因为代码没手过。