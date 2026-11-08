import { useState } from 'react';
import { apiClient, getErrorMessage, streamPlatformChat } from '../lib/api.ts';
import { useLoad } from '../lib/hooks.ts';
import type {
  KnowledgeHit, PlatformConversation, PlatformConversationDetail, PlatformRun, PlatformRunDetail,
  PlatformStatus, PlatformTool,
} from '../lib/types.ts';
import {
  Badge, Button, EmptyState, ErrorBanner, Icon, MarkdownView, Skeleton, formatDate, formatNumber, useToast,
} from '../lib/ui.tsx';

export function Platform({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const status = useLoad<PlatformStatus>(() => apiClient.get<PlatformStatus>('/api/platform/status'));
  const tools = useLoad<PlatformTool[]>(() => apiClient.get<PlatformTool[]>('/api/platform/tools'));
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

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [busy, setBusy] = useState(false);

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
      await Promise.all([conversations.reload(), runs.reload(), status.reload()]);
      if (selectedConversation) await detail.reload();
      onChanged?.();
    } catch (error) {
      toast(getErrorMessage(error), 'error');
    } finally {
      setSending(false);
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      setHits(await apiClient.get<KnowledgeHit[]>(`/api/platform/knowledge/search?q=${encodeURIComponent(query.trim())}`));
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setSearching(false); }
  };

  const addKnowledge = async () => {
    if (!noteTitle.trim() || !noteBody.trim()) { toast('标题与内容都要填', 'error'); return; }
    setBusy(true);
    try {
      await apiClient.post('/api/platform/knowledge', { title: noteTitle.trim(), content: noteBody.trim() });
      setNoteTitle(''); setNoteBody('');
      await status.reload();
      toast('已加入知识库', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const reindex = async () => {
    setBusy(true);
    try {
      const result = await apiClient.post<{ chunks: number }>('/api/platform/knowledge/reindex');
      await status.reload();
      toast(`重建完成，共 ${formatNumber(result.chunks)} 个知识片段`, 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const quota = status.data?.quota;
  const messages = detail.data?.messages ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>智能体工作台</h1>
          <p>多轮会话、工具调用与知识库检索都落在本机工作区里</p>
        </div>
        <div className="page-actions">
          <Button icon="refresh" onClick={() => void reindex()} loading={busy}>重建知识索引</Button>
        </div>
      </div>

      <div className="row wrap mb-16">
        <Badge tone={status.data?.mode === 'live' ? 'green' : 'amber'}>
          {status.data?.mode === 'live' ? `模型已接入 · ${status.data.model}` : '离线规则引擎'}
        </Badge>
        <Badge tone="blue">{status.data?.tools ?? 0} 个工具</Badge>
        <Badge tone="neutral">{formatNumber(status.data?.knowledgeChunks ?? 0)} 个知识片段</Badge>
        <Badge tone="neutral">{status.data?.conversations ?? 0} 个会话</Badge>
        <Badge tone="neutral">{status.data?.runs ?? 0} 次运行</Badge>
        <span className="grow" />
        {quota && <span className="text-xs muted">今日模型调用 {quota.used} / {quota.limit}</span>}
        {status.data && <span className="text-xs muted">工作区：{status.data.workspace.name}（{status.data.workspace.role}）</span>}
      </div>

      {status.error && <ErrorBanner message={status.error} onRetry={() => void status.reload()} />}

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
            <div><h4>知识库</h4><div className="text-xs muted mt-8">检索先走关键词召回，再按余弦相似度排序——不是语义向量检索</div></div>
            <Icon name="search" size={16} className="muted" />
          </div>
          <div className="row mb-12">
            <input
              className="input grow"
              placeholder="检索知识库…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }}
            />
            <Button variant="soft" loading={searching} onClick={() => void search()}>检索</Button>
          </div>
          {hits && (hits.length ? (
            <div className="stack-sm" style={{ maxHeight: 200, overflowY: 'auto' }}>
              {hits.map((hit) => (
                <div key={hit.id} className="card-pad" style={{ background: 'var(--surface-2)', borderRadius: 10 }}>
                  <div className="row wrap mb-8">
                    <strong className="text-sm">{hit.title}</strong>
                    <Badge tone="neutral">{hit.sourceType}</Badge>
                    <span className="grow" />
                    <span className="text-xs muted">相似度 {hit.score}</span>
                  </div>
                  <div className="text-xs muted">{hit.content.slice(0, 240)}</div>
                </div>
              ))}
            </div>
          ) : <EmptyState icon="search" title="没有命中" hint="换个关键词，或先重建索引把文档 / 文献 / 邮件灌进来。" />)}

          <div className="mt-16">
            <div className="text-xs muted mb-8">手动加入一条知识</div>
            <input className="input mb-8" placeholder="标题" value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} />
            <textarea className="input" rows={3} placeholder="内容（会被切词建索引）" value={noteBody} onChange={(event) => setNoteBody(event.target.value)} />
            <Button variant="soft" size="sm" icon="plus" loading={busy} onClick={() => void addKnowledge()}>加入知识库</Button>
          </div>
        </div>

        <div className="card card-pad">
          <div className="section-head mb-12">
            <div><h4>运行记录</h4><div className="text-xs muted mt-8">每次会话都会留一条，含工具步骤与耗时</div></div>
            <Icon name="bolt" size={16} className="muted" />
          </div>
          {runs.loading && !runs.data ? <Skeleton height={80} /> : null}
          {runs.data?.length ? (
            <div className="stack-sm" style={{ maxHeight: 260, overflowY: 'auto' }}>
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

        <div className="card card-pad">
          <div className="section-head mb-12">
            <div><h4>工具</h4><div className="text-xs muted mt-8">会话里模型可以调用的动作，含只在本机生效的工具</div></div>
            <Icon name="external" size={16} className="muted" />
          </div>
          {tools.loading && !tools.data ? <Skeleton height={80} /> : null}
          <div className="stack-sm" style={{ maxHeight: 320, overflowY: 'auto' }}>
            {(tools.data ?? []).map((tool) => (
              <div key={tool.name} className="row wrap">
                <code className="text-xs">{tool.name}</code>
                <Badge tone={tool.category === 'generate' ? 'blue' : tool.category === 'action' ? 'violet' : 'amber'}>{tool.category}</Badge>
                <span className="text-xs muted grow">{tool.description.slice(0, 90)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
