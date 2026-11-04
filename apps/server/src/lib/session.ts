import { redis } from './redis.js';
import {
  insertMessages,
  getRecentMessages,
  getUserSessions,
  getSession,
  getSessionMessages,
  deleteSession as deleteSessionRecord,
  renameSession as renameSessionRecord,
  type SessionSummary,
  type SessionMessage,
} from './db.js';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
};

// 落库/入模型对话只包含 user 和 assistant
export type DialogMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
};

const SESSION_TTL_SECONDS = 60 * 30;
const SESSION_LIST_TTL_SECONDS = 60;
const SESSION_DETAIL_TTL_SECONDS = 5 * 60;
const MAX_ROUNDS = 6;
// 缓存结构变更时改版本号，隔离旧缓存
const CACHE_VERSION = 'v1';

export const DEFAULT_SESSION_LIST_LIMIT = 20;
export const DEFAULT_DETAIL_LIMIT = 50;

export type SessionDetail = {
  session: SessionSummary;
  messages: SessionMessage[];
  hasMore: boolean;
  nextBeforeId: number | null;
};

function sessionKey(userId: string | number, sessionId: string): string {
  return `user:${userId}:${CACHE_VERSION}:session:${sessionId}:messages`; // 👈 加上 user
}

function sessionsKey(userId: string | number): string {
  return `user:${userId}:${CACHE_VERSION}:sessions:default`;
}

function detailKey(userId: string | number, sessionId: string): string {
  return `user:${userId}:${CACHE_VERSION}:session:${sessionId}:detail:default`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseCachedSessions(raw: string | null): SessionSummary[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.every(
      (s) =>
        isRecord(s) &&
        typeof s.sessionId === 'string' &&
        typeof s.title === 'string' &&
        typeof s.lastMessage === 'string' &&
        typeof s.messageCount === 'number' &&
        typeof s.createdAt === 'number' &&
        typeof s.updatedAt === 'number',
    );
    return valid ? (parsed as SessionSummary[]) : null;
  } catch {
    return null;
  }
}

function parseCachedDetail(raw: string | null): SessionDetail | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.session) || !Array.isArray(parsed.messages)) {
      return null;
    }
    if (
      typeof parsed.session.sessionId !== 'string' ||
      typeof parsed.session.title !== 'string' ||
      typeof parsed.hasMore !== 'boolean'
    ) {
      return null;
    }
    return parsed as unknown as SessionDetail;
  } catch {
    return null;
  }
}

async function invalidateSessionCaches(
  userId: string | number,
  sessionId: string,
): Promise<void> {
  await Promise.all([
    redis.del(sessionKey(userId, sessionId)).catch(() => {}),
    redis.del(detailKey(userId, sessionId)).catch(() => {}),
    redis.del(sessionsKey(userId)).catch(() => {}),
  ]);
}


function parseCachedHistory(raw: string): ChatMessage[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.every(
      (m): m is ChatMessage =>
        typeof m === 'object' &&
        m !== null &&
        (m.role === 'system' || m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        typeof m.timestamp === 'number',
    );
    return valid ? parsed : null;
  } catch {
    return null;
  }
}

export async function getHistory(
  userId: string | number,
  sessionId: string,
): Promise<ChatMessage[]> {
  const key = sessionKey(userId, sessionId);

  // 1. 查 Redis
  const cached = await redis.get(key).catch(() => null);

  if (cached !== null) {
    const cachedHistory = parseCachedHistory(cached);
    if (cachedHistory !== null) {
      console.log(`[Redis] 命中缓存: ${key}`); // 👈 新增
      return cachedHistory;
    }
    await redis.del(key).catch(() => {});
  }

  // 2. 查 PG
  console.log(`[PostgreSQL] 缓存未命中，回源查库: ${key}`); // 👈 新增
  const dbMessages = await getRecentMessages(userId, sessionId, MAX_ROUNDS * 2);
  const history: ChatMessage[] = dbMessages.map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: m.created_at,
  }));

  // 3. 回填 Redis
  if (history.length > 0) {
    await redis.set(key, JSON.stringify(history), 'EX', SESSION_TTL_SECONDS).catch(() => {});
    console.log(`[Redis] 回填缓存成功: ${key}`); // 👈 新增
  }

  return history;
}

