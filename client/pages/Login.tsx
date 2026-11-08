import { useState } from 'react';
import { apiClient, getErrorMessage } from '../lib/api.ts';
import { Button, Field, Icon } from '../lib/ui.tsx';
import type { AiMode, User } from '../lib/types.ts';

export function Login({ onSuccess }: { onSuccess: (user: User, mode: AiMode) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await apiClient.post<{ user: User; aiMode: AiMode }>('/api/auth/login', { username, password });
      onSuccess(result.user, result.aiMode);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark"><Icon name="sparkles" size={22} /></div>
          <div><h1>Mirelth Desk</h1><p className="text-sm muted">办公智能体工作台</p></div>
        </div>
        <p>一个工作台，完成文档写作、数据分析、论文整理、科学研究与邮件沟通。所有数据保存在本机。</p>
        <div className="login-form">
          <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <Field label="账号"><input className="input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></Field>
            <Field label="密码"><input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></Field>
            {error && <div className="inline-error">{error}</div>}
            <Button type="submit" loading={loading} icon="arrow">进入工作台</Button>
          </form>
        </div>
        <div className="login-hint">
          使用项目根目录 <code>.env</code> 中配置的 <code>ADMIN_USERNAME</code> / <code>ADMIN_PASSWORD</code> 登录。
        </div>
      </div>
    </div>
  );
}
