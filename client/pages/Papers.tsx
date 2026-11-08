import { useState } from 'react';
import { apiClient, downloadFile, getErrorMessage, streamTask } from '../lib/api.ts';
import { useLoad, usePaged, useStream } from '../lib/hooks.ts';
import type { PaperDto, PaperStats, TaskKind } from '../lib/types.ts';
import { AiOutput, Badge, Button, EmptyState, ErrorBanner, Field, Icon, IconButton, Modal, Skeleton, useToast } from '../lib/ui.tsx';

interface PaperForm {
  title: string; authors: string; year: string; venue: string; doi: string; url: string;
  abstract: string; tags: string; status: string; rating: number; notes: string;
}

const EMPTY_FORM: PaperForm = {
  title: '', authors: '', year: '', venue: '', doi: '', url: '', abstract: '', tags: '',
  status: 'unread', rating: 0, notes: '',
};

const STATUS_LABEL: Record<string, string> = { unread: '未读', reading: '在读', read: '已读' };
const STATUS_NEXT: Record<string, string> = { unread: 'reading', reading: 'read', read: 'read' };

export function Papers({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const query = `/api/papers?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}&tag=${encodeURIComponent(tag)}`;
  const list = usePaged<PaperDto>(query, 20);
  const stats = useLoad<PaperStats>(() => apiClient.get<PaperStats>('/api/papers/stats'));
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PaperForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bibtex, setBibtex] = useState('');
  const [notesId, setNotesId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [aiLabel, setAiLabel] = useState('');
  const stream = useStream();

  const openCreate = () => { setEditingId(null); setForm({ ...EMPTY_FORM }); setFormOpen(true); };
  const openEdit = (paper: PaperDto) => {
    setEditingId(paper.id);
    setForm({
      title: paper.title, authors: paper.authors, year: paper.year ? String(paper.year) : '',
      venue: paper.venue, doi: paper.doi, url: paper.url, abstract: paper.abstract,
      tags: paper.tags.join('，'), status: paper.status, rating: paper.rating, notes: paper.notes,
    });
    setFormOpen(true);
  };

  const payload = () => ({
    title: form.title.trim(), authors: form.authors.trim(), year: form.year ? Number(form.year) : null,
    venue: form.venue.trim(), doi: form.doi.trim(), url: form.url.trim(), abstract: form.abstract.trim(),
    tags: form.tags.split(/[,，;]/).map((item) => item.trim()).filter(Boolean),
    status: form.status, rating: form.rating, notes: form.notes,
  });

  const save = async () => {
    if (!form.title.trim()) { toast('请填写文献标题', 'error'); return; }
    setSaving(true);
    try {
      if (editingId) await apiClient.patch(`/api/papers/${editingId}`, payload());
      else await apiClient.post('/api/papers', payload());
      setFormOpen(false);
      await Promise.all([list.reload(), stats.reload()]);
      onChanged?.();
      toast(editingId ? '文献已更新' : '文献已收录', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setSaving(false); }
  };

  const patch = async (id: string, body: Record<string, unknown>, message: string) => {
    try {
      await apiClient.patch(`/api/papers/${id}`, body);
      await Promise.all([list.reload(), stats.reload()]);
      toast(message, 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const remove = async (paper: PaperDto) => {
    if (!window.confirm(`确定移除「${paper.title}」？`)) return;
    try {
      await apiClient.delete(`/api/papers/${paper.id}`);
      await Promise.all([list.reload(), stats.reload()]);
      onChanged?.();
      toast('已移除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const importBibtex = async () => {
    try {
      const result = await apiClient.post<{ created: number; skipped: number }>('/api/papers/import', { bibtex });
      setImportOpen(false);
      setBibtex('');
      await Promise.all([list.reload(), stats.reload()]);
      onChanged?.();
      toast(`导入完成：新增 ${result.created} 篇，跳过重复 ${result.skipped} 篇`, 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const exportRefs = async (format: 'bibtex' | 'ris' | 'apa') => {
    try {
      await downloadFile(`/api/papers/export?format=${format}`, `references.${format}`);
      toast('引用已导出', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const runAi = async (kind: TaskKind, label: string) => {
    stream.reset();
    setAiLabel(label);
    stream.setRunning(true);
    let full = '';
    try {
      await streamTask(kind, { papers: list.items.slice(0, 40), filter: { tag, status } }, {
        onDelta: (chunk) => { full += chunk; stream.setText(full); },
        onMeta: (meta) => stream.setLabel(meta.label),
        onError: (message) => stream.setError(message),
      }, stream.signal);
    } catch (error) { stream.setError(getErrorMessage(error)); }
    finally { stream.setRunning(false); onChanged?.(); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>论文整理</h1><p>结构化文献库、引用导出与 AI 综述，支持 BibTeX 批量导入</p></div>
        <div className="page-actions">
          <Button variant="outline" icon="upload" onClick={() => setImportOpen(true)}>导入 BibTeX</Button>
          <Button icon="plus" onClick={openCreate}>添加文献</Button>
        </div>
      </div>

      <div className="row wrap mb-16">
        <Badge tone="blue">共 {stats.data?.total ?? 0} 篇</Badge>
        <Badge tone="amber">未读 {stats.data?.unread ?? 0}</Badge>
        <Badge tone="violet">在读 {stats.data?.reading ?? 0}</Badge>
        <Badge tone="green">已读 {stats.data?.read ?? 0}</Badge>
        <span className="grow" />
        <Button variant="outline" size="sm" icon="download" onClick={() => void exportRefs('bibtex')}>BibTeX</Button>
        <Button variant="outline" size="sm" icon="download" onClick={() => void exportRefs('ris')}>RIS</Button>
        <Button variant="outline" size="sm" icon="download" onClick={() => void exportRefs('apa')}>APA</Button>
      </div>

      <div className="filter-bar">
        <div className="search-box"><span className="muted" style={{ display: 'flex' }}><Icon name="search" size={15} /></span>
          <input placeholder="搜索标题、作者、期刊、摘要…" value={q} onChange={(event) => setQ(event.target.value)} /></div>
        <select className="select" style={{ width: 140 }} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option><option value="unread">未读</option><option value="reading">在读</option><option value="read">已读</option>
        </select>
        <div className="chip-row">
          <button type="button" className={`chip ${!tag ? 'active' : ''}`} onClick={() => setTag('')}>全部主题</button>
          {stats.data?.tags.slice(0, 6).map((item) => (
            <button type="button" key={item} className={`chip ${tag === item ? 'active' : ''}`} onClick={() => setTag(tag === item ? '' : item)}>{item}</button>
          ))}
        </div>
      </div>

      <div className="card mb-16">
        <div className="toolbar">
          <strong className="text-sm">AI 文献助手</strong>
          <Button variant="soft" size="sm" icon="bolt" disabled={stream.running} onClick={() => void runAi('paper.summary', '研究脉络分析')}>脉络分析</Button>
          <Button variant="soft" size="sm" icon="file" disabled={stream.running} onClick={() => void runAi('paper.review', '综述大纲')}>综述大纲</Button>
          <Button variant="soft" size="sm" icon="wand" disabled={stream.running} onClick={() => void runAi('paper.synthesize', '综述初稿')}>综述初稿</Button>
          <span className="grow" /><span className="text-xs muted">已加载 {list.items.length} / {list.total} 篇文献</span>
        </div>
        <div className="ai-panel" style={{ borderRadius: '0 0 16px 16px' }}>
          <AiOutput text={stream.text} running={stream.running} error={stream.error}
            label={`${aiLabel || '文献智能体'}${stream.label ? ` · ${stream.label}` : ''}`}
            onCopy={() => { void navigator.clipboard.writeText(stream.text).then(() => toast('已复制', 'success')); }}
            emptyHint="选择一个 AI 动作，基于文献元数据生成脉络分析、综述大纲或初稿。" />
        </div>
      </div>

      {list.error && <ErrorBanner message={list.error} onRetry={() => void list.reload()} />}
      {list.hasMore && (
        <div className="row mt-12">
          <Button variant="ghost" size="sm" loading={list.loading} onClick={() => void list.loadMore()}>
            加载更多（{list.items.length}/{list.total}）
          </Button>
        </div>
      )}
      {list.loading && !list.items.length ? <Skeleton height={180} /> : null}
      {list.items.length ? (
        <div className="paper-grid">
          {list.items.map((paper) => (
            <article className="paper-card" key={paper.id}>
              <div className="paper-head">
                <h4>{paper.title}</h4>
                <Badge tone={paper.status === 'read' ? 'green' : paper.status === 'reading' ? 'violet' : 'amber'}>{STATUS_LABEL[paper.status] ?? paper.status}</Badge>
              </div>
              <div className="paper-meta">{paper.authors || '作者待补充'} · {paper.year ?? '年份待补充'} · {paper.venue || '出处待补充'}</div>
              {paper.abstract && <div className="paper-abstract">{paper.abstract}</div>}
              <div className="paper-tags">
                {paper.tags.map((item) => <span className="chip" key={item}>{item}</span>)}
                {paper.doi && <a className="chip" href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">DOI</a>}
                {paper.url && <a className="chip" href={paper.url} target="_blank" rel="noreferrer">原文</a>}
              </div>
              {notesId === paper.id && (
                <div className="mt-12">
                  <textarea className="textarea" style={{ minHeight: 90 }} value={notesDraft} placeholder="记录研究问题 / 方法 / 结论 / 可复用之处…"
                    onChange={(event) => setNotesDraft(event.target.value)} />
                  <div className="row mt-8">
                    <Button size="sm" icon="save" onClick={() => void patch(paper.id, { notes: notesDraft }, '笔记已保存')}>保存笔记</Button>
                    <Button variant="ghost" size="sm" onClick={() => setNotesId(null)}>收起</Button>
                  </div>
                </div>
              )}
              <div className="paper-actions">
                {paper.status !== 'read' && (
                  <Button variant="soft" size="sm" icon="check" onClick={() => void patch(paper.id, { status: STATUS_NEXT[paper.status] }, '状态已更新')}>
                    标记{STATUS_LABEL[STATUS_NEXT[paper.status]]}
                  </Button>
                )}
                <div className="rating" title={`评分 ${paper.rating}/5`}>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button type="button" key={value} style={{ border: 0, background: 'transparent', color: 'inherit', padding: 0 }}
                      onClick={() => void patch(paper.id, { rating: value }, '评分已更新')}>{value <= paper.rating ? '★' : '☆'}</button>
                  ))}
                </div>
                <span className="grow" />
                <IconButton icon="edit" title="编辑文献" onClick={() => openEdit(paper)} />
                <IconButton icon="file" title="阅读笔记" onClick={() => { setNotesId(notesId === paper.id ? null : paper.id); setNotesDraft(paper.notes); }} />
                <IconButton icon="trash" title="移除文献" onClick={() => void remove(paper)} />
              </div>
            </article>
          ))}
        </div>
      ) : !list.loading && <div className="card"><EmptyState icon="book" title="没有匹配的文献" hint="添加一篇文献，或用 BibTeX 批量导入现有参考库。" action={<Button size="sm" icon="plus" onClick={openCreate}>添加文献</Button>} /></div>}

      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={editingId ? '编辑文献' : '添加文献'}
        subtitle="标注主题与阅读状态，之后的综述生成会用到这些元数据" width={680}
        footer={<><Button variant="ghost" onClick={() => setFormOpen(false)}>取消</Button><Button icon="save" loading={saving} onClick={() => void save()}>保存</Button></>}>
        <div className="form-grid">
          <div className="full"><Field label="标题"><input className="input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field></div>
          <div className="full"><Field label="作者"><input className="input" value={form.authors} placeholder="Vaswani, A. et al." onChange={(event) => setForm({ ...form, authors: event.target.value })} /></Field></div>
          <Field label="年份"><input className="input" value={form.year} placeholder="2023" onChange={(event) => setForm({ ...form, year: event.target.value })} /></Field>
          <Field label="期刊 / 会议"><input className="input" value={form.venue} onChange={(event) => setForm({ ...form, venue: event.target.value })} /></Field>
          <Field label="DOI"><input className="input" value={form.doi} onChange={(event) => setForm({ ...form, doi: event.target.value })} /></Field>
          <Field label="状态"><select className="select" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
            <option value="unread">未读</option><option value="reading">在读</option><option value="read">已读</option></select></Field>
          <div className="full"><Field label="标签" hint="用逗号分隔，例如：LLM，RAG，综述"><input className="input" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></Field></div>
          <div className="full"><Field label="摘要"><textarea className="textarea" value={form.abstract} onChange={(event) => setForm({ ...form, abstract: event.target.value })} /></Field></div>
          <div className="full"><Field label="原文链接"><input className="input" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} /></Field></div>
        </div>
      </Modal>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="批量导入 BibTeX" subtitle="解析 title / author / year / journal / doi 等字段，重复标题自动跳过"
        footer={<><Button variant="ghost" onClick={() => setImportOpen(false)}>取消</Button><Button icon="upload" onClick={() => void importBibtex()}>开始导入</Button></>}>
        <Field label="BibTeX 内容"><textarea className="textarea" style={{ minHeight: 240, fontFamily: 'monospace' }} value={bibtex}
          placeholder={'@article{vaswani2017,\n  title = {Attention Is All You Need},\n  author = {Vaswani, A. and Shazeer, N.},\n  year = {2017}\n}'}
          onChange={(event) => setBibtex(event.target.value)} /></Field>
      </Modal>
    </div>
  );
}
