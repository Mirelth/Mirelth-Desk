import { useState } from 'react';
import { apiClient, getErrorMessage } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { PlatformEvent, PlatformTool, PlatformWorkflow, PlatformWorkflowNode } from '../../lib/types.ts';
import { Badge, Button, EmptyState, Field, IconButton, Modal, SectionTitle, formatDate, useToast } from '../../lib/ui.tsx';

interface NodeDraft { tool: string; args: string }

const SAMPLE_NODES: NodeDraft[] = [{ tool: 'rag_search', args: '{"query":"周报"}' }];

/** 工作流 tab：按节点顺序执行工具（`edges` 被忽略），以及事件发射与最近事件。 */
export function PlatformWorkflows() {
  const toast = useToast();
  const workflows = useLoad<PlatformWorkflow[]>(() => apiClient.get<PlatformWorkflow[]>('/api/platform/workflows'));
  const events = useLoad<PlatformEvent[]>(() => apiClient.get<PlatformEvent[]>('/api/platform/events'));
  const tools = useLoad<PlatformTool[]>(() => apiClient.get<PlatformTool[]>('/api/platform/tools'));

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nodes, setNodes] = useState<NodeDraft[]>(SAMPLE_NODES);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>('');

  const [eventKey, setEventKey] = useState('');
  const [payload, setPayload] = useState('{}');

  const save = async () => {
    if (!name.trim()) { toast('工作流名称不能为空', 'error'); return; }
    let parsed: PlatformWorkflowNode[];
    try {
      parsed = nodes.map((node, index) => ({
        id: `n${index + 1}`,
        tool: node.tool,
        args: node.args.trim() ? JSON.parse(node.args) as Record<string, unknown> : {},
      }));
    } catch { toast('节点参数不是合法 JSON', 'error'); return; }
    setBusy(true);
    try {
      await apiClient.post('/api/platform/workflows', { name: name.trim(), nodes: parsed, edges: [] });
      setOpen(false); setName(''); setNodes(SAMPLE_NODES);
      await workflows.reload();
      toast('已保存工作流', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const run = async (id: string) => {
    setBusy(true);
    try {
      const data = await apiClient.post<{ text: string }>(`/api/platform/workflows/${id}/run`);
      setResult(data.text);
      toast('执行完成', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const emit = async () => {
    if (!eventKey.trim()) { toast('事件名不能为空', 'error'); return; }
    let body: Record<string, unknown>;
    try { body = payload.trim() ? JSON.parse(payload) as Record<string, unknown> : {}; }
    catch { toast('payload 不是合法 JSON', 'error'); return; }
    setBusy(true);
    try {
      const data = await apiClient.post<{ matched: number; executed: number }>('/api/platform/events/emit', { eventKey: eventKey.trim(), payload: body });
      await events.reload();
      toast(`匹配 ${data.matched} 个事件任务，执行 ${data.executed} 个`, 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <SectionTitle
        title="工作流"
        hint="节点按数组顺序逐个执行，节点之间的 edges 目前不参与调度"
        action={<Button size="sm" icon="plus" onClick={() => setOpen(true)}>新建工作流</Button>}
      />

      {(workflows.data ?? []).length ? (
        <div className="grid-2">
          {(workflows.data ?? []).map((workflow) => (
            <div key={workflow.id} className="card card-pad">
              <div className="row wrap mb-8">
                <strong>{workflow.name}</strong>
                <Badge tone={workflow.enabled ? 'green' : 'neutral'}>{workflow.enabled ? '启用' : '停用'}</Badge>
                <span className="grow" />
                <Button variant="soft" size="sm" icon="bolt" loading={busy} onClick={() => void run(workflow.id)}>运行</Button>
              </div>
              <div className="text-xs muted">{workflow.nodes.map((node) => node.tool).join(' → ') || '没有节点'}</div>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="layers" title="还没有工作流" hint="把几个工具串起来，一次跑完——例如先检索知识库，再起草文档。" />}

      {result && (
        <div className="card card-pad mt-16">
          <div className="section-head mb-12"><h4>最近一次执行</h4><Button variant="ghost" size="sm" icon="close" onClick={() => setResult('')}>清空</Button></div>
          <pre className="text-xs" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result}</pre>
        </div>
      )}

      <div className="card card-pad mt-16">
        <div className="section-head mb-12">
          <div><h4>事件</h4><div className="text-xs muted mt-8">事件按账号匹配自动化任务（任务的 workspace_id 目前为空，按工作区匹配会恒为 0）</div></div>
          <Badge tone="neutral">{events.data?.length ?? 0} 条</Badge>
        </div>
        <div className="row wrap mb-12">
          <input className="input grow" placeholder="事件名，例如 dataset.ready" value={eventKey} onChange={(event) => setEventKey(event.target.value)} />
          <input className="input grow" placeholder='payload JSON，例如 {"source":"ci"}' value={payload} onChange={(event) => setPayload(event.target.value)} />
          <Button size="sm" icon="bolt" loading={busy} onClick={() => void emit()}>发射</Button>
        </div>
        {(events.data ?? []).length ? (events.data ?? []).slice(0, 12).map((event) => (
          <div key={event.id} className="row wrap mb-8">
            <code className="text-xs">{event.event_key}</code>
            <Badge tone={event.status === 'processed' ? 'green' : 'amber'}>{event.status}</Badge>
            <span className="text-xs muted grow">{event.payload.slice(0, 120)}</span>
            <span className="text-xs muted">{formatDate(event.created_at)}</span>
          </div>
        )) : <div className="text-xs muted">还没有事件。外部系统可以用工作区 API Key 调到 /api/platform/webhook/&lt;事件名&gt;。</div>}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="新建工作流"
        subtitle="每个节点是一次工具调用；参数写 JSON，留空表示 {}"
        width={640}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>取消</Button><Button loading={busy} onClick={() => void save()}>保存</Button></>}
      >
        <div className="stack-sm">
          <Field label="名称"><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></Field>
          {nodes.map((node, index) => (
            <div key={index} className="row wrap">
              <select className="input" value={node.tool} onChange={(event) => setNodes(nodes.map((item, i) => (i === index ? { ...item, tool: event.target.value } : item)))}>
                {(tools.data ?? []).map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
              </select>
              <input className="input grow" placeholder='{"query":"…"}' value={node.args}
                onChange={(event) => setNodes(nodes.map((item, i) => (i === index ? { ...item, args: event.target.value } : item)))} />
              <IconButton icon="trash" title="移除节点" onClick={() => setNodes(nodes.filter((_, i) => i !== index))} />
            </div>
          ))}
          <Button variant="ghost" size="sm" icon="plus" onClick={() => setNodes([...nodes, { tool: tools.data?.[0]?.name ?? 'rag_search', args: '{}' }])}>添加节点</Button>
        </div>
      </Modal>
    </div>
  );
}
