import { all, get, run } from '../../shared/database.ts';

export interface PaperRow {
  id: string;
  user_id: string;
  title: string;
  authors: string;
  year: number | null;
  venue: string;
  doi: string;
  url: string;
  abstract: string;
  tags: string;
  status: string;
  rating: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface PaperInput {
  id: string;
  userId: string;
  title: string;
  authors: string;
  year: number | null;
  venue: string;
  doi: string;
  url: string;
  abstract: string;
  tags: string[];
  status: string;
  rating: number;
  notes: string;
  createdAt: string;
}

export const papersRepository = {
  where(filters: { q?: string; status?: string; tag?: string }): { clause: string; params: unknown[] } {
    const conditions = ['user_id = ?'];
    const params: unknown[] = [];
    if (filters.q) {
      conditions.push('(title LIKE ? OR authors LIKE ? OR abstract LIKE ? OR venue LIKE ?)');
      const pattern = `%${filters.q}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
    if (filters.tag) { conditions.push('tags LIKE ?'); params.push(`%${filters.tag}%`); }
    return { clause: conditions.join(' AND '), params };
  },

  /** 全量读取：仅给统计 / 导出 / AI 用，不要接到列表接口上。 */
  all(userId: string, filters: { q?: string; status?: string; tag?: string } = {}): PaperRow[] {
    const { clause, params } = this.where(filters);
    return all<PaperRow>(`SELECT * FROM papers WHERE ${clause} ORDER BY year DESC, created_at DESC, rowid DESC`, userId, ...params);
  },

  page(userId: string, filters: { q?: string; status?: string; tag?: string }, page: { limit: number; offset: number }): PaperRow[] {
    const { clause, params } = this.where(filters);
    return all<PaperRow>(
      `SELECT * FROM papers WHERE ${clause} ORDER BY year DESC, created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      userId, ...params, page.limit, page.offset,
    );
  },

  count(userId: string, filters: { q?: string; status?: string; tag?: string } = {}): number {
    const { clause, params } = this.where(filters);
    return get<{ count: number }>(`SELECT COUNT(*) AS count FROM papers WHERE ${clause}`, userId, ...params)?.count ?? 0;
  },

  find(userId: string, id: string): PaperRow | undefined {
    return get<PaperRow>('SELECT * FROM papers WHERE id = ? AND user_id = ?', id, userId);
  },

  countByTitle(userId: string, title: string): number {
    return get<{ count: number }>('SELECT COUNT(*) AS count FROM papers WHERE user_id = ? AND title = ?', userId, title)?.count ?? 0;
  },

  create(paper: PaperInput): void {
    run(
      `INSERT INTO papers (id, user_id, title, authors, year, venue, doi, url, abstract, tags, status, rating, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      paper.id, paper.userId, paper.title, paper.authors, paper.year, paper.venue, paper.doi, paper.url,
      paper.abstract, JSON.stringify(paper.tags), paper.status, paper.rating, paper.notes,
      paper.createdAt, paper.createdAt,
    );
  },

  update(userId: string, id: string, patch: Partial<Omit<PaperInput, 'id' | 'userId' | 'createdAt'>> & { tagsJson?: string }): void {
    const current = this.find(userId, id);
    if (!current) return;
    run(
      `UPDATE papers SET title = ?, authors = ?, year = ?, venue = ?, doi = ?, url = ?, abstract = ?, tags = ?,
       status = ?, rating = ?, notes = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      patch.title ?? current.title,
      patch.authors ?? current.authors,
      patch.year === undefined ? current.year : patch.year,
      patch.venue ?? current.venue,
      patch.doi ?? current.doi,
      patch.url ?? current.url,
      patch.abstract ?? current.abstract,
      patch.tagsJson ?? current.tags,
      patch.status ?? current.status,
      patch.rating ?? current.rating,
      patch.notes ?? current.notes,
      new Date().toISOString(), id, userId,
    );
  },

  remove(userId: string, id: string): void {
    run('DELETE FROM papers WHERE id = ? AND user_id = ?', id, userId);
  },
};
