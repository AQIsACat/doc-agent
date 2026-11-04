import type { Session } from '../types';
import type { ServerSession } from './api';

export const DEFAULT_SESSION_TITLE = '新会话';

const STORAGE_PREFIX = 'doc-agent:sessions';

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSession(title = DEFAULT_SESSION_TITLE): Session {
  const now = Date.now();
  return { id: createId(), title, messages: [], createdAt: now, updatedAt: now };
}

/** 保证列表里至少有一个会话 */
export function ensureSessions(sessions: Session[]): Session[] {
  return sessions.length ? sessions : [createSession()];
}

export function deriveTitle(text: string, max = 24): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return DEFAULT_SESSION_TITLE;
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<Session>;
  return (
    typeof session.id === 'string' &&
    typeof session.title === 'string' &&
    Array.isArray(session.messages)
  );
}

/** 会话按账号隔离存储在本地，避免不同用户看到彼此的记录 */
function storageKey(owner: string): string {
  return `${STORAGE_PREFIX}:${owner.trim() || 'anonymous'}`;
}

export function fromServerSession(server: ServerSession): Session {
  return {
    id: server.sessionId,
    title: server.title,
    messages: [],
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    remote: true,
    preview: server.lastMessage,
    messageCount: server.messageCount,
  };
}

/**
 * 把服务端会话合并进本地列表：
 * - 两边都有：以服务端元数据为准，保留本地已加载的消息（随后会用详情接口刷新）
 * - 只有服务端：创建一个待加载消息的会话
 * - 只有本地：保留（可能是刚新建、还没发消息的会话，或尚未同步的本地数据）
 */
export function mergeServerSessions(local: Session[], remote: ServerSession[]): Session[] {
  const remoteIds = new Set(remote.map((session) => session.sessionId));
  const localById = new Map(
    local
      // 已标记为服务端会话、但服务端已不存在的记录直接丢弃；带本地消息的保留，避免丢数据
      .filter((session) => !session.remote || remoteIds.has(session.id) || session.messages.length > 0)
      .map((session) => [session.id, session]),
  );

  const merged: Session[] = [];

  for (const server of remote) {
    const existing = localById.get(server.sessionId);
    if (existing) {
      merged.push({
        ...existing,
        title: server.title,
        createdAt: server.createdAt,
        updatedAt: server.updatedAt,
        remote: true,
        preview: server.lastMessage,
        messageCount: server.messageCount,
      });
      localById.delete(server.sessionId);
    } else {
      merged.push(fromServerSession(server));
    }
  }

  merged.push(...localById.values());
  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSessions(owner: string): Session[] {
  try {
    const raw = localStorage.getItem(storageKey(owner));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSession) : [];
  } catch {
    return [];
  }
}

export function saveSessions(owner: string, sessions: Session[]): void {
  try {
    localStorage.setItem(storageKey(owner), JSON.stringify(sessions));
  } catch {
    // 本地存储不可用时忽略，不影响对话
  }
}

const pad = (value: number) => String(value).padStart(2, '0');

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}