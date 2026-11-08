import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage, streamTask } from '../lib/api.ts';
import type { DashboardStats } from '../lib/types.ts';
import { Button, Icon, IconButton, MarkdownView } from '../lib/ui.tsx';

interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface AgentPreset { text: string; nonce: number }

const SUGGESTIONS = ['帮我写本周周报', '分析上半年经营数据', '整理 LLM 文献综述', '设计 A/B 实验', '回复最新的邮件'];

export function AgentDrawer({ open, onClose, preset, stats }: {
  open: boolean; onClose: () => void; preset: AgentPreset | null; stats: DashboardStats | null;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: '你好，我是 Mirelth 办公智能体。告诉我你想完成什么工作，我会判断应该落到哪个模块，并直接给出可用的初稿或执行建议。' },
  ]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [modelLabel, setModelLabel] = useState('');
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const sentPreset = useRef(0);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    setError('');
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: '' }]);
    setRunning(true);
    let reply = '';
    const update = (value: string) => {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: value };
        return next;
      });
    };
    try {
      await streamTask('agent.chat', {
        message: trimmed,
        workspace: {
          documents: stats?.documents ?? 0, datasets: stats?.datasets ?? 0, papers: stats?.papers ?? 0,
          experiments: stats?.experiments ?? 0, tasks: stats?.tasks ?? 0, unreadMail: stats?.unreadMail ?? 0,
        },
      }, {
        onMeta: (meta) => setModelLabel(meta.label),
        onDelta: (chunk) => { reply += chunk; update(reply); },
        onError: (message) => setError(message),
      });
      if (!reply) update('暂时没有生成内容，请换一种说法重试。');
    } catch (err) {
      setError(getErrorMessage(err));
      update('生成失败，请检查服务状态后重试。');
    } finally {
      setRunning(false);
    }
  }, [running, stats]);

  useEffect(() => {
    if (!open || !preset || sentPreset.current === preset.nonce) return;
    sentPreset.current = preset.nonce;
    void send(preset.text);
  }, [open, preset, send]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  if (!open) return null;
  return (
    <>
      <div className="agent-backdrop" onClick={onClose} />
      <aside className="agent-drawer">
        <header className="agent-head">
          <div className="brand-mark"><Icon name="sparkles" size={19} /></div>
          <div className="grow"><h3>Mirelth 智能体</h3><p>{modelLabel ? `${modelLabel} · 流式输出` : '文档 · 数据 · 论文 · 研究 · 邮件'}</p></div>
          <IconButton icon="close" title="关闭助手" onClick={onClose} />
        </header>
        <div className="agent-messages">
          {messages.map((message, index) => (
            <div key={index} className={`agent-message ${message.role}`}>
              <div className="who">{message.role === 'user' ? '我' : '智能体'}</div>
              <div className="agent-bubble">
                {message.role === 'assistant'
                  ? message.content
                    ? <MarkdownView source={message.content} />
                    : <span className="muted text-sm"><span className="spinner" /> 正在思考…</span>
                  : message.content}
              </div>
            </div>
          ))}
          {error && <div className="inline-error">{error}</div>}
          <div ref={endRef} />
        </div>
        <div className="agent-input">
          <div className="agent-chips">
            {SUGGESTIONS.slice(0, 3).map((item) => (
              <button type="button" key={item} className="chip" disabled={running} onClick={() => void send(item)}>{item}</button>
            ))}
          </div>
          <div className="agent-input-row">
            <textarea className="textarea grow" value={input} placeholder="描述你要完成的工作…" rows={2}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(input); } }} />
            <Button icon="send" loading={running} onClick={() => void send(input)}>发送</Button>
          </div>
        </div>
      </aside>
    </>
  );
}
