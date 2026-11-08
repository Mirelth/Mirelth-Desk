import { all, run } from '../../shared/database.ts';
import { insertRow, rows, deleteRows, count } from './store.ts';

export interface Chunk {
  id: string; workspace_id: string; source_type: string; source_id: string;
  title: string; content: string; embedding: string; created_at: string;
}

export function tokenize(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  for (const part of parts) {
    if (/^[\u4e00-\u9fff]+$/.test(part)) {
      if (part.length === 1) tokens.push(part);
      else for (let index = 0; index < part.length - 1; index += 1) tokens.push(part.slice(index, index + 2));
    } else tokens.push(part);
  }
  return [...new Set(tokens)].slice(0, 240);
}

export function vectorize(text: string): Record<string, number> {
  const tokens = tokenize(text);
  const vector: Record<string, number> = {};
  for (const token of tokens) vector[token] = (vector[token] ?? 0) + 1;
  const norm = Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0)) || 1;
  for (const key of Object.keys(vector)) vector[key] = Number((vector[key] / norm).toFixed(5));
  return vector;
}

export function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  for (const [key, value] of Object.entries(a)) dot += value * (b[key] ?? 0);
  return Number(dot.toFixed(4));
}

export function indexChunk(workspaceId: string, sourceType: string, sourceId: string, title: string, content: string): void {
  const previous = rows<Chunk>('knowledge_chunks', 'workspace_id = ? AND source_type = ? AND source_id = ?', [workspaceId, sourceType, sourceId]);
  for (const item of previous) run('DELETE FROM knowledge_fts WHERE chunk_id = ?', item.id);
  deleteRows('knowledge_chunks', 'workspace_id = ? AND source_type = ? AND source_id = ?', [workspaceId, sourceType, sourceId]);
  const body = content.slice(0, 6000);
  const id = insertRow('knowledge_chunks', {
    workspace_id: workspaceId, source_type: sourceType, source_id: sourceId,
    title: title.slice(0, 300), content: body, embedding: JSON.stringify(vectorize(`${title} ${body}`)),
  });
  run('INSERT INTO knowledge_fts (chunk_id, title, content) VALUES (?, ?, ?)', id, tokenize(title).join(' '), tokenize(body).join(' '));
}

export interface SearchHit { id: string; title: string; content: string; sourceType: string; sourceId: string; score: number }

export function search(workspaceId: string, query: string, limit = 5): SearchHit[] {
  const terms = tokenize(query).slice(0, 12);
  const queryVector = vectorize(query);
  const candidates = new Map<string, Chunk>();
  const like = terms.slice(0, 4).map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
  if (like) {
    const params: unknown[] = [workspaceId];
    for (const term of terms.slice(0, 4)) params.push(`%${term}%`, `%${term}%`);
    for (const item of rows<Chunk>('knowledge_chunks', `workspace_id = ? AND (${like})`, params, undefined, 60)) candidates.set(item.id, item);
  }
  if (terms.length) {
    const match = terms.map((term) => `"${term.replace(/"/g, '')}"`).join(' OR ');
    try {
      const ftsIds = all<{ chunk_id: string }>('SELECT chunk_id FROM knowledge_fts WHERE knowledge_fts MATCH ? LIMIT 60', match);
      for (const entry of ftsIds) {
        const found = rows<Chunk>('knowledge_chunks', 'id = ? AND workspace_id = ?', [entry.chunk_id, workspaceId], undefined, 1)[0];
        if (found) candidates.set(found.id, found);
      }
    } catch { /* FTS 语法不合法时退回 LIKE 召回 */ }
  }
  return [...candidates.values()]
    .map((chunk) => ({
      id: chunk.id, title: chunk.title, content: chunk.content,
      sourceType: chunk.source_type, sourceId: chunk.source_id,
      score: cosine(queryVector, JSON.parse(chunk.embedding) as Record<string, number>),
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function contextFor(workspaceId: string, query: string): string {
  const hits = search(workspaceId, query, 4);
  if (!hits.length) return '';
  return `以下是从本机知识库检索到的相关材料（请优先引用，不要编造）：\n${hits.map((hit, index) => `[${index + 1}] ${hit.title}（${hit.sourceType}）\n${hit.content.slice(0, 600)}`).join('\n\n')}`;
}

export function reindex(workspaceId: string, userId: string): number {
  const add = (type: string, id: string, title: string, content: string) => {
    if (content.trim()) indexChunk(workspaceId, type, id, title, content);
  };
  for (const doc of all<{ id: string; title: string; content: string }>('SELECT id, title, content FROM documents WHERE user_id = ?', userId)) {
    add('document', doc.id, doc.title, doc.content);
  }
  for (const paper of all<{ id: string; title: string; abstract: string; authors: string; year: number | null }>('SELECT id, title, abstract, authors, year FROM papers WHERE user_id = ?', userId)) {
    add('paper', paper.id, paper.title, `${paper.authors} ${paper.year ?? ''}\n${paper.abstract}`);
  }
  for (const dataset of all<{ id: string; name: string; columns: string; rows: string }>('SELECT id, name, columns, rows FROM datasets WHERE user_id = ?', userId)) {
    add('dataset', dataset.id, dataset.name, `字段：${dataset.columns}\n数据示例：${String(dataset.rows).slice(0, 1500)}`);
  }
  for (const mail of all<{ id: string; subject: string; body_text: string; from_addr: string }>('SELECT id, subject, body_text, from_addr FROM messages WHERE user_id = ?', userId)) {
    add('message', mail.id, mail.subject, `${mail.from_addr}\n${mail.body_text}`);
  }
  for (const experiment of all<{ id: string; title: string; hypothesis: string; result: string; conclusion: string }>('SELECT id, title, hypothesis, result, conclusion FROM experiments WHERE user_id = ?', userId)) {
    add('experiment', experiment.id, experiment.title, `${experiment.hypothesis}\n${experiment.result}\n${experiment.conclusion}`);
  }
  for (const project of all<{ id: string; name: string; objective: string; description: string }>('SELECT id, name, objective, description FROM projects WHERE user_id = ?', userId)) {
    add('project', project.id, project.name, `${project.objective}\n${project.description}`);
  }
  for (const file of rows<{ id: string; filename: string }>('files', 'workspace_id = ?', [workspaceId])) {
    add('file', file.id, file.filename, file.filename);
  }
  return count('knowledge_chunks', 'workspace_id = ?', [workspaceId]);
}

export function indexSize(workspaceId: string): number {
  return count('knowledge_chunks', 'workspace_id = ?', [workspaceId]);
}
