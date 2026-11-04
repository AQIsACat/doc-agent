import { Pool } from 'pg';
// 统一从 config 取连接串（已在启动时做过必填校验）
import { config } from '../config.js';

/**
 * 全局连接池。
 * 用 Pool 而不是单连接：并发请求各自借用一条连接，用完归还，避免互相阻塞。
 * export 出来是为了 /ready 探活和优雅关闭时能直接操作它。
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // 池内最多 10 条连接。设太大反而会和数据库的 max_connections 抢资源
  max: 10,
  // 空闲连接 30s 后释放，避免长期占用数据库连接
  idleTimeoutMillis: 30_000,
  // 拿不到连接时最多等 5s 就报错，而不是无限挂起（否则请求会一直不返回）
  connectionTimeoutMillis: 5_000,
});

// 空闲连接被数据库/网络中断时会触发这里。
// 必须监听，否则 pg 会抛出未捕获的 error 事件导致进程崩溃。
pool.on('error', (err) => {
  console.error('[pg] pool error:', err.message);
});

/**
 * 优雅关闭时调用：等待所有连接归还后关闭池。
 * 不关闭的话进程会因为有活跃句柄而无法正常退出。
 */
export const closeDb = async (): Promise<void> => {
  await pool.end();
};

/**
 * 应用启动时只检查数据库和迁移版本，不执行任何 DDL。
 * 如果没跑迁移，这里会直接失败，避免带病启动。
 */
export const dbReady = (async () => {
  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1',
  );
  console.log(`[pg] connected, schema version: ${rows[0]?.name ?? 'none'}`);
})().catch((e) => {
  console.error('[pg] database not ready. Did you run `pnpm db:migrate`?', e);
  throw e;
});

export type DbMessage = {
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
};

export type SessionSummary = {
  sessionId: string;
  title: string;
  lastMessage: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type SessionMessage = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
};

export type SessionMessagesPage = {
  messages: SessionMessage[];
  hasMore: boolean;
  nextBeforeId: number | null;
};

type SessionRow = {
  session_id: string;
  title: string;
  last_message: string;
  message_count: number;
  created_at: string | number;
  updated_at: string | number;
};

