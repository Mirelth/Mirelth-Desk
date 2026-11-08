import { all, get, run } from '../../shared/database.ts';
import { newId, now } from '../../shared/crypto.ts';

export interface ProjectRow {
  id: string; user_id: string; name: string; description: string; objective: string;
  status: string; created_at: string; updated_at: string;
}
export interface ExperimentRow {
  id: string; user_id: string; project_id: string | null; title: string; hypothesis: string;
  method: string; result: string; conclusion: string; status: string; metrics: string;
  created_at: string; updated_at: string;
}
export interface TaskRow {
  id: string; user_id: string; project_id: string | null; title: string;
  status: string; priority: string; due_date: string | null; created_at: string;
}

export const researchRepository = {
  projects(userId: string): ProjectRow[] {
    return all<ProjectRow>('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC', userId);
  },
  project(userId: string, id: string): ProjectRow | undefined {
    return get<ProjectRow>('SELECT * FROM projects WHERE id = ? AND user_id = ?', id, userId);
  },
  createProject(userId: string, input: { name: string; description: string; objective: string; status: string }): string {
    const id = newId('prj');
    run(
      'INSERT INTO projects (id, user_id, name, description, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, userId, input.name, input.description, input.objective, input.status, now(), now(),
    );
    return id;
  },
  updateProject(userId: string, id: string, patch: Partial<Pick<ProjectRow, 'name' | 'description' | 'objective' | 'status'>>): void {
    const current = this.project(userId, id);
    if (!current) return;
    run('UPDATE projects SET name = ?, description = ?, objective = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      patch.name ?? current.name, patch.description ?? current.description, patch.objective ?? current.objective,
      patch.status ?? current.status, now(), id, userId);
  },
  deleteProject(userId: string, id: string): void {
    run('DELETE FROM projects WHERE id = ? AND user_id = ?', id, userId);
  },

  experiments(userId: string, projectId?: string): ExperimentRow[] {
    return projectId
      ? all<ExperimentRow>('SELECT * FROM experiments WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC', userId, projectId)
      : all<ExperimentRow>('SELECT * FROM experiments WHERE user_id = ? ORDER BY created_at DESC', userId);
  },
  experiment(userId: string, id: string): ExperimentRow | undefined {
    return get<ExperimentRow>('SELECT * FROM experiments WHERE id = ? AND user_id = ?', id, userId);
  },
  createExperiment(userId: string, input: Omit<ExperimentRow, 'id' | 'user_id' | 'created_at' | 'updated_at'>): string {
    const id = newId('exp');
    run(
      `INSERT INTO experiments (id, user_id, project_id, title, hypothesis, method, result, conclusion, status, metrics, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, userId, input.project_id, input.title, input.hypothesis, input.method, input.result,
      input.conclusion, input.status, input.metrics, now(), now(),
    );
    return id;
  },
  updateExperiment(userId: string, id: string, patch: Partial<Pick<ExperimentRow, 'title' | 'hypothesis' | 'method' | 'result' | 'conclusion' | 'status' | 'metrics' | 'project_id'>>): void {
    const current = this.experiment(userId, id);
    if (!current) return;
    run(
      `UPDATE experiments SET project_id = ?, title = ?, hypothesis = ?, method = ?, result = ?, conclusion = ?, status = ?, metrics = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      patch.project_id === undefined ? current.project_id : patch.project_id,
      patch.title ?? current.title, patch.hypothesis ?? current.hypothesis, patch.method ?? current.method,
      patch.result ?? current.result, patch.conclusion ?? current.conclusion, patch.status ?? current.status,
      patch.metrics ?? current.metrics, now(), id, userId,
    );
  },
  deleteExperiment(userId: string, id: string): void {
    run('DELETE FROM experiments WHERE id = ? AND user_id = ?', id, userId);
  },

  tasks(userId: string): TaskRow[] {
    return all<TaskRow>("SELECT * FROM tasks WHERE user_id = ? ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, created_at DESC", userId);
  },
  createTask(userId: string, input: { title: string; projectId: string | null; status: string; priority: string; dueDate: string | null }): string {
    const id = newId('tsk');
    run('INSERT INTO tasks (id, user_id, project_id, title, status, priority, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, userId, input.projectId, input.title, input.status, input.priority, input.dueDate, now());
    return id;
  },
  updateTask(userId: string, id: string, patch: Partial<Pick<TaskRow, 'title' | 'status' | 'priority' | 'due_date'>>): void {
    const current = get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND user_id = ?', id, userId);
    if (!current) return;
    run('UPDATE tasks SET title = ?, status = ?, priority = ?, due_date = ? WHERE id = ? AND user_id = ?',
      patch.title ?? current.title, patch.status ?? current.status, patch.priority ?? current.priority,
      patch.due_date === undefined ? current.due_date : patch.due_date, id, userId);
  },
  deleteTask(userId: string, id: string): void {
    run('DELETE FROM tasks WHERE id = ? AND user_id = ?', id, userId);
  },
};
