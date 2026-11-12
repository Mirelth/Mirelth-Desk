import { useState } from 'react';
import { apiClient, getErrorMessage } from '../lib/api.ts';
import { useLoad } from '../lib/hooks.ts';
import type { AutomationAction, AutomationTask } from '../lib/types.ts';
import {
  Badge, Button, EmptyState, ErrorBanner, Field, Icon, IconButton, MarkdownView, Modal, Skeleton,
  formatDate, useToast,
} from '../lib/ui.tsx';

interface TaskForm {
  name: string; description: string; triggerType: 'manual' | 'interval';
  intervalMinutes: number; action: string; enabled: boolean;
}

const EMPTY_FORM: TaskForm = {
  name: '', description: '', triggerType: 'manual', intervalMinutes: 60,
  action: 'mail.summary', enabled: true,
};

const TRIGGER_LABEL: Record<string, string> = { manual: '手动触发', interval: '定时执行' };
const STATUS_TONE: Record<string, 'neutral' | 'green' | 'rose'> = { idle: 'neutral', success: 'green', failed: 'rose' };

export function Automation({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const tasks = useLoad<AutomationTask[]>(() => apiClient.get<AutomationTask[]>('/api/automation'));
  const actions = useLoad<AutomationAction[]>(() => apiClient.get<AutomationAction[]>('/api/automation/actions'));
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TaskForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const actionLabel = (value: string) => actions.data?.find((item) => item.value === value)?.label ?? value;

  const openCreate = () => { setEditingId(null); setForm({ ...EMPTY_FORM, action: actions.data?.[0]?.value ?? 'mail.summary' }); setFormOpen(true); };
  const openEdit = (task: AutomationTask) => {
    setEditingId(task.id);
    setForm({
      name: task.name, description: task.description, triggerType: task.triggerType,
      intervalMinutes: task.intervalMinutes || 60, action: task.action, enabled: task.enabled,
    });
    setFormOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) { toast('请填写任务名称', 'error'); return; }
    if (form.triggerType === 'interval' && form.intervalMinutes < 1) { toast('执行间隔必须大于 0 分钟', 'error'); return; }
    setBusy(true);
    try {
      if (editingId) await apiClient.patch(`/api/automation/${editingId}`, form);
      else await apiClient.post('/api/automation', form);
      setFormOpen(false);
      await tasks.reload();
      onChanged?.();
      toast(editingId ? '任务已更新' : '自动化任务已创建', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const run = async (task: AutomationTask) => {
    setRunningId(task.id);
    try {
      const result = await apiClient.post<{ ok: boolean; text: string; error?: string }>(`/api/automation/${task.id}/run`);
      await tasks.reload();
      onChanged?.();
      setExpandedId(task.id);
      toast(result.ok ? `「${task.name}」执行成功` : `执行失败：${result.error ?? '请查看结果'}`, result.ok ? 'success' : 'error');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setRunningId(null); }
  };

  const toggle = async (task: AutomationTask) => {
    try {
      await apiClient.patch(`/api/automation/${task.id}`, { enabled: !task.enabled });
      await tasks.reload();
      toast(task.enabled ? '任务已暂停' : '任务已启用', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const remove = async (task: AutomationTask) => {
    if (!window.confirm(`确定删除「${task.name}」？`)) return;
    try {
      await apiClient.delete(`/api/automation/${task.id}`);
      await tasks.reload();
      onChanged?.();
      toast('任务已删除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const enabledCount = tasks.data?.filter((task) => task.enabled).length ?? 0;
  const totalRuns = tasks.data?.reduce((sum, task) => sum + task.runCount, 0) ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>自动化任务</h1><p>把重复的办公动作交给任务调度：手动执行或按间隔自动运行</p></div>
        <div className="page-actions"><Button icon="plus" onClick={openCreate}>新建任务</Button></div>
      </div>

      <div className="row wrap mb-16">
        <Badge tone="blue">共 {tasks.data?.length ?? 0} 个任务</Badge>
        <Badge tone="green">{enabledCount} 个已启用</Badge>
        <Badge tone="neutral">累计运行 {totalRuns} 次</Badge>
        <span className="grow" />
        <span className="text-xs muted">定时任务由本机服务每分钟检查一次，服务关闭期间不执行</span>
      </div>

      {tasks.error && <ErrorBanner message={tasks.error} onRetry={() => void tasks.reload()} />}
      {tasks.loading && !tasks.data ? <Skeleton height={180} /> : null}

      {tasks.data?.length ? (
        <div className="stack">
          {tasks.data.map((task) => (
            <div className="card card-pad automation-card" key={task.id}>
              <div className="between wrap">
                <div className="row">
                  <div className="stat-icon" style={{ color: 'var(--primary)', background: 'var(--primary-soft)', margin: 0 }}><Icon name="bolt" size={17} /></div>
                  <div><h4>{task.name}</h4><div className="text-xs muted mt-8">{task.description || '暂无描述'}</div></div>
                </div>
                <div className="row wrap">
                  <Badge tone={task.enabled ? 'green' : 'neutral'}>{task.enabled ? '已启用' : '已暂停'}</Badge>
                  <Badge tone={STATUS_TONE[task.lastStatus] ?? 'neutral'}>
                    {task.lastStatus === 'success' ? '上次成功' : task.lastStatus === 'failed' ? '上次失败' : '尚未运行'}
                  </Badge>
                </div>
              </div>
              <div className="chip-row mt-12">
                <span className="chip">{TRIGGER_LABEL[task.triggerType]}{task.triggerType === 'interval' ? ` · 每 ${task.intervalMinutes} 分钟` : ''}</span>
                <span className="chip">{actionLabel(task.action)}</span>
                <span className="chip">运行 {task.runCount} 次</span>
                <span className="chip">上次 {formatDate(task.lastRunAt)}</span>
                {task.nextRunAt && <span className="chip">下次 {formatDate(task.nextRunAt)}</span>}
              </div>
              {expandedId === task.id && task.lastResult && (
                <div className="card-pad mt-12" style={{ background: 'var(--surface-2)', borderRadius: 10 }}>
                  <div className="text-xs muted mb-12">最近一次执行结果</div>
                  <MarkdownView source={task.lastResult.slice(0, 1200)} />
                </div>
              )}
              <div className="row wrap mt-16">
                <Button variant="primary" size="sm" icon="bolt" loading={runningId === task.id} onClick={() => void run(task)}>立即运行</Button>
                {task.lastResult && <Button variant="ghost" size="sm" icon="eye" onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}>
                  {expandedId === task.id ? '收起结果' : '查看结果'}
                </Button>}
                <Button variant="ghost" size="sm" icon={task.enabled ? 'close' : 'check'} onClick={() => void toggle(task)}>
                  {task.enabled ? '暂停' : '启用'}
                </Button>
                <span className="grow" />
                <IconButton icon="edit" title="编辑任务" onClick={() => openEdit(task)} />
                <IconButton icon="trash" title="删除任务" onClick={() => void remove(task)} />
              </div>
            </div>
          ))}
        </div>
      ) : !tasks.loading && (
        <div className="card"><EmptyState icon="bolt" title="还没有自动化任务" hint="创建一个任务，例如每日摘要未读邮件或每周生成周报初稿。"
          action={<Button size="sm" icon="plus" onClick={openCreate}>新建任务</Button>} /></div>
      )}

      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={editingId ? '编辑自动化任务' : '新建自动化任务'}
        subtitle="任务动作会真实调用对应模块，结果写入运行记录" width={620}
        footer={<><Button variant="ghost" onClick={() => setFormOpen(false)}>取消</Button><Button icon="save" loading={busy} onClick={() => void save()}>保存</Button></>}>
        <Field label="任务名称"><input className="input" value={form.name} placeholder="例如：每日邮件摘要" onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
        <Field label="任务描述"><textarea className="textarea" value={form.description} placeholder="说明这个任务要解决什么" onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
        <div className="form-grid">
          <Field label="触发方式"><select className="select" value={form.triggerType} onChange={(event) => setForm({ ...form, triggerType: event.target.value as TaskForm['triggerType'] })}>
            <option value="manual">手动触发</option><option value="interval">定时执行</option></select></Field>
          <Field label="执行间隔（分钟）" hint="仅定时执行时生效"><input className="input" type="number" min={1} max={10080} value={form.intervalMinutes}
            disabled={form.triggerType !== 'interval'} onChange={(event) => setForm({ ...form, intervalMinutes: Number(event.target.value) })} /></Field>
          <div className="full"><Field label="执行动作" hint={actions.data?.find((item) => item.value === form.action)?.description}>
            <select className="select" value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value })}>
              {actions.data?.map((item) => <option key={item.value} value={item.value}>{item.label} · {item.module}</option>)}
            </select></Field></div>
        </div>
        <label className="row text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> 创建后立即启用</label>
      </Modal>
    </div>
  );
}
