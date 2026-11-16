import { useState } from 'react';
import { apiClient, getErrorMessage } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { PlatformAgent, PlatformStatus, PlatformTool } from '../../lib/types.ts';
import { Badge, Button, EmptyState, Field, IconButton, Modal, SectionTitle, formatDate, useToast } from '../../lib/ui.tsx';

interface AgentDraft {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  maxSteps: number;
}

const EMPTY: AgentDraft = { name: '', description: '', systemPrompt: '', tools: [], maxSteps: 4 };

/** 智能体 tab：工作区里的 agent 定义（提示词 + 工具白名单 + 步数上限）与自定义工具注册。 */
export function PlatformAgents({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const agents = useLoad<PlatformAgent[]>(() => apiClient.get<PlatformAgent[]>('/api/platform/agents'));
  const tools = useLoad<PlatformTool[]>(() => apiClient.get<PlatformTool[]>('/api/platform/tools'));
  const status = useLoad<PlatformStatus>(() => apiClient.get<PlatformStatus>('/api/platform/status'));
  // 上限由后端配置决定（AGENT_MAX_STEPS），前端不写死。
  const stepCeiling = status.data?.planning?.maxSteps ?? 24;
  const stepDefault = status.data?.planning?.defaultSteps ?? 8;

  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [busy, setBusy] = useState(false);


  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { toast('名称不能为空', 'error'); return; }
    setBusy(true);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        systemPrompt: draft.systemPrompt.trim(),
        tools: draft.tools,
        maxSteps: draft.maxSteps,
      };
      if (draft.id) await apiClient.patch(`/api/platform/agents/${draft.id}`, payload);
      else await apiClient.post('/api/platform/agents', payload);
      setDraft(null);
      await agents.reload();
      onChanged?.();
      toast('已保存', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await apiClient.delete(`/api/platform/agents/${id}`);
      await agents.reload();
      onChanged?.();
      toast('已删除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const toggleTool = (name: string) => {
    if (!draft) return;
    const next = draft.tools.includes(name) ? draft.tools.filter((item) => item !== name) : [...draft.tools, name];
    setDraft({ ...draft, tools: next });
  };

  const generateTools = (tools.data ?? []).filter((tool) => tool.category !== 'custom');

  return (
    <div>
      <SectionTitle
        title="智能体定义"
        hint="提示词与工具白名单都落在工作区里；不填即使用默认行为"
        action={<div className="row"><Button variant="ghost" size="sm" icon="bolt" onClick={() => { window.location.hash = '#/platform/plugins'; }}>管理插件</Button><Button size="sm" icon="plus" onClick={() => setDraft({ ...EMPTY, maxSteps: stepDefault })}>新建智能体</Button></div>}
      />

      {agents.error && <div className="text-xs muted mb-12">{agents.error}</div>}
      {(agents.data ?? []).length ? (
        <div className="grid-2">
          {(agents.data ?? []).map((agent) => (
            <div key={agent.id} className="card card-pad">
              <div className="row wrap mb-8">
                <strong>{agent.name}</strong>
                <Badge tone="blue">{agent.max_steps} 步上限</Badge>
                <span className="grow" />
                <IconButton icon="edit" title="编辑" onClick={() => setDraft({
                  id: agent.id, name: agent.name, description: agent.description,
                  systemPrompt: agent.system_prompt, tools: agent.tools, maxSteps: agent.max_steps,
                })} />
                <IconButton icon="trash" title="删除" onClick={() => void remove(agent.id)} />
              </div>
              <div className="text-xs muted mb-8">{agent.description || '没有描述'}</div>
              <div className="text-xs muted mb-8">工具：{agent.tools.length ? agent.tools.join('、') : '继承默认全部'}</div>
              <div className="text-xs muted">创建于 {formatDate(agent.created_at)}</div>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="sparkles" title="还没有自定义智能体" hint="不建也能用默认智能体；建了可以限定工具与步数。" />}

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? '编辑智能体' : '新建智能体'}
        subtitle="system prompt 会拼在平台默认提示词之后"
        footer={<><Button variant="ghost" onClick={() => setDraft(null)}>取消</Button><Button loading={busy} onClick={() => void save()}>保存</Button></>}
      >
        {draft && (
          <div className="stack-sm">
            <Field label="名称"><input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
            <Field label="描述"><input className="input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
            <Field label="系统提示词" hint="留空表示不加额外约束">
              <textarea className="input" rows={4} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} />
            </Field>
            <Field label="步数上限" hint={`1–${stepCeiling}，实际还受工作区配额与运行时长约束`}>
              <input className="input" type="number" min={1} max={stepCeiling} value={draft.maxSteps}
                onChange={(event) => setDraft({ ...draft, maxSteps: Math.min(stepCeiling, Math.max(1, Number(event.target.value) || 1)) })} />
            </Field>
            <Field label="工具白名单" hint={draft.tools.length ? '已选 ' + draft.tools.length + ' 个' : '不选 = 继承默认全部工具'}>
              <div className="row wrap" style={{ maxHeight: 180, overflowY: 'auto' }}>
                {generateTools.map((tool) => (
                  <button key={tool.name} type="button" className={`btn btn-sm ${draft.tools.includes(tool.name) ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => toggleTool(tool.name)}>{tool.name}</button>
                ))}
              </div>
            </Field>
          </div>
        )}
      </Modal>

    </div>
  );
}
