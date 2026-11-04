import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, Input } from 'antd';
import { SendOutlined, StopOutlined } from '@ant-design/icons';

type ComposerProps = {
  value: string;
  isGenerating: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
};

export default function Composer({ value, isGenerating, onChange, onSend, onStop }: ComposerProps) {
  const [focused, setFocused] = useState(false);
  const canSend = value.trim().length > 0 && !isGenerating;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // 中文输入法组合期间的 Enter 不触发发送
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  return (
    <div className="shrink-0 bg-gradient-to-t from-[#f6f7fb] via-[#f6f7fb] to-transparent px-6 pb-4 pt-2">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={`rounded-2xl border bg-white px-3 pb-2 pt-2 transition-all ${
            focused
              ? 'border-violet-300 shadow-lg shadow-violet-500/10 ring-4 ring-violet-500/5'
              : 'border-slate-200 shadow-sm'
          }`}
        >
          <Input.TextArea
            value={value}
            variant="borderless"
            autoSize={{ minRows: 1, maxRows: 6 }}
            placeholder="输入你想问的问题，Enter 发送，Shift + Enter 换行…"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={{ fontSize: 14.5, lineHeight: 1.7, padding: '4px 4px 0' }}
          />

          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="hidden pl-1 text-[11px] text-slate-400 sm:block">
              Enter 发送 · Shift + Enter 换行
            </span>

            {isGenerating ? (
              <Button type="primary" danger icon={<StopOutlined />} onClick={onStop}>
                停止生成
              </Button>
            ) : (
              <Button type="primary" icon={<SendOutlined />} disabled={!canSend} onClick={onSend}>
                发送
              </Button>
            )}
          </div>
        </div>

        <p className="mt-2.5 text-center text-[11px] text-slate-400">
          内容由 AI 生成，请注意甄别
        </p>
      </div>
    </div>
  );
}
