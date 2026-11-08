import { generate } from '../../ai/provider.ts';
import { NotFoundError } from '../../shared/errors.ts';
import { activityService, type ActivityModule } from '../activity/activity.service.ts';
import { researchRepository, type ExperimentRow, type ProjectRow, type TaskRow } from './research.repository.ts';

function projectDto(row: ProjectRow, experiments: ExperimentRow[], tasks: TaskRow[]) {
  return {
    id: row.id, name: row.name, description: row.description, objective: row.objective,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    experimentCount: experiments.filter((item) => item.project_id === row.id).length,
    taskCount: tasks.filter((item) => item.project_id === row.id).length,
  };
}

function experimentDto(row: ExperimentRow) {
  return {
    id: row.id, projectId: row.project_id, title: row.title, hypothesis: row.hypothesis,
    method: row.method, result: row.result, conclusion: row.conclusion, status: row.status,
    metrics: JSON.parse(row.metrics) as Array<{ name: string; value: number }>,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function taskDto(row: TaskRow) {
  return {
    id: row.id, projectId: row.project_id, title: row.title, status: row.status,
    priority: row.priority, dueDate: row.due_date, createdAt: row.created_at,
  };
}

export const researchService = {
  overview(userId: string) {
    const projects = researchRepository.projects(userId);
    const experiments = researchRepository.experiments(userId);
    const tasks = researchRepository.tasks(userId);
    return {
      projects: projects.map((project) => projectDto(project, experiments, tasks)),
      experiments: experiments.map(experimentDto),
      tasks: tasks.map(taskDto),
      stats: {
        projects: projects.length,
        activeProjects: projects.filter((project) => project.status === 'active').length,
        experiments: experiments.length,
        completed: experiments.filter((experiment) => experiment.status === 'completed').length,
        openTasks: tasks.filter((task) => task.status !== 'done').length,
      },
    };
  },

  createProject(userId: string, input: { name: string; description?: string; objective?: string; status?: string }) {
    const id = researchRepository.createProject(userId, {
      name: input.name, description: input.description ?? '', objective: input.objective ?? '',
      status: input.status ?? 'active',
    });
    activityService.record(userId, 'research', 'create', `创建研究项目「${input.name}」`);
    return this.overview(userId).projects.find((project) => project.id === id);
  },
  updateProject(userId: string, id: string, input: { name?: string; description?: string; objective?: string; status?: string }) {
    if (!researchRepository.project(userId, id)) throw new NotFoundError('研究项目', id);
    researchRepository.updateProject(userId, id, input);
    return this.overview(userId).projects.find((project) => project.id === id);
  },
  deleteProject(userId: string, id: string): void {
    if (!researchRepository.project(userId, id)) throw new NotFoundError('研究项目', id);
    researchRepository.deleteProject(userId, id);
    activityService.record(userId, 'research', 'delete', `删除研究项目 ${id}`);
  },

  createExperiment(userId: string, input: {
    title: string; projectId?: string | null; hypothesis?: string; method?: string; result?: string;
    conclusion?: string; status?: string; metrics?: Array<{ name: string; value: number }>;
  }) {
    if (input.projectId && !researchRepository.project(userId, input.projectId)) throw new NotFoundError('研究项目', input.projectId);
    const id = researchRepository.createExperiment(userId, {
      project_id: input.projectId ?? null, title: input.title, hypothesis: input.hypothesis ?? '',
      method: input.method ?? '', result: input.result ?? '', conclusion: input.conclusion ?? '',
      status: input.status ?? 'planned', metrics: JSON.stringify(input.metrics ?? []),
    });
    activityService.record(userId, 'research', 'create', `新增实验「${input.title}」`);
    return this.overview(userId).experiments.find((experiment) => experiment.id === id);
  },
  updateExperiment(userId: string, id: string, input: Partial<{
    title: string; projectId: string | null; hypothesis: string; method: string; result: string;
    conclusion: string; status: string; metrics: Array<{ name: string; value: number }>;
  }>) {
    if (!researchRepository.experiment(userId, id)) throw new NotFoundError('实验', id);
    researchRepository.updateExperiment(userId, id, {
      title: input.title, project_id: input.projectId, hypothesis: input.hypothesis,
      method: input.method, result: input.result, conclusion: input.conclusion, status: input.status,
      metrics: input.metrics === undefined ? undefined : JSON.stringify(input.metrics),
    });
    activityService.record(userId, 'research', 'update', `更新实验 ${id}`);
    return this.overview(userId).experiments.find((experiment) => experiment.id === id);
  },
  deleteExperiment(userId: string, id: string): void {
    if (!researchRepository.experiment(userId, id)) throw new NotFoundError('实验', id);
    researchRepository.deleteExperiment(userId, id);
  },

  createTask(userId: string, input: { title: string; projectId?: string | null; status?: string; priority?: string; dueDate?: string | null }) {
    const id = researchRepository.createTask(userId, {
      title: input.title, projectId: input.projectId ?? null, status: input.status ?? 'todo',
      priority: input.priority ?? 'medium', dueDate: input.dueDate ?? null,
    });
    activityService.record(userId, 'research', 'create', `新增任务「${input.title}」`);
    return this.overview(userId).tasks.find((task) => task.id === id);
  },
  updateTask(userId: string, id: string, input: { title?: string; status?: string; priority?: string; dueDate?: string | null }) {
    researchRepository.updateTask(userId, id, {
      title: input.title, status: input.status, priority: input.priority, due_date: input.dueDate,
    });
    return this.overview(userId).tasks.find((task) => task.id === id);
  },
  deleteTask(userId: string, id: string): void {
    researchRepository.deleteTask(userId, id);
  },

  async ai(userId: string, experimentId: string, action: 'design' | 'interpret') {
    const overview = this.overview(userId);
    const experiment = overview.experiments.find((item) => item.id === experimentId);
    if (!experiment) throw new NotFoundError('实验', experimentId);
    const project = overview.projects.find((item) => item.id === experiment.projectId);
    const result = await generate(action === 'design' ? 'research.design' : 'research.interpret', {
      title: experiment.title,
      objective: project?.objective || experiment.hypothesis,
      hypothesis: experiment.hypothesis,
      method: experiment.method,
      result: experiment.result,
      conclusion: experiment.conclusion,
      metrics: experiment.metrics,
      project: project?.name ?? '',
    });
    activityService.record(userId as string, 'agent' as ActivityModule, 'research_ai', `为「${experiment.title}」生成${action === 'design' ? '实验设计' : '结果解读'}`);
    return result;
  },

  async plan(userId: string, projectId: string) {
    const overview = this.overview(userId);
    const project = overview.projects.find((item) => item.id === projectId);
    if (!project) throw new NotFoundError('研究项目', projectId);
    const result = await generate('research.plan', {
      title: project.name, objective: project.objective, description: project.description,
      experiments: overview.experiments.filter((item) => item.projectId === projectId),
      tasks: overview.tasks.filter((item) => item.projectId === projectId),
    });
    activityService.record(userId, 'agent', 'research_ai', `为「${project.name}」生成研究计划`);
    return result;
  },
};
