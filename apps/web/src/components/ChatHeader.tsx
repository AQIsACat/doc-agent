import { Button, Dropdown, Tooltip } from 'antd';
import {
  ClearOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  MoreOutlined,
  ShareAltOutlined,
} from '@ant-design/icons';
import type { Session } from '../types';

type ChatHeaderProps = {
  session: Session;
  isGenerating: boolean;
  onShare: () => void;
  onRename: () => void;
  onClear: () => void;
  onDelete: () => void;
  onExport: () => void;
};

export default function ChatHeader({
  session,
  isGenerating,
  onShare,
  onRename,
  onClear,
  onDelete,
  onExport,
}: ChatHeaderProps) {
  const rounds = session.messages.filter((item) => item.role === 'user').length;
  const hasMessages = session.messages.length > 0;

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-slate-200/80 bg-white/85 px-6 backdrop-blur">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[15px] font-semibold text-slate-900">{session.title}</h1>
          {isGenerating && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
              生成中
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-slate-400">
          {hasMessages ? `最近一次对话 · 共 ${rounds} 轮` : '还没有开始对话'}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip title="复制会话分享链接">
          <Button icon={<ShareAltOutlined />} onClick={onShare}>
            分享
          </Button>
        </Tooltip>
        <Tooltip title="清空当前对话">
          <Button type="text" icon={<ClearOutlined />} onClick={onClear} disabled={!hasMessages} />
        </Tooltip>
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: [
              { key: 'rename', icon: <EditOutlined />, label: '重命名会话' },
              { key: 'export', icon: <DownloadOutlined />, label: '导出 Markdown' },
              { type: 'divider' },
              { key: 'delete', icon: <DeleteOutlined />, label: '删除会话', danger: true },
            ],
            onClick: ({ key }) => {
              if (key === 'rename') onRename();
              if (key === 'export') onExport();
              if (key === 'delete') onDelete();
            },
          }}
        >
          <Button type="text" icon={<MoreOutlined />} aria-label="更多操作" />
        </Dropdown>
      </div>
    </header>
  );
}
