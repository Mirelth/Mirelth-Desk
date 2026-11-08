import { all, get, run } from '../../shared/database.ts';
import { newId, now } from '../../shared/crypto.ts';

const TABLES = [
  'workspaces', 'memberships', 'conversations', 'conversation_messages', 'memories',
  'agent_definitions', 'agent_runs', 'agent_run_steps', 'knowledge_chunks',
  'document_shares', 'comments', 'document_versions', 'files', 'automation_events',
  'audit_logs', 'model_usage', 'workflows',
] as const;

export type TableName = typeof TABLES[number];

function assertTable(table: TableName): void {
  if (!TABLES.includes(table)) throw new Error(`Unknown table: ${table}`);
}

export function insertRow(table: TableName, row: Record<string, unknown>): string {
  assertTable(table);
  const id = typeof row.id === 'string' ? row.id : newId(table.slice(0, 3));
  const data = { id, ...row, ...(Object.prototype.hasOwnProperty.call(row, 'created_at') ? {} : { created_at: now() }) };
  const keys = Object.keys(data);
  run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((key) => data[key]));
  return id;
}

export function rows<T>(table: TableName, where = '1 = 1', params: unknown[] = [], order?: string, limit?: number): T[] {
  assertTable(table);
  const sql = `SELECT * FROM ${table} WHERE ${where}${order ? ` ORDER BY ${order}` : ''}${limit ? ` LIMIT ${limit}` : ''}`;
  return all<T>(sql, ...params);
}

export function row<T>(table: TableName, where: string, params: unknown[] = []): T | undefined {
  return rows<T>(table, where, params, undefined, 1)[0];
}

export function updateRows(table: TableName, patch: Record<string, unknown>, where: string, params: unknown[]): void {
  assertTable(table);
  const keys = Object.keys(patch);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE ${where}`, ...keys.map((key) => patch[key]), ...params);
}

export function deleteRows(table: TableName, where: string, params: unknown[]): void {
  assertTable(table);
  run(`DELETE FROM ${table} WHERE ${where}`, ...params);
}

export function count(table: TableName, where = '1 = 1', params: unknown[] = []): number {
  assertTable(table);
  return get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, ...params)?.c ?? 0;
}

export function defaultWorkspace(userId: string): { id: string; name: string; role: string } {
  const existing = row<{ workspace_id: string; role: string }>('memberships', 'user_id = ?', [userId]);
  if (existing) {
    const workspace = row<{ id: string; name: string }>('workspaces', 'id = ?', [existing.workspace_id]);
    if (workspace) return { id: workspace.id, name: workspace.name, role: existing.role };
  }
  const id = newId('wsp');
  run('INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)', id, '默认工作区', userId, now());
  run('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', id, userId, 'owner', now());
  return { id, name: '默认工作区', role: 'owner' };
}

export function roleOf(workspaceId: string, userId: string): string | null {
  return row<{ role: string }>('memberships', 'workspace_id = ? AND user_id = ?', [workspaceId, userId])?.role ?? null;
}

export const ROLE_LEVEL: Record<string, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export function requireRole(workspaceId: string, userId: string, minimum: string): void {
  const role = roleOf(workspaceId, userId);
  if (!role || (ROLE_LEVEL[role] ?? 0) < (ROLE_LEVEL[minimum] ?? 99)) {
    const error = new Error('当前工作区权限不足');
    (error as Error & { status?: number }).status = 403;
    throw error;
  }
}

export function audit(workspaceId: string, userId: string, action: string, resource = '', detail = ''): void {
  insertRow('audit_logs', { workspace_id: workspaceId, user_id: userId, action, resource, detail });
}
