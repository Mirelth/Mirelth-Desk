import { useState } from 'react';
import { apiClient, getErrorMessage } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { KnowledgeHit, PlatformStatus, PlatformTool, VectorIndexStatus } from '../../lib/types.ts';
import { Badge, Button, EmptyState, Icon, formatNumber, useToast } from '../../lib/ui.tsx';

/** 知识库 tab：检索、手动加一条、重建索引；右侧是会话可调用的工具清单。 */
export function PlatformKnowledge({ status, reloadStatus }: { status: PlatformStatus | null; reloadStatus: () => Promise<void> }) {
  const toast = useToast();
  const tools = useLoad<PlatformTool[]>(() => apiClient.get<PlatformTool[]>('/api/platform/tools'));

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [busy, setBusy] = useState(false);

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
      await reloadStatus();
      toast('已加入知识库', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const reindex = async () => {
    setBusy(true);
    try {
      const result = await apiClient.post<{ chunks: number }>('/api/platform/knowledge/reindex');
      await reloadStatus();
      toast(`重建完成，共 ${formatNumber(result.chunks)} 个知识片段`, 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const vectorIndex = useLoad<VectorIndexStatus>(() => apiClient.get<VectorIndexStatus>('/api/platform/knowledge/index'));

  const buildVectorIndex = async (force: boolean) => {
    setBusy(true);
    try {
      const result = await apiClient.post<{ buckets: number; assigned: number }>('/api/platform/knowledge/index', { force });
      await Promise.all([vectorIndex.reload(), reloadStatus()]);
      toast(`索引已建立：${result.buckets} 个桶、${result.assigned} 个片段`, 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const dropVectorIndex = async () => {
    if (!window.confirm('确定删除向量索引？删除后检索退回全表扫描。')) return;
    try {
      await apiClient.delete('/api/platform/knowledge/index');
      await Promise.all([vectorIndex.reload(), reloadStatus()]);
      toast('向量索引已删除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  return (
    <div className="grid-2">
      <div className="card card-pad">
        <div className="section-head mb-12">
          <div><h4>知识库</h4><div className="text-xs muted mt-8">
            {status?.retrieval?.mode === 'hybrid'
              ? `语义向量 + 词法混合召回，RRF 融合排序（${status.retrieval.semanticChunks} 个片段已向量化）`
              : '词法召回 + 余弦排序。配置 LLM_EMBEDDING_MODEL 后自动升级为语义混合检索'}
          </div></div>
          <Button variant="soft" size="sm" icon="refresh" loading={busy} onClick={() => void reindex()}>重建索引</Button>
        </div>

        <div className="card-pad mb-12" style={{ background: 'var(--surface-2)', borderRadius: 10 }}>
          <div className="row wrap mb-8">
            <strong className="text-sm">向量索引</strong>
            {vectorIndex.data?.stats?.indexed ? (
              <Badge tone={vectorIndex.data.stats.mode === 'index' ? 'green' : 'neutral'}>
                {vectorIndex.data.stats.mode === 'index' ? '索引裁剪生效' : '已建索引，当前走全扫'}
              </Badge>
            ) : <Badge tone="neutral">未建索引</Badge>}
            <span className="grow" />
            <Button variant="ghost" size="sm" loading={busy} onClick={() => void buildVectorIndex(false)}>建立/补全</Button>
            <Button variant="ghost" size="sm" loading={busy} onClick={() => void buildVectorIndex(true)}>重训</Button>
            {vectorIndex.data?.stats?.indexed ? (
              <Button variant="ghost" size="sm" onClick={() => void dropVectorIndex()}>删除</Button>
            ) : null}
          </div>
          <div className="text-xs muted">{vectorIndex.data?.note ?? ''}</div>
          {vectorIndex.data?.stats?.indexed ? (
            <div className="text-xs muted mt-8">
              {vectorIndex.data.stats.buckets} 桶 · 已归桶 {vectorIndex.data.stats.assigned}/{vectorIndex.data.stats.chunks} 片段
              · 探查 {vectorIndex.data.stats.probes} 桶 · 桶不平衡度 {vectorIndex.data.stats.imbalance}
              {vectorIndex.data.stats.imbalance >= 6 ? '（偏高，建议重训）' : ''}
            </div>
          ) : null}
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
          <div className="stack-sm" style={{ maxHeight: 260, overflowY: 'auto' }}>
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
          <div><h4>工具</h4><div className="text-xs muted mt-8">{status?.tools ?? 0} 个工具：{formatNumber(status?.knowledgeChunks ?? 0)} 个知识片段已索引</div></div>
          <Icon name="external" size={16} className="muted" />
        </div>
        <div className="stack-sm" style={{ maxHeight: 420, overflowY: 'auto' }}>
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
  );
}
