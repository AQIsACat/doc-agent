import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button, Tooltip } from 'antd';
import {
  CheckOutlined,
  CopyOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { Message } from '../types';

type MessageListProps = {
  messages: Message[];
  isGenerating: boolean;
  onSuggestion: (prompt: string) => void;
};

const SUGGESTIONS = [
  {
    title: '解释一个概念',
    prompt: '用通俗的例子解释一下什么是流式输出（SSE），以及它和 WebSocket 的区别。',
  },
  {
    title: '写一段代码',
    prompt: '用 React + TypeScript 写一个支持 Markdown 渲染的流式对话组件。',
  },
  {
    title: '帮我做方案',
    prompt: '我要做一个 AI 助手应用，请帮我设计一下历史会话的数据结构和存储方案。',
  },
];

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Tooltip title={copied ? '已复制' : '复制回答'}>
      <Button
        type="text"
        size="small"
        aria-label="复制回答"
        icon={copied ? <CheckOutlined className="text-emerald-500" /> : <CopyOutlined />}
        onClick={handleCopy}
        className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      />
    </Tooltip>
  );
}

function MessageBubble({ message, streaming }: { message: Message; streaming: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[76%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-br from-violet-500 to-indigo-500 px-4 py-2.5 text-[14.5px] leading-7 text-white shadow-sm shadow-violet-500/20">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 text-white shadow-sm shadow-violet-500/20">
        <RobotOutlined />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-500">Doc-Agent</span>
          {message.content && <CopyButton content={message.content} />}
        </div>

        <div className="rounded-2xl rounded-tl-md border border-slate-200/80 bg-white px-4 py-3 shadow-sm">
          {message.content ? (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          ) : streaming ? (
            <span className="typing-dots inline-flex items-center py-1">
              <span />
              <span />
              <span />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onSuggestion }: { onSuggestion: (prompt: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-500 text-2xl text-white shadow-xl shadow-violet-500/25">
        <RobotOutlined />
      </div>
      <h2 className="mt-5 text-[22px] font-semibold tracking-tight text-slate-900">
        你好，我是 Doc-Agent
      </h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
        我可以基于文档帮你分析、总结和写代码，支持流式输出与 Markdown 渲染。从这里开始吧。
      </p>

      <div className="mt-8 grid w-full max-w-2xl gap-3 sm:grid-cols-3">
        {SUGGESTIONS.map((item) => (
          <button
            key={item.title}
            type="button"
            onClick={() => onSuggestion(item.prompt)}
            className="group flex flex-col rounded-xl border border-slate-200 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md hover:shadow-violet-500/5"
          >
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-slate-800">
              <ThunderboltOutlined className="text-violet-500" />
              {item.title}
            </span>
            <span className="mt-1.5 line-clamp-2 text-xs leading-5 text-slate-400">
              {item.prompt}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function MessageList({ messages, isGenerating, onSuggestion }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastContent = messages.at(-1)?.content ?? '';

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages.length, lastContent, isGenerating]);

  return (
    <div ref={scrollRef} className="chat-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-6">
        {messages.length === 0 ? (
          <EmptyState onSuggestion={onSuggestion} />
        ) : (
          <div className="space-y-6">
            {messages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                streaming={
                  isGenerating && index === messages.length - 1 && message.role === 'assistant'
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
