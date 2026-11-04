import { API_BASE, ApiError, readErrorMessage } from './api';

type StreamChatOptions = {
  sessionId: string;
  message: string;
  token: string;
  systemMessage?: string;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
};

type ChatEvent = {
  event: string;
  data: string;
};

function parseEventFrame(frame: string): ChatEvent | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * 读取后端 SSE 流，逐段回调增量内容。
 * 用缓冲区拼接，避免一个事件被拆到两次 read 中导致 JSON 解析失败。
 */
export async function streamChat({
  sessionId,
  message,
  token,
  systemMessage,
  signal,
  onDelta,
}: StreamChatOptions): Promise<void> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ sessionId, message, systemMessage }),
    signal,
  });

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }
  if (!response.body) {
    throw new Error('没有返回流');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finished = false;

  const handleFrame = (frame: string) => {
    const payload = parseEventFrame(frame);
    if (!payload) return;

    const data = payload.data.trim();
    if (!data) return;
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    if (payload.event === 'error') {
      // 后端 SSE 的错误帧是 event: error + data: {"code":"...","message":"..."}。
      // 这里把 JSON 解析出来取 message，前端就能直接展示人类可读的提示，
      // 而不是把原始 JSON 字符串糊到用户脸上。
      let message = '模型服务异常，请稍后重试';
      try {
        const parsed = JSON.parse(data) as { code?: string; message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // 非 JSON 错误帧（例如网关返回的纯文本），退回默认文案
      }
      throw new Error(message);
    }

    try {
      const parsed = JSON.parse(data) as { delta?: string };
      if (typeof parsed.delta === 'string' && parsed.delta) {
        onDelta(parsed.delta);
      }
    } catch (error) {
      // 不完整的 JSON 直接跳过，等待后续数据补齐
      if (!(error instanceof SyntaxError)) throw error;
    }
  };

  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      if (!frame.trim()) continue;
      handleFrame(frame);
      if (finished) break;
    }
  }

  if (!finished && buffer.trim()) {
    handleFrame(buffer);
  }
}
