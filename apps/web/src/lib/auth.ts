export type AuthSession = {
  token: string;
  username: string;
};

const AUTH_KEY = 'doc-agent:auth';

export function loadAuth(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (typeof parsed?.token === 'string' && parsed.token && typeof parsed.username === 'string') {
      return { token: parsed.token, username: parsed.username };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAuth(auth: AuthSession): void {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  } catch {
    // 本地存储不可用时忽略，仅当次会话有效
  }
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    // ignore
  }
}
