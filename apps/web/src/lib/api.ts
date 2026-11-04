import type { Role } from '../types';

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 读取后端统一错误体 { error: string }，读不出来时退化成状态码提示 */
export async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // 非 JSON 响应，忽略
  }
  return `请求失败（${response.status}）`;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, signal } = options;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }

  return (await response.json()) as T;
}

export type LoginResult = { token: string; username: string };
export type RegisterResult = { id: number; username: string };

export function login(username: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
}

export function register(username: string, password: string): Promise<RegisterResult> {
  return request<RegisterResult>('/api/auth/register', {
    method: 'POST',
    body: { username, password },
  });
}

export type ServerSession = {
  sessionId: string;
  title: string;
  lastMessage: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type ServerSessionMessage = {
  id: number;
  role: Role;
  content: string;
  createdAt: number;
};

export type ServerSessionDetail = {
  session: ServerSession;
  messages: ServerSessionMessage[];
  hasMore: boolean;
  nextBeforeId: number | null;
};

type ServerSessionList = {
  data: ServerSession[];
  limit: number;
  offset: number;
};

const SESSION_PAGE_SIZE = 20;

export function fetchServerSessions(
  token: string,
  limit = SESSION_PAGE_SIZE,
  offset = 0,
): Promise<ServerSessionList> {
  return request<ServerSessionList>(
    `/api/sessions?limit=${limit}&offset=${offset}`,
    { token },
  );
}

/** 拉取当前用户的全部历史会话（分页拉完，最多 10 页） */
export async function fetchAllServerSessions(token: string): Promise<ServerSession[]> {
  const all: ServerSession[] = [];
  for (let page = 0; page < 10; page++) {
    const result = await fetchServerSessions(token, SESSION_PAGE_SIZE, page * SESSION_PAGE_SIZE);
    all.push(...result.data);
    if (result.data.length < SESSION_PAGE_SIZE) break;
  }
  return all;
}

export function fetchServerSessionMessages(
  token: string,
  sessionId: string,
  limit = 50,
  beforeId?: number,
): Promise<ServerSessionDetail> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (beforeId !== undefined) params.set('beforeId', String(beforeId));
  return request<ServerSessionDetail>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`,
    { token },
  );
}

export function renameServerSession(
  token: string,
  sessionId: string,
  title: string,
): Promise<{ data: ServerSession }> {
  return request<{ data: ServerSession }>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'PATCH', body: { title }, token },
  );
}

export function deleteServerSession(
  token: string,
  sessionId: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', token },
  );
}
