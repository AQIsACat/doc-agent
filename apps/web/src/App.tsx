import { useEffect, useRef, useState } from 'react';
import { App as AntdApp, Input, Modal } from 'antd';
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader';
import MessageList from './components/MessageList';
import Composer from './components/Composer';
import LoginPage from './components/LoginPage';
import type { Message, Session } from './types';
import {
  DEFAULT_SESSION_TITLE,
  createId,
  createSession,
  deriveTitle,
  ensureSessions,
  loadSessions,
  mergeServerSessions,
  saveSessions,
} from './lib/sessions';
import { clearAuth, loadAuth, saveAuth, type AuthSession } from './lib/auth';
import {
  ApiError,
  deleteServerSession,
  fetchAllServerSessions,
  fetchServerSessionMessages,
  renameServerSession,
} from './lib/api';
import { streamChat } from './lib/chat';

const SYSTEM_MESSAGE = '你是一个专业的前端和 AI 助手';

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'conversation';
}

function App() {
  const { message, modal } = AntdApp.useApp();

  const [auth, setAuth] = useState<AuthSession | null>(() => loadAuth());
  const [sessions, setSessions] = useState<Session[]>(() => {
    const current = loadAuth();
    return current ? ensureSessions(loadSessions(current.username)) : [];
  });
  const [activeSessionId, setActiveSessionId] = useState<string>(() => sessions[0]?.id ?? '');
  const [input, setInput] = useState('');
  const [generatingSessionId, setGeneratingSessionId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const sessionsRef = useRef<Session[]>(sessions);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // 登录后从服务端恢复历史会话（localStorage 被清空时尤其重要）
  useEffect(() => {
    if (!auth || !auth?.token) return;
    console.log(auth, '[App] sync server sessions');
    let cancelled = false;

    const syncServerSessions = async () => {
      try {
        const remote = await fetchAllServerSessions(auth.token);
        if (cancelled) return;

        let merged = mergeServerSessions(sessionsRef.current, remote);
        if (merged.some((session) => session.remote)) {
          // 服务端已有历史时，丢弃本地自动生成的空“新会话”，避免侧边栏多一个空项
          merged = merged.filter(
            (session) =>
              session.remote ||
              session.messages.length > 0 ||
              session.title !== DEFAULT_SESSION_TITLE,
          );
        }

        sessionsRef.current = merged;
        setSessions(merged);
        setActiveSessionId((current) => {
          const active = merged.find((session) => session.id === current);
          const activeIsEmptyLocal =
            !active || (!active.remote && active.messages.length === 0);
          if (activeIsEmptyLocal) {
            const latestRemote = merged.find((session) => session.remote);
            if (latestRemote) return latestRemote.id;
          }
          return active?.id ?? merged[0]?.id ?? '';
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          clearAuth();
          setAuth(null);
          setSessions([]);
          setActiveSessionId('');
          setInput('');
          setGeneratingSessionId(null);
          setRenameTarget(null);
          message.warning('登录已过期，请重新登录');
          return;
        }
        // 服务端历史同步失败时保留本地会话，不阻塞使用
        console.warn('同步服务端历史失败', error);
      }
    };

    void syncServerSessions();
    return () => {
      cancelled = true;
    };
  }, [auth?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // 选中服务端会话时加载完整上下文
  useEffect(() => {
    if (!auth || !auth?.token || !activeSessionId) return;

    const target = sessionsRef.current.find((session) => session.id === activeSessionId);
    if (!target) return;
    // 本地新建、还没保存到后端的空会话，不需要查历史
    if (!target.remote && target.messages.length === 0) return;

    let cancelled = false;

    const loadHistory = async () => {
      try {
        const detail = await fetchServerSessionMessages(auth.token, activeSessionId);
        if (cancelled) return;

        const formattedMessages: Message[] = detail.messages.map((item) => ({
          id: String(item.id),
          role: item.role,
          content: item.content,
          createdAt: item.createdAt,
        }));

        setSessions((prev) =>
          prev.map((session) => {
            if (session.id !== activeSessionId) return session;
            // 后端暂时没有消息时，不要覆盖本地已有内容
            if (formattedMessages.length === 0 && session.messages.length > 0) {
              return session;
            }
            return {
              ...session,
              title: detail.session.title,
              messages: formattedMessages,
              createdAt: detail.session.createdAt,
              updatedAt: detail.session.updatedAt,
              remote: true,
              preview: detail.session.lastMessage,
              messageCount: detail.session.messageCount,
            };
          }),
        );
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          message.warning('登录已过期，请重新登录');
          return;
        }
        // 本地会话还没落库时详情接口会返回 404，保留本地消息即可
        if (!(error instanceof ApiError && error.status === 404)) {
          message.error('获取历史记录失败');
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, auth?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!auth?.username) return;
    const timer = window.setTimeout(() => saveSessions(auth.username, sessions), 400);
    return () => window.clearTimeout(timer);
  }, [auth?.username, sessions]);

  const handleAuthenticated = (next: AuthSession) => {
    saveAuth(next);
    const nextSessions = ensureSessions(loadSessions(next.username));
    setAuth(next);
    setSessions(nextSessions);
    setActiveSessionId(nextSessions[0].id);
    setInput('');
    setGeneratingSessionId(null);
    setRenameTarget(null);
  };

  const clearAuthState = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearAuth();
    setAuth(null);
    setSessions([]);
    setActiveSessionId('');
    setInput('');
    setGeneratingSessionId(null);
    setRenameTarget(null);
  };

  const handleLogout = () => {
    clearAuthState();
    message.success('已退出登录');
  };

  if (!auth) {
    return <LoginPage onAuthenticated={handleAuthenticated} />;
  }

  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? sessions[0];

  if (!activeSession) return null;

  const isGenerating = generatingSessionId === activeSession.id;

  const stopGeneration = () => {
    abortRef.current?.abort();
  };

  const sendMessage = async (rawText?: string) => {
    const content = (rawText ?? input).trim();
    if (!content || abortRef.current) return;

    const sessionId = activeSession.id;
    const assistantId = createId();
    const userMessage: Message = {
      id: createId(),
      role: 'user',
      content,
      createdAt: Date.now(),
    };
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
    };

    setSessions((prev) =>
      prev.map((session) =>
        session.id !== sessionId
          ? session
          : {
              ...session,
              title:
                session.messages.length === 0 && session.title === DEFAULT_SESSION_TITLE
                  ? deriveTitle(content)
                  : session.title,
              messages: [...session.messages, userMessage, assistantMessage],
              updatedAt: Date.now(),
            },
      ),
    );
    if (rawText === undefined) setInput('');

    const controller = new AbortController();
    abortRef.current = controller;
    setGeneratingSessionId(sessionId);

    try {
      await streamChat({
        sessionId,
        message: content,
        token: auth.token,
        systemMessage: SYSTEM_MESSAGE,
        signal: controller.signal,
        onDelta: (delta) => {
          setSessions((prev) =>
            prev.map((session) =>
              session.id !== sessionId
                ? session
                : {
                    ...session,
                    messages: session.messages.map((item) =>
                      item.id === assistantId
                        ? { ...item, content: item.content + delta }
                        : item,
                    ),
                    updatedAt: Date.now(),
                  },
            ),
          );
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearAuthState();
        message.warning('登录已过期，请重新登录');
        return;
      }

      if (!isAbortError(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        message.error('对话请求失败，请检查后端服务是否已启动');
        setSessions((prev) =>
          prev.map((session) =>
            session.id !== sessionId
              ? session
              : {
                  ...session,
                  messages: session.messages.map((item) =>
                    item.id === assistantId && !item.content
                      ? {
                          ...item,
                          content: `**请求失败**：${detail}\n\n请确认后端服务已启动（\`http://localhost:3000\`）后重试。`,
                        }
                      : item,
                  ),
                },
          ),
        );
      }
    } finally {
      abortRef.current = null;
      setGeneratingSessionId(null);
      // 中断或失败后清掉没有任何内容的占位气泡
      setSessions((prev) =>
        prev.map((session) =>
          session.id !== sessionId
            ? session
            : {
                ...session,
                messages: session.messages.filter(
                  (item) => !(item.id === assistantId && !item.content.trim()),
                ),
              },
        ),
      );
    }
  };

  const handleNewSession = () => {
    stopGeneration();
    const emptySession = sessions.find((session) => session.messages.length === 0);
    if (emptySession) {
      setActiveSessionId(emptySession.id);
      return;
    }
    const session = createSession();
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
  };

  const handleSelectSession = (sessionId: string) => {
    if (sessionId === activeSessionId) return;
    stopGeneration();
    setActiveSessionId(sessionId);
  };

  const handleDeleteSession = (sessionId: string) => {
    const target = sessions.find((session) => session.id === sessionId);
    if (!target) return;

    const doDelete = async () => {
      if (generatingSessionId === sessionId) stopGeneration();

      if (target.remote) {
        try {
          await deleteServerSession(auth.token, sessionId);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) {
            message.error('删除会话失败');
            throw error;
          }
        }
      }

      const remaining = sessionsRef.current.filter((session) => session.id !== sessionId);
      const nextSessions = remaining.length ? remaining : [createSession()];
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      if (sessionId === activeSessionId) {
        const sorted = [...nextSessions].sort((a, b) => b.updatedAt - a.updatedAt);
        setActiveSessionId(sorted[0].id);
      }
    };

    if (!target.remote && target.messages.length === 0) {
      void doDelete();
      return;
    }

    modal.confirm({
      title: '删除会话',
      content: `确定要删除「${target.title}」吗？删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: doDelete,
    });
  };

  const handleClearSession = () => {
    if (activeSession.messages.length === 0) return;

    modal.confirm({
      title: '清空当前对话',
      content: '将删除当前会话的全部消息，是否继续？',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        stopGeneration();

        if (activeSession.remote) {
          try {
            await deleteServerSession(auth.token, activeSession.id);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) {
              message.error('清空会话失败');
              throw error;
            }
          }
        }

        setSessions((prev) =>
          prev.map((session) =>
            session.id !== activeSession.id
              ? session
              : {
                  ...session,
                  title: DEFAULT_SESSION_TITLE,
                  messages: [],
                  updatedAt: Date.now(),
                  remote: false,
                  preview: undefined,
                  messageCount: 0,
                },
          ),
        );
        message.success('已清空当前对话');
      },
    });
  };

  const handleRenameSession = (session: Session) => {
    setRenameTarget(session);
    setRenameValue(session.title);
  };

  const confirmRename = async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title) {
      message.warning('会话名称不能为空');
      return;
    }

    if (renameTarget.remote) {
      try {
        await renameServerSession(auth.token, renameTarget.id, title);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          message.warning('登录已过期，请重新登录');
          return;
        }
        message.error('重命名失败');
        return;
      }
    }

    setSessions((prev) =>
      prev.map((session) => (session.id === renameTarget.id ? { ...session, title } : session)),
    );
    setRenameTarget(null);
  };

  const handleShare = async () => {
    const url = `${window.location.origin}${window.location.pathname}?session=${encodeURIComponent(
      activeSession.id,
    )}`;
    try {
      await navigator.clipboard.writeText(url);
      message.success('会话链接已复制到剪贴板');
    } catch {
      message.warning('复制失败，请手动复制地址栏链接');
    }
  };

  const handleExport = () => {
    if (activeSession.messages.length === 0) {
      message.warning('当前会话还没有内容');
      return;
    }

    const markdown = [
      `# ${activeSession.title}`,
      '',
      ...activeSession.messages.map(
        (item) => `## ${item.role === 'user' ? '用户' : 'Doc-Agent'}\n\n${item.content}\n`,
      ),
    ].join('\n');

    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizeFileName(activeSession.title)}.md`;
    link.click();
    URL.revokeObjectURL(url);
    message.success('已导出 Markdown');
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-[#f6f7fb] text-slate-900">
      <Sidebar
        username={auth.username}
        sessions={sessions}
        activeSessionId={activeSession.id}
        generatingSessionId={generatingSessionId}
        onNewSession={handleNewSession}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onLogout={handleLogout}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          session={activeSession}
          isGenerating={isGenerating}
          onShare={handleShare}
          onRename={() => handleRenameSession(activeSession)}
          onClear={handleClearSession}
          onDelete={() => handleDeleteSession(activeSession.id)}
          onExport={handleExport}
        />
        <MessageList
          messages={activeSession.messages}
          isGenerating={isGenerating}
          onSuggestion={(prompt) => sendMessage(prompt)}
        />
        <Composer
          value={input}
          isGenerating={isGenerating}
          onChange={setInput}
          onSend={() => sendMessage()}
          onStop={stopGeneration}
        />
      </section>

      <Modal
        title="重命名会话"
        open={renameTarget !== null}
        okText="保存"
        cancelText="取消"
        onOk={confirmRename}
        onCancel={() => setRenameTarget(null)}
        destroyOnHidden
      >
        <Input
          value={renameValue}
          maxLength={40}
          showCount
          placeholder="输入会话名称"
          onChange={(event) => setRenameValue(event.target.value)}
          onPressEnter={confirmRename}
        />
      </Modal>
    </div>
  );
}

export default App;
