import { all, get, run } from '../../shared/database.ts';

export interface DocumentRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  kind: string;
  template: string | null;
  tags: string;
  word_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentInput {
  id: string;
  userId: string;
  title: string;
  content: string;
  kind: string;
  template: string | null;
  tags: string[];
  status: string;
  createdAt: string;
}

export const documentsRepository = {
  list(userId: string, search?: string): DocumentRow[] {
    if (search) {
      const pattern = `%${search}%`;
      return all<DocumentRow>(
        `SELECT * FROM documents WHERE user_id = ? AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
         ORDER BY updated_at DESC, rowid DESC LIMIT 200`,
        userId, pattern, pattern, pattern,
      );
    }
    return all<DocumentRow>('SELECT * FROM documents WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 200', userId);
  },

  find(userId: string, id: string): DocumentRow | undefined {
    return get<DocumentRow>('SELECT * FROM documents WHERE id = ? AND user_id = ?', id, userId);
  },

  create(input: DocumentInput): void {
    run(
      `INSERT INTO documents (id, user_id, title, content, kind, template, tags, word_count, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, input.userId, input.title, input.content, input.kind, input.template,
      JSON.stringify(input.tags), input.content.replace(/\s/g, '').length, input.status,
      input.createdAt, input.createdAt,
    );
  },

  update(userId: string, id: string, fields: Partial<Pick<DocumentRow, 'title' | 'content' | 'kind' | 'tags' | 'status' | 'word_count'>>): void {
    const current = this.find(userId, id);
    if (!current) return;
    run(
      `UPDATE documents SET title = ?, content = ?, kind = ?, tags = ?, status = ?, word_count = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      fields.title ?? current.title,
      fields.content ?? current.content,
      fields.kind ?? current.kind,
      fields.tags ?? current.tags,
      fields.status ?? current.status,
      fields.word_count ?? (fields.content ?? current.content).replace(/\s/g, '').length,
      new Date().toISOString(), id, userId,
    );
  },

  remove(userId: string, id: string): void {
    run('DELETE FROM documents WHERE id = ? AND user_id = ?', id, userId);
  },
};
