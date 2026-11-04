import { useMemo } from 'react';
import { App as AntdApp, Avatar, Button, Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  LogoutOutlined,
  MessageOutlined,
  MoreOutlined,
  PlusOutlined,
  RobotOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { Session } from '../types';
import { formatTime } from '../lib/sessions';

type SidebarProps = {
  username: string;
  sessions: Session[];
  activeSessionId: string;
  generatingSessionId: string | null;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (session: Session) => void;
  onDeleteSession: (sessionId: string) => void;
  onLogout: () => void;
};

function SessionItem({
  session,
  active,
  generating,
  onSelect,
  onRename,
  onDelete,
}: {
  session: Session;
  active: boolean;
  generating: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const preview = session.messages.at(-1)?.content ?? session.preview ?? '';

  return (
    <div
      className={`group relative mb-1 rounded-xl transition-colors ${
        active ? 'bg-violet-50' : 'hover:bg-slate-100/80'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 pr-9 text-left"
      >
        <MessageOutlined
          className={`mt-0.5 text-[15px] ${active ? 'text-violet-500' : 'text-slate-400'}`}
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm ${
              active ? 'font-medium text-violet-700' : 'text-slate-700'
            }`}
          >
            {session.title}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="shrink-0">{formatTime(session.updatedAt)}</span>
            {generating ? (
              <span className="truncate text-violet-500">生成中…</span>
            ) : (
              preview && <span className="truncate">{preview}</span>
            )}
          </span>
        </span>
      </button>

      <Dropdown
        trigger={['click']}
        placement="bottomRight"
        menu={{
          items: [
            { key: 'rename', icon: <EditOutlined />, label: '重命名' },
            { type: 'divider' },
            { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === 'rename') onRename();
            if (key === 'delete') onDelete();
          },
        }}
      >
        <Button
          type="text"
          size="small"
          aria-label="会话操作"
          icon={<MoreOutlined />}
          className="absolute right-1.5 top-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(event) => event.stopPropagation()}
        />
      </Dropdown>
    </div>
  );
}

export default function Sidebar({
  username,
  sessions,
  activeSessionId,
  generatingSessionId,
  onNewSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onLogout,
}: SidebarProps) {
  const { message } = AntdApp.useApp();

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  const userMenu: MenuProps = {
    items: [
      { key: 'profile', icon: <UserOutlined />, label: '个人资料' },
      { key: 'settings', icon: <SettingOutlined />, label: '偏好设置' },
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'logout') {
        onLogout();
        return;
      }
      message.info('功能开发中，敬请期待');
    },
  };

  return (
    <aside className="flex h-full w-[276px] shrink-0 flex-col border-r border-slate-200/80 bg-white">
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-500 text-lg text-white shadow-lg shadow-violet-500/25">
          <RobotOutlined />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-slate-900">Doc-Agent</div>
          <div className="truncate text-xs text-slate-400">AI 助手工作台</div>
        </div>
      </div>

      <div className="px-4">
        <Button
          type="primary"
          block
          icon={<PlusOutlined />}
          onClick={onNewSession}
          style={{ height: 40, fontWeight: 500 }}
        >
          新建会话
        </Button>
      </div>

      <div className="mt-6 flex items-center justify-between px-5 pb-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
          历史会话
        </span>
        <span className="rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-400">
          {sessions.length}
        </span>
      </div>

      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {sortedSessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            active={session.id === activeSessionId}
            generating={session.id === generatingSessionId}
            onSelect={() => onSelectSession(session.id)}
            onRename={() => onRenameSession(session)}
            onDelete={() => onDeleteSession(session.id)}
          />
        ))}
      </div>

      <div className="border-t border-slate-100 p-3">
        <Dropdown menu={userMenu} trigger={['click']} placement="topLeft">
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-slate-100/80"
          >
            <Avatar
              size={34}
              style={{ background: 'linear-gradient(135deg, #7c5cff, #4f7cff)', fontWeight: 600 }}
            >
              {username.trim().slice(0, 1).toUpperCase()}
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-800">{username}</span>
              <span className="block truncate text-xs text-slate-400">已登录</span>
            </span>
            <Tooltip title="账号设置">
              <MoreOutlined className="text-slate-400" />
            </Tooltip>
          </button>
        </Dropdown>
      </div>
    </aside>
  );
}
