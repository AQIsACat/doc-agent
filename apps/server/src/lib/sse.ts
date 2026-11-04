// 只用于类型标注，运行时不需要 import 具体值（避免打包进产物）
import type { FastifyReply } from 'fastify';

/**
 * 对 SSE 连接的一层薄封装。
 * 路由里只需要 send / sendEvent / end，不用关心心跳、关闭判断这些细节。
 */
export type SseStream = {
  /** 发送普通 data 帧（前端用 onmessage / 默认事件接收） */
  send: (payload: unknown) => void;
  /** 发送带事件名的帧（前端用 addEventListener('error') 接收） */
  sendEvent: (event: string, payload: unknown) => void;
  /** 结束流：清心跳 + 写 [DONE] + 关闭连接 */
  end: () => void;
  /** 连接是否已经关闭，业务侧可用它避免做无用功 */
  isClosed: () => boolean;
};

// 心跳间隔。Nginx / 云负载均衡默认 60s 空闲就断开长连接，
// 15s 发一次注释帧可以稳稳续命。
const HEARTBEAT_MS = 15_000;

export function openSseStream(reply: FastifyReply): SseStream {
  // 【关键】@fastify/cors、@fastify/rate-limit 等插件是通过 reply.header() 挂响应头的，
  // Fastify 要走到"发送响应"那一步才会把这些头写到 socket 上。
  // 而下面一旦 hijack，这个流程就被跳过了，CORS 头会凭空消失，
  // 浏览器就会报 "No 'Access-Control-Allow-Origin' header"。所以这里先抓出来。
  const inherited: Record<string, string | number | string[]> = {};
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    // getHeaders() 的类型允许 undefined，writeHead 不接受，这里过滤掉
    if (value !== undefined) inherited[key] = value;
  }

  // 【关键】告诉 Fastify：这个响应由我（raw socket）接管，
  // 你既不要自己发送，也不要再尝试序列化返回值。
  reply.hijack();

  // 直接写原始 HTTP 响应头，进入 SSE 模式
  reply.raw.writeHead(200, {
    // 展开上面继承的头（CORS、限流信息等）
    ...inherited,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    // 保持长连接（HTTP/1.1 默认就是 keep-alive，写出来是为了明确意图）
    Connection: 'keep-alive',
    // 专治 Nginx：默认 proxy_buffering 会把流攒起来，导致前端看不到"逐字输出"
    'X-Accel-Buffering': 'no',
  });

  // 定时发送 SSE 注释帧（以冒号开头的行会被浏览器忽略），
  // 纯粹用来产生"有数据流动"的假象，防止代理层判定空闲而断开。
  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) {
      reply.raw.write(': ping\n\n');
    }
  }, HEARTBEAT_MS);

  // 两个判断都要有：
  // - writableEnded：我们主动 end() 过
  // - destroyed：客户端断开 / socket 出错被销毁
  const isClosed = () => reply.raw.writableEnded || reply.raw.destroyed;

  return {
    send(payload) {
      // 关闭后再 write 会抛 ERR_STREAM_WRITE_AFTER_END，所以每次写之前都判断
      if (!isClosed()) {
        // SSE 协议格式：必须以 "data: " 开头，以两个换行结束一个事件
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    },
    sendEvent(event, payload) {
      if (!isClosed()) {
        // 带 event 名的帧，前端要用 addEventListener(事件名) 才能收到
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    },
    end() {
      // 先停心跳，否则定时器会一直持有 reply 引用，造成内存/句柄泄漏
      clearInterval(heartbeat);
      if (!reply.raw.writableEnded) {
        // 前端用 "[DONE]" 作为"生成结束"的约定信号（和 OpenAI 的流式约定一致）
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      }
    },
    isClosed,
  };
}