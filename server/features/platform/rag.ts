import crypto from 'node:crypto';
import { embed, embeddingModelName } from '../../ai/provider.ts';
import { all, run } from '../../shared/database.ts';
import { logger } from '../../shared/logger.ts';
import { insertRow, rows, deleteRows, count } from './store.ts';

export interface Chunk {
  id: string; workspace_id: string; source_type: string; source_id: string;
  title: string; content: string; embedding: string; created_at: string;
  embedding_vec: Uint8Array | null; embedding_model: string; dim: number;
  chunk_index: number; content_hash: string;
}

// ---------------------------------------------------------------- 词法层（离线可用的底座）

/**
 * 分词：先按非字母数字切开，再在中日韩文字与拉丁/数字的交界处切开。
 * 不切交界会让「ZZZQ增量测试」整串成为一个词元，搜「增量测试」永远命中不了——
 * 中英混排在办公文档里很常见，这是必须覆盖的情况。
 */
export function tokenize(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

  for (const part of parts) {
    // 按「CJK 段」与「非 CJK 段」交替切分。
    const segments: string[] = [];
    let buffer = '';
    let lastCjk: boolean | null = null;
    for (const char of part) {
      const isCjk = CJK.test(char);
      if (lastCjk !== null && isCjk !== lastCjk) { segments.push(buffer); buffer = ''; }
      buffer += char;
      lastCjk = isCjk;
    }
    if (buffer) segments.push(buffer);

    for (const segment of segments) {
      if (!segment) continue;
      if (CJK.test(segment[0])) {
        if (segment.length === 1) tokens.push(segment);
        else for (let index = 0; index < segment.length - 1; index += 1) tokens.push(segment.slice(index, index + 2));
      } else tokens.push(segment);
    }
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

// ---------------------------------------------------------------- 语义向量编解码

/** Float32 小端存 BLOB：比 JSON 省一半以上空间，读回来直接算。 */
export function encodeVector(vector: number[]): Uint8Array {
  const buffer = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return new Uint8Array(buffer);
}

export function decodeVector(blob: Uint8Array | null): Float32Array | null {
  if (!blob || !blob.length || blob.length % 4 !== 0) return null;
  // 复制一份保证 4 字节对齐，避免 subarray 偏移导致 DataView 越界。
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, 0, copy.length / 4);
}

export function dotSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0; let normA = 0; let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom ? dot / denom : 0;
}

// ---------------------------------------------------------------- 分块

const CHUNK_TARGET = 700;
const CHUNK_OVERLAP = 100;
const MAX_CHUNKS_PER_SOURCE = 60;

/**
 * 按标题与段落切块：优先在标题处断开，长段落再按目标长度切并保留重叠。
 * 整篇一块会让长文档的相关段落被无关内容稀释，这是检索精度的主要来源。
 */
export function splitChunks(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= CHUNK_TARGET) return [normalized];

  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const text = current.join('\n').trim();
    if (text) blocks.push(text);
    current = [];
  };

  for (const line of normalized.split('\n')) {
    // 标题处强制断开，让每个 chunk 尽量对应一个语义小节。
    if (/^#{1,6}\s+/.test(line.trim()) && current.length) flush();
    current.push(line);
    if (current.join('\n').length >= CHUNK_TARGET) flush();
  }
  flush();

  const chunks: string[] = [];
  for (const block of blocks) {
    if (block.length <= CHUNK_TARGET * 1.6) { chunks.push(block); continue; }
    let start = 0;
    while (start < block.length && chunks.length < MAX_CHUNKS_PER_SOURCE) {
      chunks.push(block.slice(start, start + CHUNK_TARGET));
      start += CHUNK_TARGET - CHUNK_OVERLAP;
    }
  }
  return chunks.slice(0, MAX_CHUNKS_PER_SOURCE);
}

