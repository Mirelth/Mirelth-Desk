import { useEffect, useState } from 'react';
import { apiClient, downloadFile, getErrorMessage, streamTask } from '../lib/api.ts';
import { useLoad, useStream } from '../lib/hooks.ts';
import type { DocumentDto, DocumentTemplate, TaskKind } from '../lib/types.ts';
import {
  AiOutput, Badge, Button, EmptyState, ErrorBanner, Field, Icon, IconButton, MarkdownView, Modal, Segmented,
  Skeleton, formatDate, useToast,
} from '../lib/ui.tsx';

const AI_ACTIONS: Array<{ action: string; label: string; kind: TaskKind; icon: 'bolt' | 'wand' | 'edit' | 'arrow' | 'eye' }> = [
  { action: 'outline', label: '生成大纲', kind: 'document.outline', icon: 'bolt' },
  { action: 'draft', label: '起草正文', kind: 'document.draft', icon: 'wand' },
  { action: 'polish', label: '润色', kind: 'document.polish', icon: 'edit' },
  { action: 'continue', label: '续写', kind: 'document.continue', icon: 'arrow' },
  { action: 'summarize', label: '摘要', kind: 'document.summarize', icon: 'eye' },
];

export function Documents({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const docs = useLoad<DocumentDto[]>(() => apiClient.get<DocumentDto[]>('/api/documents'));
  const templates = useLoad<DocumentTemplate[]>(() => apiClient.get<DocumentTemplate[]>('/api/documents/templates'));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DocumentDto | null>(null);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [saving, setSaving] = useState(false);
  const [points, setPoints] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('未命名文档');
  const [newTemplate, setNewTemplate] = useState('general');
  const [creating, setCreating] = useState(false);
  const [aiLabel, setAiLabel] = useState('');
  const stream = useStream();

  useEffect(() => {
    if (!docs.data?.length) return;
    if (!selectedId || !docs.data.some((doc) => doc.id === selectedId)) setSelectedId(docs.data[0].id);
  }, [docs.data, selectedId]);

  useEffect(() => {
    const current = docs.data?.find((doc) => doc.id === selectedId);
    if (current) setDraft({ ...current });
  }, [selectedId, docs.data]);

  const runAi = async (kind: TaskKind, label: string) => {
    if (!draft || stream.running) return;
    stream.reset();
    setAiLabel(label);
    stream.setRunning(true);
    const template = templates.data?.find((item) => item.id === draft.template);
    const input = {
      title: draft.title,
      template: template?.name ?? '通用文档',
      sections: template?.sections ?? [],
      content: draft.content,
      points: points.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean),
    };
    let full = '';
    try {
      await streamTask(kind, input, {
        onDelta: (chunk) => { full += chunk; stream.setText(full); },
        onMeta: (meta) => stream.setLabel(meta.label),
        onError: (message) => stream.setError(message),
      });
    } catch (error) {
      stream.setError(getErrorMessage(error));
    } finally {
      stream.setRunning(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await apiClient.patch<DocumentDto>(`/api/documents/${draft.id}`, { title: draft.title, content: draft.content });
      await docs.reload();
      onChanged?.();
      toast('文档已保存', 'success');
    } catch (error) {
      toast(getErrorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      const created = await apiClient.post<DocumentDto>('/api/documents', {
        title: newTitle.trim() || '未命名文档', template: newTemplate,
        kind: templates.data?.find((item) => item.id === newTemplate)?.kind ?? 'general',
      });
      setCreateOpen(false);
      setSelectedId(created.id);
      await docs.reload();
      onChanged?.();
      toast('文档已创建，试试右侧的 AI 起草', 'success');
    } catch (error) {
      toast(getErrorMessage(error), 'error');
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    if (!draft || !window.confirm(`确定删除「${draft.title}」？此操作不可撤销。`)) return;
    try {
      await apiClient.delete(`/api/documents/${draft.id}`);
      setSelectedId(null);
      setDraft(null);
      await docs.reload();
      onChanged?.();
      toast('文档已删除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const exportDoc = async (format: 'md' | 'html') => {
    if (!draft) return;
    try {
      await downloadFile(`/api/documents/${draft.id}/export?format=${format}`, `${draft.title}.${format}`);
      toast(`已导出 ${format.toUpperCase()}`, 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const applyAi = (mode: 'append' | 'replace') => {
    if (!draft || !stream.text) return;
    setDraft({ ...draft, content: mode === 'append' ? `${draft.content}\n\n${stream.text}` : stream.text });
    setTab('edit');
    toast(mode === 'append' ? '已追加到文档，记得保存' : '已替换正文，记得保存', 'success');
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>文档协作</h1><p>结构化模板 + AI 起草，支持 Markdown 编辑、预览与导出</p></div>
        <div className="page-actions">
          <Button icon="plus" onClick={() => setCreateOpen(true)}>新建文档</Button>
        </div>
      </div>

      {docs.error && <ErrorBanner message={docs.error} onRetry={() => void docs.reload()} />}

      <div className="split-layout">
        <div className="card list-pane">
          <div className="list-search">
            <div className="search-box"><Icon name="search" size={15} />
              <input placeholder="搜索文档…" onChange={(event) => {
                const q = event.target.value;
                void apiClient.get<DocumentDto[]>(`/api/documents?q=${encodeURIComponent(q)}`).then(docs.setData).catch(() => undefined);
              }} />
            </div>
          </div>
          <div className="list-scroll">
            {docs.loading && !docs.data ? <div style={{ padding: 12 }}><Skeleton height={70} /><Skeleton height={70} /></div> : null}
            {docs.data?.length ? docs.data.map((doc) => (
              <button type="button" key={doc.id} className={`list-item ${selectedId === doc.id ? 'active' : ''}`}
                onClick={() => { setSelectedId(doc.id); stream.reset(); }}>
                <div className="list-title">{doc.title}</div>
                <div className="list-excerpt">{doc.excerpt || '（空白文档）'}</div>
                <div className="list-meta"><span>{formatDate(doc.updatedAt)}</span><span>{doc.wordCount} 字</span><Badge tone={doc.status === 'final' ? 'green' : 'neutral'}>{doc.status === 'final' ? '定稿' : '草稿'}</Badge></div>
              </button>
            )) : !docs.loading && <EmptyState icon="file" title="还没有文档" hint="点击右上角新建，从模板开始写作。" />}
          </div>
        </div>

        {!draft ? (
          <div className="card"><EmptyState icon="file" title="选择或新建一篇文档" hint="左侧是文档列表，右侧是编辑器与 AI 助手。" /></div>
        ) : (
          <div className="card detail-pane">
            <div className="toolbar">
              <Segmented options={[{ value: 'edit', label: '编辑' }, { value: 'preview', label: '预览' }]} value={tab} onChange={setTab} />
              <span className="grow" />
              <IconButton icon="download" title="导出 Markdown" onClick={() => void exportDoc('md')} />
              <IconButton icon="external" title="导出 HTML" onClick={() => void exportDoc('html')} />
              <IconButton icon="trash" title="删除文档" onClick={() => void remove()} />
              <Button icon="save" loading={saving} onClick={() => void save()}>保存</Button>
            </div>
            <input className="editor-title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            <div className="editor-meta">
              <span>{draft.wordCount} 字</span><span>更新于 {formatDate(draft.updatedAt)}</span>
              <span>{templates.data?.find((item) => item.id === draft.template)?.name ?? '通用文档'}</span>
              <span className="grow" />
              <Badge tone="blue">{draft.status === 'final' ? '定稿' : '草稿'}</Badge>
            </div>
            {tab === 'edit'
              ? <textarea className="editor-area" value={draft.content} placeholder="在这里输入 Markdown 内容，或使用下方 AI 能力生成初稿…"
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
              : <div className="editor-preview"><MarkdownView source={draft.content || '> 暂无内容'} /></div>}

            <div className="ai-panel">
              <div className="row wrap mb-12">
                <strong className="text-sm"><span className="muted">AI 写作</span></strong>
                {AI_ACTIONS.map((action) => (
                  <Button key={action.action} variant="soft" size="sm" icon={action.icon} disabled={stream.running}
                    onClick={() => void runAi(action.kind, action.label)}>{action.label}</Button>
                ))}
              </div>
              <input className="input mb-12" placeholder="需要覆盖的要点（用逗号分隔，可选）" value={points}
                onChange={(event) => setPoints(event.target.value)} />
              <AiOutput text={stream.text} running={stream.running} error={stream.error}
                label={`${aiLabel || '智能体输出'}${stream.label ? ` · ${stream.label}` : ''}`}
                onInsert={() => applyAi('append')} onReplace={() => applyAi('replace')}
                onCopy={() => { void navigator.clipboard.writeText(stream.text).then(() => toast('已复制', 'success')); }} />
            </div>
          </div>
        )}
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="新建文档" subtitle="选择模板后即可用 AI 起草正文"
        footer={<><Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button><Button icon="check" loading={creating} onClick={() => void create()}>创建</Button></>}>
        <Field label="文档标题"><input className="input" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} autoFocus /></Field>
        <div className="field">
          <span className="field-label">选择模板</span>
          <div className="stack" style={{ gap: 8 }}>
            {templates.data?.map((template) => (
              <button type="button" key={template.id} className={`quick-item ${newTemplate === template.id ? 'active' : ''}`}
                style={newTemplate === template.id ? { borderColor: '#bcc4ff', background: '#eef0ff' } : undefined}
                onClick={() => setNewTemplate(template.id)}>
                <span className="qi-icon" style={{ background: '#fff' }}><span className="muted">#</span></span>
                <span><strong>{template.name}</strong><span>{template.description}</span></span>
              </button>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
