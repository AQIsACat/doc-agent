import OpenAI from 'openai';
import { config } from '../config.js';

// 只创建一次客户端，内部复用 HTTP 连接（keep-alive），避免每次请求都握手
const client = new OpenAI({
  apiKey: config.DEEPSEEK_API_KEY,
  // baseURL 指向兼容 OpenAI 协议的第三方服务（这里是 DeepSeek）
  baseURL: config.BASE_URL,
});

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

/**
 * 自定义超时错误。
 *
 * 为什么要单独定义：AbortController 被 abort 时，SDK 抛出的都是 AbortError，
 * 无法区分"用户主动点了停止"和"服务端 30s 超时"。
 * 分开之后，日志能正确归因，前端也能收到不同的提示。
 */
export class LlmTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`模型响应超时（${timeoutMs}ms）`);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * 以异步生成器的方式流式产出模型输出。
 * 调用方用 for await...of 逐段消费，天然支持"边收边推给前端"。
 *
 * @param messages 已拼装好的对话上下文（含 system）
 * @param signal   外部中断信号（客户端断开时触发）
 * @param timeoutMs 整体超时时间
 */
export async function* streamChat(
  messages: LlmMessage[],
  signal: AbortSignal,
  timeoutMs = 30_000,
): AsyncGenerator<string> {
  // 单独的超时控制器：到点自动 abort
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  // AbortSignal.any 把"用户取消"和"超时"两个信号合并，
  // 任意一个触发都会让底层的 fetch 中断。
  const mergedSignal = AbortSignal.any([signal, timeoutController.signal]);

  try {
    const stream = await client.chat.completions.create(
      {
        model: config.OPENAI_MODEL,
        messages,
        // 开启流式，否则会等全部生成完才返回
        stream: true,
      },
      // 第二个参数是请求选项，中断信号必须放这里
      { signal: mergedSignal },
    );

    for await (const chunk of stream) {
      // chunk 是一段增量，delta.content 可能为空（比如只有 role 或结束标记）
      const delta = chunk.choices?.[0]?.delta?.content;
      // 只有拿到实际文本才 yield，避免调用方收到空字符串
      if (delta) yield delta;
    }
  } catch (err) {
    // 判断归属：超时控制器触发了，且不是用户主动取消 -> 归类为超时
    if (timeoutController.signal.aborted && !signal.aborted) {
      throw new LlmTimeoutError(timeoutMs);
    }
    // 用户取消 / 其他网络错误：原样抛出，由上层区分处理
    throw err;
  } finally {
    // 无论成功失败都要清定时器，否则进程会因为悬挂的 timer 无法及时退出
    clearTimeout(timeoutId);
  }
}