function hashContent(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------- 写入

export interface IndexOptions {
  /** 已有语义向量可复用（内容未变时跳过重新嵌入，省费用与延迟）。 */
  reuse?: Map<string, { vec: Uint8Array; model: string; dim: number }>;
}

/** 索引一个来源：先按 source 清掉旧块（含 FTS），再分块写入。 */
export function indexChunk(
  workspaceId: string, sourceType: string, sourceId: string, title: string, content: string,
  options: IndexOptions = {},
): void {
  removeSource(workspaceId, sourceType, sourceId);
  const pieces = splitChunks(content.slice(0, 60_000));
  pieces.forEach((piece, index) => {
    const hash = hashContent(piece);
    const reused = options.reuse?.get(hash);
    const id = insertRow('knowledge_chunks', {
      workspace_id: workspaceId, source_type: sourceType, source_id: sourceId,
      title: title.slice(0, 300), content: piece,
      embedding: JSON.stringify(vectorize(`${title} ${piece}`)),
      chunk_index: index, content_hash: hash,
      embedding_vec: reused?.vec ?? null,
      embedding_model: reused?.model ?? '',
      dim: reused?.dim ?? 0,
    });
    run('INSERT INTO knowledge_fts (chunk_id, title, content) VALUES (?, ?, ?)',
      id, tokenize(title).join(' '), tokenize(piece).join(' '));
  });
}

/** 删除某来源的全部块与对应 FTS 行——两张表无触发器兜底，必须成对处理。 */
export function removeSource(workspaceId: string, sourceType: string, sourceId: string): void {
  const previous = rows<{ id: string }>('knowledge_chunks',
    'workspace_id = ? AND source_type = ? AND source_id = ?', [workspaceId, sourceType, sourceId]);
  for (const item of previous) run('DELETE FROM knowledge_fts WHERE chunk_id = ?', item.id);
  deleteRows('knowledge_chunks', 'workspace_id = ? AND source_type = ? AND source_id = ?',
    [workspaceId, sourceType, sourceId]);
}

/**
 * 为尚未嵌入的块补语义向量。未配置嵌入模型时直接返回 0，检索继续走词法路径。
 * 按 content_hash 去重后批量请求，避免同一段文字反复付费。
 */
export async function embedPending(workspaceId: string, limit = 256): Promise<number> {
  const model = embeddingModelName();
  if (!model) return 0;
  const pending = rows<Chunk>('knowledge_chunks',
    'workspace_id = ? AND (embedding_vec IS NULL OR embedding_model <> ?)',
    [workspaceId, model], 'created_at DESC', limit);
  if (!pending.length) return 0;

  const done = rows<{ content_hash: string; embedding_vec: Uint8Array; dim: number }>(
    'knowledge_chunks', 'workspace_id = ? AND embedding_model = ? AND embedding_vec IS NOT NULL',
    [workspaceId, model], undefined, 500);
  const cache = new Map(done.map((item) => [item.content_hash, item]));

  const unique = new Map<string, string>();
  for (const chunk of pending) if (!cache.has(chunk.content_hash)) unique.set(chunk.content_hash, chunk.content);

  const hashes = [...unique.keys()];
  const batchSize = 32;
  for (let start = 0; start < hashes.length; start += batchSize) {
    const batch = hashes.slice(start, start + batchSize);
    const vectors = await embed(batch.map((hash) => unique.get(hash) ?? ''));
    if (!vectors) return 0;
    batch.forEach((hash, index) => {
      const vector = vectors[index];
      const blob = encodeVector(vector);
      cache.set(hash, { content_hash: hash, embedding_vec: blob, dim: vector.length });
    });
  }

  let updated = 0;
  for (const chunk of pending) {
    const hit = cache.get(chunk.content_hash);
    if (!hit) continue;
    run('UPDATE knowledge_chunks SET embedding_vec = ?, embedding_model = ?, dim = ? WHERE id = ?',
      hit.embedding_vec, model, hit.dim, chunk.id);
    updated += 1;
  }
  logger.info('rag.embedded', { workspace_id: workspaceId, chunks: updated, model });
  return updated;
}

// ---------------------------------------------------------------- 检索

export interface SearchHit {
  id: string; title: string; content: string; sourceType: string; sourceId: string;
  score: number; mode?: 'hybrid' | 'lexical';
}

export interface SearchResult { hits: SearchHit[]; mode: 'hybrid' | 'lexical' }

/** 倒数排名融合：两路量纲不同，不能直接相加分数。 */
function rrf(rankings: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankings) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return scores;
}

function lexicalRecall(workspaceId: string, terms: string[], limit: number): Chunk[] {
  const candidates = new Map<string, Chunk>();
  const like = terms.slice(0, 4).map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
  if (like) {
    const params: unknown[] = [workspaceId];
    for (const term of terms.slice(0, 4)) params.push(`%${term}%`, `%${term}%`);
    for (const item of rows<Chunk>('knowledge_chunks', `workspace_id = ? AND (${like})`, params, undefined, limit)) {
      candidates.set(item.id, item);
    }
  }
  if (terms.length) {
    const match = terms.map((term) => `"${term.replace(/"/g, '')}"`).join(' OR ');
    try {
      const ftsIds = all<{ chunk_id: string }>('SELECT chunk_id FROM knowledge_fts WHERE knowledge_fts MATCH ? LIMIT ?', match, limit);
      for (const entry of ftsIds) {
        const found = rows<Chunk>('knowledge_chunks', 'id = ? AND workspace_id = ?', [entry.chunk_id, workspaceId], undefined, 1)[0];
        if (found) candidates.set(found.id, found);
      }
    } catch { /* FTS 语法不合法时退回 LIKE 召回 */ }
  }
  return [...candidates.values()];
}

/**
 * 混合检索：词法（LIKE + FTS5 + 词袋余弦）与语义（向量近邻）两路召回，RRF 融合。
 * 未配置嵌入模型时自动退化为纯词法，行为与旧版一致。
 */
