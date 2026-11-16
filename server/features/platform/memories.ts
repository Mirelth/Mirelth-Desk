/**
 * 长期记忆：显式保存（模型工具或用户手动）+ 去重 + 相关性召回。
 * 取代旧的「正则命中就整条入库、召回只取最新 5 条」——那会把随口一句话永久记住。
 */
import { embed, embeddingModelName } from '../../ai/provider.ts';
import { run } from '../../shared/database.ts';
import { newId, now } from '../../shared/crypto.ts';
import { BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { cosine, decodeVector, dotSimilarity, encodeVector, vectorize } from './rag.ts';
import { count, deleteRows, insertRow, rows } from './store.ts';

export type MemoryKind = 'preference' | 'fact' | 'project';

interface MemoryRow {
  id: string; workspace_id: string; user_id: string; kind: string; content: string;
  normalized_content: string; embedding_vec: Uint8Array | null; embedding_model: string;
  dim: number; expires_at: string | null; source: string; created_at: string;
}

const KINDS: MemoryKind[] = ['preference', 'fact', 'project'];
const MAX_MEMORIES = 500;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function toDto(row: MemoryRow) {
  return {
    id: row.id, kind: row.kind, content: row.content,
    source: row.source, expiresAt: row.expires_at, createdAt: row.created_at,
  };
}

/** 过期记忆不参与召回，也不展示——但仍留在库里，由用户显式删除。 */
function alive(row: MemoryRow): boolean {
  return !row.expires_at || row.expires_at > now();
}

export const memoriesService = {
  count(workspaceId: string, userId: string): number {
    return count('memories', 'workspace_id = ? AND user_id = ?', [workspaceId, userId]);
  },

  list(workspaceId: string, userId: string) {
    return rows<MemoryRow>('memories', 'workspace_id = ? AND user_id = ?', [workspaceId, userId], 'created_at DESC', MAX_MEMORIES)
      .filter(alive)
      .map(toDto);
  },

  /** 保存一条记忆：内容归一化后去重，重复则更新原文不新增。 */
  save(workspaceId: string, userId: string, content: string, kind: string = 'preference', source = 'manual') {
    const trimmed = content.trim();
    if (!trimmed) throw new BadRequestError('记忆内容不能为空');
    if (trimmed.length > 2000) throw new BadRequestError('单条记忆不能超过 2000 字符');
    const safeKind = KINDS.includes(kind as MemoryKind) ? kind : 'fact';
    const normalized = normalize(trimmed);

    const existing = rows<MemoryRow>('memories',
      'workspace_id = ? AND user_id = ? AND normalized_content = ?', [workspaceId, userId, normalized], undefined, 1)[0];
    if (existing) {
      run('UPDATE memories SET content = ?, kind = ?, expires_at = NULL WHERE id = ?', trimmed, safeKind, existing.id);
      return { id: existing.id, kind: safeKind, content: trimmed, deduplicated: true };
    }

    if (this.count(workspaceId, userId) >= MAX_MEMORIES) {
      throw new BadRequestError(`记忆条数已达上限（${MAX_MEMORIES}），请先清理`);
    }
    const id = insertRow('memories', {
      workspace_id: workspaceId, user_id: userId, kind: safeKind, content: trimmed,
      normalized_content: normalized, source,
    });
    return { id, kind: safeKind, content: trimmed, deduplicated: false };
  },

  remove(workspaceId: string, userId: string, id: string): void {
    const found = rows<MemoryRow>('memories', 'id = ? AND workspace_id = ? AND user_id = ?', [id, workspaceId, userId], undefined, 1)[0];
    if (!found) throw new NotFoundError('记忆', id);
    deleteRows('memories', 'id = ? AND workspace_id = ? AND user_id = ?', [id, workspaceId, userId]);
  },

  /** 为记忆补语义向量；未配嵌入模型时跳过，召回自动走词法。 */
  async embedPending(workspaceId: string, userId: string): Promise<number> {
    const model = embeddingModelName();
    if (!model) return 0;
    const pending = rows<MemoryRow>('memories',
      'workspace_id = ? AND user_id = ? AND (embedding_vec IS NULL OR embedding_model <> ?)',
      [workspaceId, userId, model], 'created_at DESC', 128);
    if (!pending.length) return 0;
    const vectors = await embed(pending.map((item) => item.content));
    if (!vectors) return 0;
    pending.forEach((item, index) => {
      const vector = vectors[index];
      if (!vector) return;
      run('UPDATE memories SET embedding_vec = ?, embedding_model = ?, dim = ? WHERE id = ?',
        encodeVector(vector), model, vector.length, item.id);
    });
    return pending.length;
  },

  /**
   * 按与当前问题的相关性召回，而不是只取最新几条。
   * 有语义向量用语义，否则用词法余弦；两者都拿不到时退回最新，保证不空。
   */
  async recall(workspaceId: string, userId: string, query: string, limit = 5): Promise<string[]> {
    const all = rows<MemoryRow>('memories', 'workspace_id = ? AND user_id = ?', [workspaceId, userId], 'created_at DESC', MAX_MEMORIES)
      .filter(alive);
    if (!all.length) return [];

    const model = embeddingModelName();
    if (model) {
      const vectors = await embed([query]);
      const queryVec = vectors?.[0];
      if (queryVec) {
        const queryArr = decodeVector(encodeVector(queryVec));
        if (queryArr) {
          const scored = all
            .filter((item) => item.embedding_model === model && item.embedding_vec)
            .map((item) => {
              const vec = decodeVector(item.embedding_vec);
              return { item, score: vec ? dotSimilarity(queryArr, vec) : 0 };
            })
            .filter((entry) => entry.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
          if (scored.length) return scored.map((entry) => entry.item.content);
        }
      }
    }

    const queryVector = vectorize(query);
    const lexical = all
      .map((item) => ({ item, score: cosine(queryVector, vectorize(item.content)) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (lexical.length) return lexical.map((entry) => entry.item.content);
    return all.slice(0, Math.min(limit, 3)).map((item) => item.content);
  },
};