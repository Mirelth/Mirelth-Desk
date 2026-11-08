import { all, get, run } from '../../shared/database.ts';

export interface DatasetRow {
  id: string;
  user_id: string;
  name: string;
  filename: string;
  columns: string;
  rows: string;
  row_count: number;
  created_at: string;
}

export const analyticsRepository = {
  list(userId: string, page: { limit: number; offset: number } = { limit: 100, offset: 0 }): DatasetRow[] {
    return all<DatasetRow>(
      'SELECT * FROM datasets WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
      userId, page.limit, page.offset,
    );
  },

  count(userId: string): number {
    return get<{ count: number }>('SELECT COUNT(*) AS count FROM datasets WHERE user_id = ?', userId)?.count ?? 0;
  },

  find(userId: string, id: string): DatasetRow | undefined {
    return get<DatasetRow>('SELECT * FROM datasets WHERE id = ? AND user_id = ?', id, userId);
  },

  create(dataset: { id: string; userId: string; name: string; filename: string; columns: unknown; rows: unknown; createdAt: string }): void {
    run(
      'INSERT INTO datasets (id, user_id, name, filename, columns, rows, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      dataset.id, dataset.userId, dataset.name, dataset.filename,
      JSON.stringify(dataset.columns), JSON.stringify(dataset.rows),
      Array.isArray(dataset.rows) ? dataset.rows.length : 0, dataset.createdAt,
    );
  },

  remove(userId: string, id: string): void {
    run('DELETE FROM datasets WHERE id = ? AND user_id = ?', id, userId);
  },
};