function mapSessionRow(row: SessionRow): SessionSummary {
  return {
    sessionId: row.session_id,
    title: row.title,
    lastMessage: row.last_message,
    messageCount: Number(row.message_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '新会话';
  const chars = Array.from(normalized);
  return chars.length > 50 ? `${chars.slice(0, 50).join('')}…` : normalized;
}

function toMessagePreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length > 200 ? `${chars.slice(0, 200).join('')}…` : normalized;
}

/**
 * 事务写入消息，并同步维护 chat_session 的标题/最后一条消息/条数/更新时间。
 */
export async function insertMessages(
  userId: string | number,
  sessionId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<void> {
  if (messages.length === 0) return;

  const uid = String(userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const startedAt = Date.now();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      await client.query(
        `INSERT INTO chat_message (user_id, session_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [uid, sessionId, m.role, m.content, startedAt + i],
      );
    }

    const firstUser = messages.find((m) => m.role === 'user');
    const last = messages[messages.length - 1];
    const title = toSessionTitle(firstUser?.content ?? last.content);
    const lastMessage = toMessagePreview(last.content);
    const updatedAt = startedAt + messages.length - 1;

    await client.query(
      `INSERT INTO chat_session
         (user_id, session_id, title, last_message, message_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, session_id) DO UPDATE SET
         title = CASE
                   WHEN chat_session.title = '新会话' AND EXCLUDED.title <> '新会话'
                   THEN EXCLUDED.title
                   ELSE chat_session.title
                 END,
         last_message = EXCLUDED.last_message,
         message_count = chat_session.message_count + EXCLUDED.message_count,
         updated_at = GREATEST(chat_session.updated_at, EXCLUDED.updated_at)`,
      [uid, sessionId, title, lastMessage, messages.length, startedAt, updatedAt],
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 查最近 N 条，返回时间正序
 */
export async function getRecentMessages(
  userId: string | number,
  sessionId: string,
  limit = 12,
): Promise<DbMessage[]> {
  const res = await pool.query(
    `SELECT role, content, created_at
     FROM chat_message
     WHERE user_id = $1 AND session_id = $2
     ORDER BY id DESC
     LIMIT $3`,
    [String(userId), sessionId, limit],
  );
  // BIGINT 会被 pg 解析成字符串，这里统一转成 number
  return (res.rows as Array<Omit<DbMessage, 'created_at'> & { created_at: string | number }>)
    .map((row) => ({
      role: row.role,
      content: row.content,
      created_at: Number(row.created_at),
    }))
    .reverse();
}

/**
 * 当前用户的历史记录列表，最近更新的会话排在前面
 */
export async function getUserSessions(
  userId: string | number,
  limit: number,
  offset: number,
): Promise<SessionSummary[]> {
  const res = await pool.query(
    `SELECT session_id, title, last_message, message_count, created_at, updated_at
     FROM chat_session
     WHERE user_id = $1
     ORDER BY updated_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [String(userId), limit, offset],
  );
  return (res.rows as SessionRow[]).map(mapSessionRow);
}

export async function getSession(
  userId: string | number,
  sessionId: string,
): Promise<SessionSummary | null> {
  const res = await pool.query(
    `SELECT session_id, title, last_message, message_count, created_at, updated_at
     FROM chat_session
     WHERE user_id = $1 AND session_id = $2`,
    [String(userId), sessionId],
  );
  const row = res.rows[0] as SessionRow | undefined;
  return row ? mapSessionRow(row) : null;
}

/**
 * 会话上下文详情，按 id 倒序取一页后转成时间正序。
 * beforeId 用于「加载更早的消息」。
 */
export async function getSessionMessages(
  userId: string | number,
  sessionId: string,
  limit: number,
  beforeId?: number,
): Promise<SessionMessagesPage> {
  const res = await pool.query(
    `SELECT id, role, content, created_at
     FROM chat_message
     WHERE user_id = $1 AND session_id = $2
       AND ($4::bigint IS NULL OR id < $4)
     ORDER BY id DESC
     LIMIT $3`,
    [String(userId), sessionId, limit + 1, beforeId ?? null],
  );

  const rows = res.rows as Array<{
    id: string | number;
    role: 'user' | 'assistant';
    content: string;
    created_at: string | number;
  }>;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const messages = pageRows
    .map((row) => ({
      id: Number(row.id),
      role: row.role,
      content: row.content,
      createdAt: Number(row.created_at),
    }))
    .reverse();

  return {
    messages,
    hasMore,
    nextBeforeId: hasMore && messages.length > 0 ? messages[0].id : null,
  };
}

export async function deleteSession(
  userId: string | number,
  sessionId: string,
): Promise<boolean> {
  const uid = String(userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionRes = await client.query(
      'DELETE FROM chat_session WHERE user_id = $1 AND session_id = $2',
      [uid, sessionId],
    );
    const messageRes = await client.query(
      'DELETE FROM chat_message WHERE user_id = $1 AND session_id = $2',
      [uid, sessionId],
    );
    await client.query('COMMIT');
    return (sessionRes.rowCount ?? 0) > 0 || (messageRes.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function renameSession(
  userId: string | number,
  sessionId: string,
  title: string,
): Promise<SessionSummary | null> {
  const res = await pool.query(
    `UPDATE chat_session
     SET title = $3
     WHERE user_id = $1 AND session_id = $2
     RETURNING session_id, title, last_message, message_count, created_at, updated_at`,
    [String(userId), sessionId, title],
  );
  const row = res.rows[0] as SessionRow | undefined;
  return row ? mapSessionRow(row) : null;
}


export async function createUser(username: string, passwordHash: string) {
  const res = await pool.query(
    'INSERT INTO users (username, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id, username',
    [username, passwordHash, Date.now()]
  );
  return res.rows[0];
}

export async function findUserByUsername(username: string) {
  const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return res.rows[0];
}

export async function findUserById(id: number) {
  const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0];
}