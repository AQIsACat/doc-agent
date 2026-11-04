# Doc-Agent Monorepo

AI 文档助手，前端与后端放在同一个 pnpm workspace 中管理。

## 目录结构

```text
doc-agent/
├─ apps/
│  ├─ server/          # Fastify + PostgreSQL + Redis 后端
│  │  ├─ src/
│  │  ├─ .env          # 本地环境变量（不提交）
│  │  └─ tsconfig.json
│  └─ web/             # React + Vite + Ant Design 前端
│     ├─ src/
│     ├─ vite.config.ts
│     └─ tsconfig*.json
├─ package.json        # workspace 根脚本
├─ pnpm-workspace.yaml
└─ pnpm-lock.yaml
```

## 环境要求

- Node.js >= 20
- pnpm >= 12（仓库使用 pnpm workspace）

## 安装

```bash
pnpm install
```

## 环境变量

后端：

```bash
# Windows PowerShell
Copy-Item apps/server/.env.example apps/server/.env

# macOS / Linux
cp apps/server/.env.example apps/server/.env
```

然后填写 `apps/server/.env` 中的 `DEEPSEEK_API_KEY`、`DATABASE_URL`、`REDIS_URL` 等配置。

前端默认请求 `http://localhost:3000`。如果需要修改，复制 `apps/web/.env.example` 为 `apps/web/.env` 并调整 `VITE_API_BASE_URL`。

## 开发

```bash
# 同时启动后端和前端
pnpm dev

# 只启动后端（http://localhost:3000）
pnpm dev:server

# 只启动前端（http://localhost:5173）
pnpm dev:web
```

## 构建与检查

```bash
# 构建后端（tsc -> apps/server/dist）和前端（vite build）
pnpm build

# 前后端 TypeScript 类型检查
pnpm typecheck

# 启动构建后的后端
pnpm start
```

## 后端接口概览

- `POST /api/auth/register`、`POST /api/auth/login`
- `POST /api/chat`（SSE 流式对话）
- `GET /api/sessions`（当前用户历史记录列表）
- `GET /api/sessions/:sessionId/messages`（会话上下文详情，支持 `limit`、`beforeId`）
- `PATCH /api/sessions/:sessionId`（重命名）
- `DELETE /api/sessions/:sessionId`（删除）

除 `/api/auth/*` 和 `/health` 外，接口都需要 `Authorization: Bearer <token>`。