export async function searchHybrid(workspaceId: string, query: string, limit = 5): Promise<SearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], mode: 'lexical' };
  const terms = tokenize(trimmed).slice(0, 12);
  const poolSize = Math.max(limit * 12, 60);

  const lexicalChunks = lexicalRecall(workspaceId, terms, poolSize);
  const queryVector = vectorize(trimmed);
  const lexicalRanked = lexicalChunks
    .map((chunk) => ({ chunk, score: cosine(queryVector, JSON.parse(chunk.embedding) as Record<string, number>) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const model = embeddingModelName();
  let semanticRanked: Array<{ chunk: Chunk; score: number }> = [];
  if (model) {
    const vectors = await embed([trimmed]);
    const queryVec = vectors?.[0];
    if (queryVec) {
      const encoded = encodeVector(queryVec);
      const queryArr = decodeVector(encoded);
      const stored = rows<Chunk>('knowledge_chunks',
        'workspace_id = ? AND embedding_model = ? AND embedding_vec IS NOT NULL',
        [workspaceId, model], undefined, 2000);
      if (queryArr) {
        semanticRanked = stored
          .map((chunk) => {
            const vec = decodeVector(chunk.embedding_vec);
            return { chunk, score: vec ? dotSimilarity(queryArr, vec) : 0 };
          })
          .filter((item) => item.score > 0.15)
          .sort((a, b) => b.score - a.score)
          .slice(0, poolSize);
      }
    }
  }

  const byId = new Map<string, Chunk>();
  for (const item of [...lexicalRanked, ...semanticRanked]) byId.set(item.chunk.id, item.chunk);

  const useHybrid = semanticRanked.length > 0;
  const fused = useHybrid
    ? rrf([lexicalRanked.map((item) => item.chunk.id), semanticRanked.map((item) => item.chunk.id)])
    : new Map(lexicalRanked.map((item, index) => [item.chunk.id, 1 / (60 + index + 1)]));

  const hits = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]): SearchHit | null => {
      const chunk = byId.get(id);
      if (!chunk) return null;
      return {
        id: chunk.id, title: chunk.title, content: chunk.content,
        sourceType: chunk.source_type, sourceId: chunk.source_id,
        score: Number(score.toFixed(4)), mode: useHybrid ? 'hybrid' : 'lexical',
      };
    })
    .filter((hit): hit is SearchHit => hit !== null);

  return { hits, mode: useHybrid ? 'hybrid' : 'lexical' };
}

/** 同步词法检索：给不能 await 的调用方（工具循环的同步分支、离线兜底）保留。 */
export function search(workspaceId: string, query: string, limit = 5): SearchHit[] {
  const terms = tokenize(query).slice(0, 12);
  const queryVector = vectorize(query);
  return lexicalRecall(workspaceId, terms, Math.max(limit * 12, 60))
    .map((chunk) => ({
      id: chunk.id, title: chunk.title, content: chunk.content,
      sourceType: chunk.source_type, sourceId: chunk.source_id,
      score: cosine(queryVector, JSON.parse(chunk.embedding) as Record<string, number>),
      mode: 'lexical' as const,
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function contextFor(workspaceId: string, query: string): Promise<string> {
  const { hits } = await searchHybrid(workspaceId, query, 4);
  if (!hits.length) return '';
  return `以下是从本机知识库检索到的相关材料（请优先引用，不要编造）：\n${hits.map((hit, index) => `[${index + 1}] ${hit.title}（${hit.sourceType}）\n${hit.content.slice(0, 600)}`).join('\n\n')}`;
}

// ---------------------------------------------------------------- 全量重建

export async function reindex(workspaceId: string, userId: string): Promise<number> {
  const add = (type: string, id: string, title: string, content: string): void => {
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
  // 附件：此前只索引文件名，正文完全搜不到。文本类附件现在纳入索引。
  for (const file of rows<{ id: string; filename: string; mime: string; path: string }>('files', 'workspace_id = ?', [workspaceId])) {
    add('file', file.id, file.filename, await readFileText(file));
  }
  await embedPending(workspaceId, 1024);
  return count('knowledge_chunks', 'workspace_id = ?', [workspaceId]);
}

/** 只读文本类附件；二进制（图片/PDF）由 OCR/PDF 流程在导入时单独入索引。 */
async function readFileText(file: { filename: string; mime: string; path: string }): Promise<string> {
  const textual = /\.(txt|md|csv|json|log|tsv|html?)$/i.test(file.filename)
    || /^(text\/|application\/(json|csv))/.test(file.mime ?? '');
  if (!textual) return file.filename;
  try {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(file.path, 'utf8');
    return `${file.filename}\n${raw.slice(0, 20_000)}`;
  } catch {
    return file.filename;
  }
}

export function indexSize(workspaceId: string): number {
  return count('knowledge_chunks', 'workspace_id = ?', [workspaceId]);
}

export function semanticSize(workspaceId: string): number {
  const model = embeddingModelName();
  if (!model) return 0;
  return count('knowledge_chunks', 'workspace_id = ? AND embedding_model = ? AND embedding_vec IS NOT NULL', [workspaceId, model]);
}