import { useState } from 'react';
import { apiClient, getErrorMessage, streamPlatformChat } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { PlatformConversation, PlatformConversationDetail, PlatformRun, PlatformRunDetail } from '../../lib/types.ts';
import { Badge, Button, Icon, MarkdownView, Skeleton, formatDate, useToast } from '../../lib/ui.tsx';

/** 对话 tab：多轮会话（SSE 工具调用）与运行记录。 */
export function PlatformChat({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const conversations = useLoad<PlatformConversation[]>(() => apiClient.get<PlatformConversation[]>('/api/platform/conversations'));
  const runs = useLoad<PlatformRun[]>(() => apiClient.get<PlatformRun[]>('/api/platform/runs'));

  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const detail = useLoad<PlatformConversationDetail | null>(
    () => (selectedConversation
      ? apiClient.get<PlatformConversationDetail>(`/api/platform/conversations/${selectedConversation}`)
      : Promise.resolve(null)),
    [selectedConversation],
  );
  const [openRun, setOpenRun] = useState<string | null>(null);
  const runDetail = useLoad<PlatformRunDetail | null>(
    () => (openRun ? apiClient.get<PlatformRunDetail>(`/api/platform/runs/${openRun}`) : Promise.resolve(null)),
    [openRun],
  );

  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setReply('');
    setSteps([]);
    try {
      await streamPlatformChat(text, selectedConversation ?? undefined, (event) => {
        if (event.type === 'meta') {
          if (event.conversationId) setSelectedConversation(event.conversationId);
        } else if (event.type === 'step') {
          setSteps((previous) => (event.status === 'start'
            ? [...previous, `调用 ${event.tool ?? ''}…`]
            : [...previous.slice(0, -1), `${event.tool ?? ''} 完成`]));
        } else if (event.type === 'delta') {
          setReply((previous) => previous + (event.text ?? ''));
        } else if (event.type === 'error') {
          toast(event.detail ?? '运行失败', 'error');
        }
      });
      setMessage('');
      await Promise.all([conversations.reload(), runs.reload()]);
      if (selectedConversation) await detail.reload();
      onChanged?.();
    } catch (error) {
      toast(getErrorMessage(error), 'error');
    } finally {
      setSending(false);
    }
  };

  const messages = detail.data?.messages ?? [];

  return (
    <div className="grid-2">
      <div className="card card-pad">
        <div className="section-head mb-12">
          <div><h4>对话</h4><div className="text-xs muted mt-8">每一步工具调用都会先亮出来，再流式给出正文</div></div>
          <Icon name="headphones" size={16} className="muted" />
        </div>
        <div className="row wrap mb-12">
          <select className="input" value={selectedConversation ?? ''} onChange={(event) => { setSelectedConversation(event.target.value || null); setReply(''); setSteps([]); }}>
            <option value="">新会话</option>
            {(conversations.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>{item.title}（{item.messageCount}）</option>
            ))}
          </select>
        </div>

        <div className="stack-sm" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {detail.loading && !detail.data ? <Skeleton height={80} /> : null}
          {messages.length ? messages.map((item) => (
            <div key={item.id} className="card-pad" style={{ background: item.role === 'user' ? 'var(--surface-2)' : 'transparent', borderRadius: 10 }}>
              <div className="text-xs muted mb-8">{item.role === 'user' ? '我' : '智能体'} · {formatDate(item.created_at)}</div>
              <MarkdownView source={item.content} />
            </div>
          )) : (!detail.loading && <div className="text-xs muted">还没有会话，先在下面发一句试试。</div>)}
          {(steps.length > 0 || reply) && (
            <div className="card-pad" style={{ background: 'var(--surface-2)', borderRadius: 10 }}>
              {steps.map((step, index) => <div key={index} className="text-xs muted">· {step}</div>)}
              {reply && <MarkdownView source={reply} className="mt-12" />}
            </div>
          )}
        </div>

        <div className="row mt-12">
          <input
            className="input grow"
            placeholder="告诉智能体要做什么，例如「把这份周报压缩成三段」"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
          />
          <Button icon="arrow" loading={sending} onClick={() => void send()}>发送</Button>
        </div>
      </div>

      <div className="card card-pad">
        <div className="section-head mb-12">
          <div><h4>运行记录</h4><div className="text-xs muted mt-8">每次会话都会留一条，含工具步骤与耗时</div></div>
          <Icon name="bolt" size={16} className="muted" />
        </div>
        {runs.loading && !runs.data ? <Skeleton height={80} /> : null}
        {runs.data?.length ? (
          <div className="stack-sm" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {runs.data.slice(0, 12).map((run) => (
              <div key={run.id} className="card-pad" style={{ background: 'var(--surface-2)', borderRadius: 10 }}>
                <div className="row wrap">
                  <Badge tone={run.status === 'success' ? 'green' : run.status === 'failed' ? 'rose' : 'neutral'}>{run.status}</Badge>
                  <span className="text-sm grow">{run.input}</span>
                  <span className="text-xs muted">{run.steps_count} 步 · {run.duration_ms}ms</span>
                  <Button variant="ghost" size="sm" icon="eye" onClick={() => setOpenRun(openRun === run.id ? null : run.id)}>
                    {openRun === run.id ? '收起' : '详情'}
                  </Button>
                </div>
                {openRun === run.id && (
                  <div className="mt-12">
                    {runDetail.data?.steps?.length ? runDetail.data.steps.map((step) => (
                      <div key={step.id} className="text-xs muted mb-8">· [{step.step_index}] {step.tool_name} → {step.output.slice(0, 160)}</div>
                    )) : <div className="text-xs muted">{run.output.slice(0, 400)}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : <div className="text-xs muted">还没有运行记录。</div>}
      </div>
    </div>
  );
}
