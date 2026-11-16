import { useState } from 'react';
import { apiClient, getErrorMessage } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { MemoryLayerStatus, PlatformMemory, PlatformStatus } from '../../lib/types.ts';
import { Badge, Button, EmptyState, Field, Icon, formatDate, useToast } from '../../lib/ui.tsx';

const KINDS = [
  { value: 'preference', label: '偏好' },
  { value: 'fact', label: '事实' },
  { value: 'project', label: '项目背景' },
];

const LAYER_TONE: Record<string, 'blue' | 'violet' | 'amber' | 'green' | 'neutral'> = {
  preference: 'blue', semantic: 'violet', working: 'amber', episodic: 'green',
};

/**
 * 记忆 tab：长期记忆现在只由「显式保存」产生——智能体的 memory_save 工具，或这里手动添加。
 * 不再靠正则猜测，用户可随时删除任意一条。
 */
export function PlatformMemories({ status, reloadStatus }: { status: PlatformStatus | null; reloadStatus: () => Promise<void> }) {
  const toast = useToast();
  const memories = useLoad<PlatformMemory[]>(() => apiClient.get<PlatformMemory[]>('/api/platform/memories'));
  const [content, setContent] = useState('');
  const [kind, setKind] = useState('preference');
  const [busy, setBusy] = useState(false);
  const [activeLayer, setActiveLayer] = useState<string>('');
  const layers = useLoad<MemoryLayerStatus>(() => apiClient.get<MemoryLayerStatus>('/api/platform/memories/layers'));

  const clearLayer = async (layer: string, label: string) => {
    if (!window.confirm(`确定清空「${label}」层的全部记忆？此操作不可撤销。`)) return;
    try {
      const result = await apiClient.delete<{ removed: number }>(`/api/platform/memories/layers/${layer}`);
      await Promise.all([memories.reload(), layers.reload(), reloadStatus()]);
      toast(`已清空 ${result.removed} 条`, 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const purge = async () => {
    try {
      const result = await apiClient.post<{ removed: number }>('/api/platform/memories/purge', {});
      await Promise.all([memories.reload(), layers.reload(), reloadStatus()]);
      toast(result.removed ? `已清理 ${result.removed} 条过期记忆` : '没有过期记忆', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const visible = (memories.data ?? []).filter((item) => !activeLayer || item.layer === activeLayer);

  const add = async () => {
    if (!content.trim()) { toast('请先填写要记住的内容', 'error'); return; }
    setBusy(true);
    try {
      await apiClient.post('/api/platform/memories', { content: content.trim(), kind });
      setContent('');
      await memories.reload();
      await reloadStatus();
      toast('已保存记忆', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm('确定删除这条记忆？删除后智能体不再引用它。')) return;
    try {
      await apiClient.delete(`/api/platform/memories/${id}`);
      await memories.reload();
      await reloadStatus();
      toast('记忆已删除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  return (
    <div className="grid-2">
      <div className="card card-pad">
        <div className="section-head mb-12">
          <div>
            <h4>长期记忆</h4>
            <div className="text-xs muted mt-8">
              共 {status?.memories ?? memories.data?.length ?? 0} 条 · 按与当前问题的相关性召回，不是只取最新几条
            </div>
          </div>
          <Button variant="soft" size="sm" icon="refresh" onClick={() => void memories.reload()}>刷新</Button>
        </div>

        <div className="row wrap mb-12">
          <Button size="sm" variant={activeLayer === '' ? 'primary' : 'ghost'} onClick={() => setActiveLayer('')}>全部</Button>
          {(layers.data?.layers ?? []).map((layer) => (
            <Button key={layer.layer} size="sm" variant={activeLayer === layer.layer ? 'primary' : 'ghost'}
              onClick={() => setActiveLayer(layer.layer)}>
              {layer.label} {layer.count}/{layer.cap}
            </Button>
          ))}
        </div>

        {visible.length ? (
          <div className="stack-sm" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {visible.map((item) => (
              <div key={item.id} className="card-pad" style={{ background: 'var(--surface-2)', borderRadius: 10 }}>
                <div className="row wrap mb-8">
                  <Badge tone={LAYER_TONE[item.layer ?? ''] ?? 'neutral'}>{item.layerLabel ?? item.layer ?? '记忆'}</Badge>
                  <Badge tone={item.source === 'manual' ? 'green' : 'amber'}>
                    {item.source === 'manual' ? '手动保存' : item.source === 'agent_run' ? '运行留痕' : '智能体保存'}
                  </Badge>
                  {item.hitCount ? <Badge tone="neutral">命中 {item.hitCount} 次</Badge> : null}
                  <span className="grow" />
                  <span className="text-xs muted">{formatDate(item.createdAt)}</span>
                  <Button variant="danger" size="sm" icon="trash" onClick={() => void remove(item.id)}>删除</Button>
                </div>
                <div className="text-sm">{item.content}</div>
                {item.expiresAt ? <div className="text-xs muted mt-8">保留至 {formatDate(item.expiresAt)}</div> : null}
                {item.runId ? <div className="text-xs muted mt-8">来源运行：{item.runId}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="headphones" title="还没有记忆"
            hint="在对话里让智能体「记住」某件事，或在右侧手动添加。随口一句话不会被自动记住。" />
        )}
      </div>

      <div className="card card-pad">
        <div className="section-head mb-12">
          <div><h4>手动添加</h4><div className="text-xs muted mt-8">相同内容会自动去重，不会产生重复条目</div></div>
          <Icon name="plus" size={16} className="muted" />
        </div>
        <Field label="类型">
          <div className="row wrap">
            {KINDS.map((item) => (
              <Button key={item.value} size="sm" variant={kind === item.value ? 'primary' : 'ghost'} onClick={() => setKind(item.value)}>
                {item.label}
              </Button>
            ))}
          </div>
        </Field>
        <Field label="内容" hint="一句话，不超过 2000 字符">
          <textarea className="input" rows={4} value={content} placeholder="例如：周报一律用简体中文，结论先行"
            onChange={(event) => setContent(event.target.value)} />
        </Field>
        <Button icon="check" loading={busy} onClick={() => void add()}>保存记忆</Button>

        <div className="mt-16 text-xs muted">
          记忆是你自己的数据：可随时删除，删除后不再进入智能体的上下文。
        </div>

        <div className="mt-16">
          <h4 className="mb-8">分层与清理</h4>
          <div className="text-xs muted mb-8">{layers.data?.note ?? ''}</div>
          <div className="stack-sm">
            {(layers.data?.layers ?? []).map((layer) => (
              <div key={layer.layer} className="row">
                <span className="text-xs grow">{layer.label}：{layer.count} / {layer.cap}</span>
                <Button variant="ghost" size="sm" disabled={!layer.count}
                  onClick={() => void clearLayer(layer.layer, layer.label)}>清空该层</Button>
              </div>
            ))}
          </div>
          <div className="row mt-12">
            <Button variant="soft" size="sm" icon="refresh" onClick={() => void purge()}>清理过期记忆</Button>
          </div>
          <div className="text-xs muted mt-8">
            会话短期记忆保留 {layers.data?.workingTtlMinutes ?? 0} 分钟，只在当前会话内可见；
            执行经验保留 {layers.data?.episodicTtlDays ?? 0} 天。
          </div>
        </div>
      </div>
    </div>
  );
}