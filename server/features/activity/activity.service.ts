import { all, get, run } from '../../shared/database.ts';
import { newId, now } from '../../shared/crypto.ts';
import { config } from '../../shared/config.ts';

export type ActivityModule = 'document' | 'analytics' | 'paper' | 'research' | 'mail' | 'agent' | 'system';

export interface ActivityRow {
  id: string;
  user_id: string;
  module: string;
  action: string;
  description: string;
  created_at: string;
}

export const activityService = {
  record(userId: string, module: ActivityModule, action: string, description: string): void {
    run(
      'INSERT INTO activity (id, user_id, module, action, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId('act'), userId, module, action, description, now(),
    );
  },

  list(userId: string, limit = 12): ActivityRow[] {
    return all<ActivityRow>(
      'SELECT * FROM activity WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      userId, Math.min(Math.max(limit, 1), 100),
    );
  },

  stats(userId: string) {
    const count = (table: string, where = ''): number =>
      get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ? ${where}`, userId)?.count ?? 0;
    return {
      documents: count('documents'),
      datasets: count('datasets'),
      papers: count('papers'),
      projects: count('projects'),
      experiments: count('experiments'),
      tasks: count('tasks', "AND status != 'done'"),
      unreadMail: count('messages', "AND folder = 'inbox' AND is_read = 0"),
      totalMail: count('messages'),
      recent: this.list(userId, 8),
      ai: {
        mode: config.llm.enabled ? 'live' : 'offline',
        model: config.llm.enabled ? config.llm.model : '本地规则引擎',
        baseUrl: config.llm.enabled ? config.llm.baseUrl : '',
      },
    };
  },
};
