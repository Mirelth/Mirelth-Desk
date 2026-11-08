import { all, get, run } from '../../shared/database.ts';
import { newId, now } from '../../shared/crypto.ts';

export interface AutomationRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  trigger_type: string;
  interval_minutes: number;
  module: string;
  action: string;
  enabled: number;
  workspace_id: string | null;
  event_key: string;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  last_status: string;
  last_result: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectorRow {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  base_url: string;
  description: string;
  token_encrypted: string;
  status: string;
  enabled: number;
  last_checked_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export type AutomationInput = Omit<AutomationRow, 'id' | 'user_id' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at' | 'run_count' | 'last_status' | 'last_result'>;

export const workspaceRepository = {
  tasks(userId: string): AutomationRow[] {
    return all<AutomationRow>('SELECT * FROM automation_tasks WHERE user_id = ? ORDER BY created_at DESC, rowid DESC', userId);
  },

  task(userId: string, id: string): AutomationRow | undefined {
    return get<AutomationRow>('SELECT * FROM automation_tasks WHERE id = ? AND user_id = ?', id, userId);
  },

  dueTasks(isoNow: string): AutomationRow[] {
    return all<AutomationRow>(
      'SELECT * FROM automation_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 20',
      isoNow,
    );
  },

  createTask(userId: string, input: AutomationInput): string {
    const id = newId('atm');
    const ts = now();
    const nextRun = input.trigger_type === 'interval' && input.interval_minutes > 0
      ? new Date(Date.now() + input.interval_minutes * 60_000).toISOString() : null;
    run(
      `INSERT INTO automation_tasks (id, user_id, name, description, trigger_type, interval_minutes, module, action,
       enabled, workspace_id, event_key, last_run_at, next_run_at, run_count, last_status, last_result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'idle', '', ?, ?)`,
      id, userId, input.name, input.description, input.trigger_type, input.interval_minutes,
      input.module, input.action, input.enabled, input.workspace_id, input.event_key, null, nextRun, ts, ts,
    );
    return id;
  },

  updateTask(userId: string, id: string, patch: Partial<AutomationInput> & { nextRunAt?: string | null }): void {
    const current = this.task(userId, id);
    if (!current) return;
    run(
      `UPDATE automation_tasks SET name = ?, description = ?, trigger_type = ?, interval_minutes = ?, module = ?,
       action = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      patch.name ?? current.name,
      patch.description ?? current.description,
      patch.trigger_type ?? current.trigger_type,
      patch.interval_minutes ?? current.interval_minutes,
      patch.module ?? current.module,
      patch.action ?? current.action,
      patch.enabled ?? current.enabled,
      patch.nextRunAt === undefined ? current.next_run_at : patch.nextRunAt,
      now(), id, userId,
    );
  },

  recordRun(id: string, status: string, result: string, nextRunAt: string | null): void {
    run(
      `UPDATE automation_tasks SET last_run_at = ?, last_status = ?, last_result = ?, next_run_at = ?,
       run_count = run_count + 1, updated_at = ? WHERE id = ?`,
      now(), status, result.slice(0, 4000), nextRunAt, now(), id,
    );
  },

  deleteTask(userId: string, id: string): void {
    run('DELETE FROM automation_tasks WHERE id = ? AND user_id = ?', id, userId);
  },

  connectors(userId: string): ConnectorRow[] {
    return all<ConnectorRow>('SELECT * FROM connectors WHERE user_id = ? ORDER BY created_at DESC, rowid DESC', userId);
  },

  connector(userId: string, id: string): ConnectorRow | undefined {
    return get<ConnectorRow>('SELECT * FROM connectors WHERE id = ? AND user_id = ?', id, userId);
  },

  createConnector(userId: string, input: { name: string; kind: string; baseUrl: string; description: string; tokenEncrypted: string; enabled: number }): string {
    const id = newId('con');
    const ts = now();
    run(
      `INSERT INTO connectors (id, user_id, name, kind, base_url, description, token_encrypted, status,
       enabled, last_checked_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'disconnected', ?, NULL, '', ?, ?)`,
      id, userId, input.name, input.kind, input.baseUrl, input.description, input.tokenEncrypted, input.enabled, ts, ts,
    );
    return id;
  },

  updateConnector(userId: string, id: string, patch: Partial<Pick<ConnectorRow, 'name' | 'kind' | 'base_url' | 'description' | 'token_encrypted' | 'enabled' | 'status' | 'last_checked_at' | 'last_error'>>): void {
    const current = this.connector(userId, id);
    if (!current) return;
    run(
      `UPDATE connectors SET name = ?, kind = ?, base_url = ?, description = ?, token_encrypted = ?, enabled = ?,
       status = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      patch.name ?? current.name,
      patch.kind ?? current.kind,
      patch.base_url ?? current.base_url,
      patch.description ?? current.description,
      patch.token_encrypted ?? current.token_encrypted,
      patch.enabled ?? current.enabled,
      patch.status ?? current.status,
      patch.last_checked_at === undefined ? current.last_checked_at : patch.last_checked_at,
      patch.last_error ?? current.last_error,
      now(), id, userId,
    );
  },

  deleteConnector(userId: string, id: string): void {
    run('DELETE FROM connectors WHERE id = ? AND user_id = ?', id, userId);
  },
};
