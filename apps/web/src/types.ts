export type Role = 'user' | 'assistant';

export type Message = {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
};

export type Session = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** 是否已存在于服务端 */
  remote?: boolean;
  /** 服务端返回的最后一条消息摘要，用于未加载消息时的侧边栏预览 */
  preview?: string;
  /** 服务端返回的消息条数 */
  messageCount?: number;
};
