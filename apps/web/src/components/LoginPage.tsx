import { useState } from 'react';
import { App as AntdApp, Button, Form, Input, Segmented } from 'antd';
import {
  CheckCircleOutlined,
  LockOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { API_BASE, ApiError, login, register } from '../lib/api';
import type { AuthSession } from '../lib/auth';

type Mode = 'login' | 'register';

type FormValues = {
  username: string;
  password: string;
  confirm?: string;
};

type LoginPageProps = {
  onAuthenticated: (auth: AuthSession) => void;
};

const FEATURES = [
  { icon: <ThunderboltOutlined />, text: '流式输出，回答实时可见' },
  { icon: <CheckCircleOutlined />, text: '历史会话云端保存，随时接着聊' },
  { icon: <SafetyCertificateOutlined />, text: '账号登录鉴权，数据仅自己可见' },
];

export default function LoginPage({ onAuthenticated }: LoginPageProps) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [mode, setMode] = useState<Mode>('login');
  const [loading, setLoading] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    form.resetFields();
  };

  const handleSubmit = async (values: FormValues) => {
    const username = values.username.trim();
    setLoading(true);
    try {
      if (mode === 'register') {
        await register(username, values.password);
      }
      const result = await login(username, values.password);
      message.success(mode === 'register' ? '注册成功，已自动登录' : '登录成功');
      onAuthenticated({ token: result.token, username: result.username });
    } catch (error) {
      const text =
        error instanceof ApiError
          ? error.message
          : '网络异常，请确认后端服务已启动';
      message.error(text);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-dvh w-full bg-[#f6f7fb]">
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-gradient-to-br from-violet-600 via-violet-500 to-indigo-600 p-12 text-white lg:flex">
        <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-80 w-80 rounded-full bg-indigo-900/20 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 text-lg backdrop-blur">
            <RobotOutlined />
          </div>
          <span className="text-lg font-semibold tracking-tight">Doc-Agent</span>
        </div>

        <div className="relative">
          <h1 className="text-3xl font-semibold leading-snug">
            你的 AI 文档助手
            <br />
            从提问到答案，只差一句话
          </h1>
          <ul className="mt-8 space-y-3.5 text-sm text-white/80">
            {FEATURES.map((item) => (
              <li key={item.text} className="flex items-center gap-2.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/15 text-xs">
                  {item.icon}
                </span>
                {item.text}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/50">Doc-Agent · AI 助手工作台</p>
      </div>

      <div className="flex w-full items-center justify-center p-6 lg:w-1/2">
        <div className="w-full max-w-[380px] rounded-2xl border border-slate-200/80 bg-white p-8 shadow-xl shadow-slate-900/5">
          <h2 className="text-xl font-semibold text-slate-900">
            {mode === 'login' ? '欢迎回来' : '创建账号'}
          </h2>
          <p className="mt-1.5 text-sm text-slate-400">
            {mode === 'login' ? '登录后即可继续之前的对话' : '注册后会自动为你登录'}
          </p>

          <Segmented
            block
            className="mt-6"
            value={mode}
            onChange={(value) => switchMode(value as Mode)}
            options={[
              { label: '登录', value: 'login' },
              { label: '注册', value: 'register' },
            ]}
          />

          <Form
            form={form}
            layout="vertical"
            size="large"
            requiredMark={false}
            className="mt-6"
            onFinish={handleSubmit}
          >
            <Form.Item
              name="username"
              label="用户名"
              rules={[
                { required: true, message: '请输入用户名' },
                { min: 3, message: '用户名至少 3 个字符' },
              ]}
            >
              <Input
                prefix={<UserOutlined className="text-slate-300" />}
                placeholder="请输入用户名"
                autoComplete="username"
                allowClear
              />
            </Form.Item>

            <Form.Item
              name="password"
              label="密码"
              rules={[
                { required: true, message: '请输入密码' },
                // 注册时要求至少 8 位（和后端 registerSchema 保持一致）；
                // 登录时不做长度下限校验，否则历史短密码用户会登不进来
                // （后端 loginSchema 同样只校验非空）。
                ...(mode === 'register'
                  ? [{ min: 8, message: '密码至少 8 位' }]
                  : []),
              ]}
            >
              <Input.Password
                prefix={<LockOutlined className="text-slate-300" />}
                placeholder="请输入密码"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </Form.Item>

            {mode === 'register' && (
              <Form.Item
                name="confirm"
                label="确认密码"
                dependencies={['password']}
                rules={[
                  { required: true, message: '请再次输入密码' },
                  ({ getFieldValue }) => ({
                    validator(_rule, value: string) {
                      if (!value || getFieldValue('password') === value) {
                        return Promise.resolve();
                      }
                      return Promise.reject(new Error('两次输入的密码不一致'));
                    },
                  }),
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined className="text-slate-300" />}
                  placeholder="请再次输入密码"
                  autoComplete="new-password"
                />
              </Form.Item>
            )}

            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={loading}
              style={{ height: 44, marginTop: 4 }}
            >
              {mode === 'login' ? '登录' : '注册并登录'}
            </Button>
          </Form>

          <p className="mt-6 text-center text-[11px] text-slate-400">
            接口地址 {API_BASE}
          </p>
        </div>
      </div>
    </div>
  );
}
