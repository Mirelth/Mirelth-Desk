import { useEffect, useState } from 'react';
import { apiClient, getErrorMessage, streamTask } from '../lib/api.ts';
import { useLoad, useStream } from '../lib/hooks.ts';
import type { ExperimentDto, ResearchOverview, TaskKind, TaskDto } from '../lib/types.ts';
import {
  AiOutput, Badge, Button, EmptyState, ErrorBanner, Field, Icon, IconButton, Modal, SectionTitle,
  Skeleton, formatDate, useToast,
} from '../lib/ui.tsx';

interface ProjectForm { name: string; description: string; objective: string; status: string }
interface ExperimentForm {
  title: string; projectId: string; hypothesis: string; method: string; result: string;
  conclusion: string; status: string; metrics: string;
}
interface TaskForm { title: string; projectId: string; status: string; priority: string; dueDate: string }

const EMPTY_PROJECT: ProjectForm = { name: '', description: '', objective: '', status: 'active' };
const EMPTY_EXPERIMENT: ExperimentForm = {
  title: '', projectId: '', hypothesis: '', method: '', result: '', conclusion: '', status: 'planned', metrics: '',
};
const EMPTY_TASK: TaskForm = { title: '', projectId: '', status: 'todo', priority: 'medium', dueDate: '' };

const EXP_STATUS: Record<string, { label: string; tone: 'neutral' | 'blue' | 'green' | 'rose' }> = {
  planned: { label: '已规划', tone: 'neutral' }, running: { label: '进行中', tone: 'blue' },
  completed: { label: '已完成', tone: 'green' }, abandoned: { label: '已中止', tone: 'rose' },
};
const KANBAN: Array<{ status: string; label: string }> = [
  { status: 'todo', label: '待办' }, { status: 'doing', label: '进行中' }, { status: 'done', label: '已完成' },
];

function parseMetrics(text: string): Array<{ name: string; value: number }> {
  return text.split(/[,，\n]/).map((part) => {
    const [name, raw] = part.split(/[=:：]/);
    const value = Number(raw);
    return { name: (name ?? '').trim(), value: Number.isFinite(value) ? value : 0 };
  }).filter((item) => item.name);
}