export async function saveHistory(
  userId: string | number,
  sessionId: string,
  newMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<void> {
  // 1. 写库前先失效，避免并发读把旧值回填
  await invalidateSessionCaches(userId, sessionId);

  // 2. 写 PG（事务，同时维护 chat_session）
  await insertMessages(userId, sessionId, newMessages);

  // 3. 写库后再失效，吃掉写库期间被回填的旧缓存
  await invalidateSessionCaches(userId, sessionId);
}

/**
 * 历史记录列表：默认第一页走 Redis，其余分页直接查 PG。
 */
export async function listUserSessions(
  userId: string | number,
  limit: number = DEFAULT_SESSION_LIST_LIMIT,
  offset = 0,
): Promise<SessionSummary[]> {
  const cacheable = limit === DEFAULT_SESSION_LIST_LIMIT && offset === 0;
  const key = sessionsKey(userId);

  if (cacheable) {
    const cached = await redis.get(key).catch(() => null);
    const parsed = parseCachedSessions(cached);
    if (parsed !== null) {
      console.log(`[Redis] 命中会话列表缓存: ${key}`);
      return parsed;
    }
    if (cached !== null) {
      await redis.del(key).catch(() => {});
    }
  }

  const sessions = await getUserSessions(userId, limit, offset);

  if (cacheable) {
    await redis
      .set(key, JSON.stringify(sessions), 'EX', SESSION_LIST_TTL_SECONDS)
      .catch(() => {});
  }

  return sessions;
}

/**
 * 会话上下文详情：默认第一页走 Redis，带 beforeId 的分页直接查 PG。
 */
export async function getSessionDetail(
  userId: string | number,
  sessionId: string,
  limit: number = DEFAULT_DETAIL_LIMIT,
  beforeId?: number,
): Promise<SessionDetail | null> {
  const cacheable = limit === DEFAULT_DETAIL_LIMIT && beforeId === undefined;
  const key = detailKey(userId, sessionId);

  if (cacheable) {
    const cached = await redis.get(key).catch(() => null);
    const parsed = parseCachedDetail(cached);
    if (parsed !== null) {
      console.log(`[Redis] 命中会话详情缓存: ${key}`);
      return parsed;
    }
    if (cached !== null) {
      await redis.del(key).catch(() => {});
    }
  }

  const session = await getSession(userId, sessionId);
  if (!session) return null;

  const page = await getSessionMessages(userId, sessionId, limit, beforeId);
  const detail: SessionDetail = {
    session,
    messages: page.messages,
    hasMore: page.hasMore,
    nextBeforeId: page.nextBeforeId,
  };

  if (cacheable) {
    await redis
      .set(key, JSON.stringify(detail), 'EX', SESSION_DETAIL_TTL_SECONDS)
      .catch(() => {});
  }

  return detail;
}

export async function removeSession(
  userId: string | number,
  sessionId: string,
): Promise<boolean> {
  const deleted = await deleteSessionRecord(userId, sessionId);
  if (deleted) {
    await invalidateSessionCaches(userId, sessionId);
  }
  return deleted;
}

export async function updateSessionTitle(
  userId: string | number,
  sessionId: string,
  title: string,
): Promise<SessionSummary | null> {
  const session = await renameSessionRecord(userId, sessionId, title);
  if (session) {
    await invalidateSessionCaches(userId, sessionId);
  }
  return session;
}

export function truncateHistory(
  history: ChatMessage[],
  maxRounds: number = MAX_ROUNDS,
): DialogMessage[] {
  const rounds = Number.isFinite(maxRounds)
    ? Math.max(0, Math.floor(maxRounds))
    : MAX_ROUNDS;
  const dialogMessages = history.filter(
    (m): m is DialogMessage => m.role !== 'system',
  );
  const maxDialogMessages = rounds * 2;
  return dialogMessages.length > maxDialogMessages
    ? dialogMessages.slice(dialogMessages.length - maxDialogMessages)
    : dialogMessages;
}