export function Research({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const overview = useLoad<ResearchOverview>(() => apiClient.get<ResearchOverview>('/api/research/overview'));
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectForm, setProjectForm] = useState<ProjectForm>(EMPTY_PROJECT);
  const [experimentOpen, setExperimentOpen] = useState(false);
  const [editingExperiment, setEditingExperiment] = useState<string | null>(null);
  const [experimentForm, setExperimentForm] = useState<ExperimentForm>(EMPTY_EXPERIMENT);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskForm, setTaskForm] = useState<TaskForm>(EMPTY_TASK);
  const [busy, setBusy] = useState(false);
  const [aiLabel, setAiLabel] = useState('');
  const stream = useStream();

  useEffect(() => {
    if (!overview.data?.projects.length) return;
    if (!selectedProject || !overview.data.projects.some((item) => item.id === selectedProject)) {
      setSelectedProject(overview.data.projects[0].id);
    }
  }, [overview.data, selectedProject]);

  const projects = overview.data?.projects ?? [];
  const experiments = (overview.data?.experiments ?? []).filter((item) => !selectedProject || item.projectId === selectedProject);
  const tasks = (overview.data?.tasks ?? []).filter((item) => !selectedProject || item.projectId === selectedProject);
  const project = projects.find((item) => item.id === selectedProject);

  const submitProject = async () => {
    if (!projectForm.name.trim()) { toast('请填写项目名称', 'error'); return; }
    setBusy(true);
    try {
      await apiClient.post('/api/research/projects', projectForm);
      setProjectOpen(false); setProjectForm(EMPTY_PROJECT);
      await overview.reload(); onChanged?.(); toast('研究项目已创建', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const openExperiment = (experiment?: ExperimentDto) => {
    if (experiment) {
      setEditingExperiment(experiment.id);
      setExperimentForm({
        title: experiment.title, projectId: experiment.projectId ?? selectedProject ?? '',
        hypothesis: experiment.hypothesis, method: experiment.method, result: experiment.result,
        conclusion: experiment.conclusion, status: experiment.status,
        metrics: experiment.metrics.map((item) => `${item.name}=${item.value}`).join('，'),
      });
    } else {
      setEditingExperiment(null);
      setExperimentForm({ ...EMPTY_EXPERIMENT, projectId: selectedProject ?? '' });
    }
    setExperimentOpen(true);
  };

  const submitExperiment = async () => {
    if (!experimentForm.title.trim()) { toast('请填写实验标题', 'error'); return; }
    setBusy(true);
    try {
      const body = {
        title: experimentForm.title, projectId: experimentForm.projectId || null,
        hypothesis: experimentForm.hypothesis, method: experimentForm.method,
        result: experimentForm.result, conclusion: experimentForm.conclusion,
        status: experimentForm.status, metrics: parseMetrics(experimentForm.metrics),
      };
      if (editingExperiment) await apiClient.patch(`/api/research/experiments/${editingExperiment}`, body);
      else await apiClient.post('/api/research/experiments', body);
      setExperimentOpen(false);
      await overview.reload(); onChanged?.();
      toast(editingExperiment ? '实验记录已更新' : '实验已创建', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const submitTask = async () => {
    if (!taskForm.title.trim()) { toast('请填写任务标题', 'error'); return; }
    setBusy(true);
    try {
      await apiClient.post('/api/research/tasks', {
        ...taskForm, projectId: taskForm.projectId || selectedProject || null, dueDate: taskForm.dueDate || null,
      });
      setTaskOpen(false); setTaskForm({ ...EMPTY_TASK, projectId: selectedProject ?? '' });
      await overview.reload(); onChanged?.(); toast('任务已添加', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const runAi = async (kind: TaskKind, label: string, experiment?: ExperimentDto) => {
    stream.reset(); setAiLabel(label); stream.setRunning(true);
    let full = '';
    const input = experiment ? {
      title: experiment.title, objective: project?.objective || experiment.hypothesis,
      hypothesis: experiment.hypothesis, method: experiment.method, result: experiment.result,
      conclusion: experiment.conclusion, metrics: experiment.metrics, project: project?.name ?? '',
    } : {
      title: project?.name ?? '研究计划', objective: project?.objective ?? '',
      description: project?.description ?? '', experiments, tasks,
    };
    try {
      await streamTask(kind, input, {
        onDelta: (chunk) => { full += chunk; stream.setText(full); },
        onMeta: (meta) => stream.setLabel(meta.label),
        onError: (message) => stream.setError(message),
      }, stream.signal);
    } catch (error) { stream.setError(getErrorMessage(error)); }
    finally { stream.setRunning(false); onChanged?.(); }
  };

  const moveTask = async (task: TaskDto, status: string) => {
    try {
      await apiClient.patch(`/api/research/tasks/${task.id}`, { status });
      await overview.reload(); onChanged?.();
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const remove = async (kind: 'projects' | 'experiments' | 'tasks', id: string, name: string) => {
    if (!window.confirm(`确定删除「${name}」？`)) return;
    try {
      await apiClient.delete(`/api/research/${kind}/${id}`);
      if (kind === 'projects') setSelectedProject(null);
      await overview.reload(); onChanged?.(); toast('已删除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>科学研究</h1><p>管理研究项目、实验记录与任务看板，AI 辅助设计与结果解读</p></div>
        <div className="page-actions"><Button icon="plus" onClick={() => { setProjectForm(EMPTY_PROJECT); setProjectOpen(true); }}>新建项目</Button></div>
      </div>

      {overview.error && <ErrorBanner message={overview.error} onRetry={() => void overview.reload()} />}

      <div className="split-layout wide-list">
        <div className="card list-pane">
          <div className="card-head"><div><h3>研究项目</h3><div className="sub">{overview.data?.stats.activeProjects ?? 0} 个进行中</div></div>
            <Icon name="flask" size={16} className="muted" /></div>
          <div className="list-scroll">
            {overview.loading && !overview.data ? <div style={{ padding: 12 }}><Skeleton height={70} /></div> : null}
            {projects.length ? projects.map((item) => (
              <button type="button" key={item.id} className={`list-item ${selectedProject === item.id ? 'active' : ''}`}
                onClick={() => { setSelectedProject(item.id); stream.reset(); }}>
                <div className="list-title">{item.name}</div>
                <div className="list-excerpt">{item.objective || item.description || '暂无目标描述'}</div>
                <div className="list-meta"><span>{item.experimentCount} 个实验</span><span>{item.taskCount} 个任务</span>
                  <Badge tone={item.status === 'active' ? 'green' : 'neutral'}>{item.status === 'active' ? '进行中' : item.status}</Badge></div>
              </button>
            )) : !overview.loading && <EmptyState icon="flask" title="还没有研究项目" hint="先建立一个项目，再记录实验与任务。" />}
          </div>
          {project && <div className="card-pad" style={{ borderTop: '1px solid var(--line-soft)' }}>
            <div className="row"><Button variant="ghost" size="sm" icon="trash" onClick={() => void remove('projects', project.id, project.name)}>删除项目</Button></div>
          </div>}
        </div>

        <div className="detail-pane stack">
          <div className="card">
            <div className="toolbar">
              <div><strong style={{ fontSize: 15 }}>{project?.name ?? '全部项目'}</strong>
                <div className="text-xs muted mt-8">{overview.data?.stats.experiments ?? 0} 个实验 · {overview.data?.stats.openTasks ?? 0} 个未完成任务</div></div>
              <span className="grow" />
              <Button variant="soft" size="sm" icon="wand" disabled={!project || stream.running} onClick={() => void runAi('research.plan', '研究计划')}>研究计划</Button>
              <Button variant="outline" size="sm" icon="plus" onClick={() => openExperiment()}>新建实验</Button>
              <Button variant="outline" size="sm" icon="plus" onClick={() => { setTaskForm({ ...EMPTY_TASK, projectId: selectedProject ?? '' }); setTaskOpen(true); }}>新建任务</Button>
            </div>
            <div className="metric-grid">
              <div className="metric-tile"><div className="label">项目</div><div className="value">{overview.data?.stats.projects ?? 0}</div></div>
              <div className="metric-tile"><div className="label">实验</div><div className="value">{overview.data?.stats.experiments ?? 0}</div></div>
              <div className="metric-tile"><div className="label">已完成实验</div><div className="value">{overview.data?.stats.completed ?? 0}</div></div>
              <div className="metric-tile"><div className="label">未完成任务</div><div className="value">{overview.data?.stats.openTasks ?? 0}</div></div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>实验记录</h3><div className="sub">假设 → 方法 → 结果 → 结论，形成可复现的闭环</div></div></div>
            <div className="card-pad">
              {experiments.length ? experiments.map((experiment) => (
                <div className="experiment-card" key={experiment.id}>
                  <div className="between">
                    <div><h4>{experiment.title}</h4><div className="text-xs muted mt-8">更新于 {formatDate(experiment.updatedAt)}</div></div>
                    <div className="row">
                      <Badge tone={EXP_STATUS[experiment.status]?.tone ?? 'neutral'}>{EXP_STATUS[experiment.status]?.label ?? experiment.status}</Badge>
                      <IconButton icon="edit" title="编辑实验" onClick={() => openExperiment(experiment)} />
                      <IconButton icon="trash" title="删除实验" onClick={() => void remove('experiments', experiment.id, experiment.title)} />
                    </div>
                  </div>
                  <div className="exp-grid">
                    <div className="exp-block"><div className="label">研究假设</div><p>{experiment.hypothesis || '待补充'}</p></div>
                    <div className="exp-block"><div className="label">方法</div><p>{experiment.method || '待补充'}</p></div>
                    <div className="exp-block"><div className="label">结果</div><p>{experiment.result || '待补充'}</p></div>
                    <div className="exp-block"><div className="label">结论</div><p>{experiment.conclusion || '待补充'}</p></div>
                  </div>
                  {experiment.metrics.length > 0 && <div className="chip-row mt-12">
                    {experiment.metrics.map((metric) => <span className="chip" key={metric.name}>{metric.name} · {metric.value}</span>)}
                  </div>}
                  <div className="row wrap mt-12">
                    <Button variant="soft" size="sm" icon="wand" disabled={stream.running} onClick={() => void runAi('research.design', `实验设计 · ${experiment.title}`, experiment)}>AI 实验设计</Button>
                    <Button variant="soft" size="sm" icon="chart" disabled={stream.running} onClick={() => void runAi('research.interpret', `结果解读 · ${experiment.title}`, experiment)}>AI 结果解读</Button>
                  </div>
                </div>
              )) : <EmptyState icon="flask" title="还没有实验记录" hint="新建一条实验，记录假设与方法。" action={<Button size="sm" icon="plus" onClick={() => openExperiment()}>新建实验</Button>} />}
            </div>
          </div>

          <div className="card ai-panel" style={{ borderRadius: 16 }}>
            <AiOutput text={stream.text} running={stream.running} error={stream.error}
              label={`${aiLabel || '科研智能体'}${stream.label ? ` · ${stream.label}` : ''}`}
              onCopy={() => { void navigator.clipboard.writeText(stream.text).then(() => toast('已复制', 'success')); }} />
          </div>

          <div>
            <SectionTitle title="任务看板" hint="点击箭头推进任务状态" />
            <div className="kanban">
              {KANBAN.map((column) => {
                const columnTasks = tasks.filter((task) => task.status === column.status);
                return (
                  <div className="kanban-col" key={column.status}>
                    <div className="kanban-head"><span>{column.label}</span><span className="count-pill">{columnTasks.length}</span></div>
                    {columnTasks.map((task) => (
                      <div className="kanban-card" key={task.id}>
                        <div className="title">{task.title}</div>
                        <div className="foot">
                          <span className="text-xs muted">{task.dueDate ?? '无截止日期'}</span>
                          <div className="row">
                            {column.status !== 'done' && <IconButton icon="arrow" title="推进状态" onClick={() => void moveTask(task, column.status === 'todo' ? 'doing' : 'done')} />}
                            <IconButton icon="trash" title="删除任务" onClick={() => void remove('tasks', task.id, task.title)} />
                          </div>
                        </div>
                      </div>
                    ))}
                    {!columnTasks.length && <div className="text-xs subtle" style={{ padding: 8 }}>暂无任务</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <Modal open={projectOpen} onClose={() => setProjectOpen(false)} title="新建研究项目" subtitle="用一个清晰的目标把实验与任务串起来"
        footer={<><Button variant="ghost" onClick={() => setProjectOpen(false)}>取消</Button><Button icon="check" loading={busy} onClick={() => void submitProject()}>创建</Button></>}>
        <Field label="项目名称"><input className="input" value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })} /></Field>
        <Field label="研究目标" hint="一句话说明要验证什么"><textarea className="textarea" value={projectForm.objective} onChange={(event) => setProjectForm({ ...projectForm, objective: event.target.value })} /></Field>
        <Field label="项目描述"><textarea className="textarea" value={projectForm.description} onChange={(event) => setProjectForm({ ...projectForm, description: event.target.value })} /></Field>
      </Modal>

      <Modal open={experimentOpen} onClose={() => setExperimentOpen(false)} title={editingExperiment ? '编辑实验记录' : '新建实验'} width={720}
        footer={<><Button variant="ghost" onClick={() => setExperimentOpen(false)}>取消</Button><Button icon="save" loading={busy} onClick={() => void submitExperiment()}>保存</Button></>}>
        <div className="form-grid">
          <Field label="实验标题"><input className="input" value={experimentForm.title} onChange={(event) => setExperimentForm({ ...experimentForm, title: event.target.value })} /></Field>
          <Field label="所属项目"><select className="select" value={experimentForm.projectId} onChange={(event) => setExperimentForm({ ...experimentForm, projectId: event.target.value })}>
            <option value="">不关联项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <div className="full"><Field label="研究假设"><textarea className="textarea" value={experimentForm.hypothesis} onChange={(event) => setExperimentForm({ ...experimentForm, hypothesis: event.target.value })} /></Field></div>
          <div className="full"><Field label="方法"><textarea className="textarea" value={experimentForm.method} onChange={(event) => setExperimentForm({ ...experimentForm, method: event.target.value })} /></Field></div>
          <div className="full"><Field label="结果"><textarea className="textarea" value={experimentForm.result} onChange={(event) => setExperimentForm({ ...experimentForm, result: event.target.value })} /></Field></div>
          <div className="full"><Field label="结论"><textarea className="textarea" value={experimentForm.conclusion} onChange={(event) => setExperimentForm({ ...experimentForm, conclusion: event.target.value })} /></Field></div>
          <Field label="状态"><select className="select" value={experimentForm.status} onChange={(event) => setExperimentForm({ ...experimentForm, status: event.target.value })}>
            <option value="planned">已规划</option><option value="running">进行中</option><option value="completed">已完成</option><option value="abandoned">已中止</option></select></Field>
          <Field label="指标" hint="格式：完整性=4.4，耗时=12"><input className="input" value={experimentForm.metrics} onChange={(event) => setExperimentForm({ ...experimentForm, metrics: event.target.value })} /></Field>
        </div>
      </Modal>

      <Modal open={taskOpen} onClose={() => setTaskOpen(false)} title="新建任务"
        footer={<><Button variant="ghost" onClick={() => setTaskOpen(false)}>取消</Button><Button icon="check" loading={busy} onClick={() => void submitTask()}>添加</Button></>}>
        <Field label="任务标题"><input className="input" value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} /></Field>
        <div className="form-grid">
          <Field label="状态"><select className="select" value={taskForm.status} onChange={(event) => setTaskForm({ ...taskForm, status: event.target.value })}>
            <option value="todo">待办</option><option value="doing">进行中</option><option value="done">已完成</option></select></Field>
          <Field label="优先级"><select className="select" value={taskForm.priority} onChange={(event) => setTaskForm({ ...taskForm, priority: event.target.value })}>
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></Field>
          <Field label="所属项目"><select className="select" value={taskForm.projectId} onChange={(event) => setTaskForm({ ...taskForm, projectId: event.target.value })}>
            <option value="">不关联项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="截止日期"><input className="input" type="date" value={taskForm.dueDate} onChange={(event) => setTaskForm({ ...taskForm, dueDate: event.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}
