/**
 * 分层记忆：四层各有职责、预算与生命周期。
 *
 * | 层 | 内容 | 写入方式 | 生命周期 |
 * | working | 本次会话的临时事实 | 显式（工具/手动） | TTL 分钟级，会话内有效 |
 * | preference | 用户稳定偏好 | **显式** | 长期，用户可删 |
 * | semantic | 事实与项目背景 | **显式** | 长期，用户可删 |
 * | episodic | 执行经验（跑过什么、成没成） | 自动留痕，**默认关闭** | TTL 天级 |
 *
 * 两条刻意的设计：
 * 1. **偏好与事实绝不自动写入**。旧版「正则命中就入库」已删除，这里不复活它。
 *    episodic 记的是**客观执行记录**（工具名、成败、耗时），不是对用户意图的推断，
 *    性质不同；但它仍是自动写入，故默认关闭、需显式开启，且带 TTL 与来源可回溯。
 * 2. **召回按层分配预算**，不再一锅端取最新 N 条——偏好该稳定占位，
 *    会话上下文该优先，执行经验只在相关时才出现。
 */
import { embed, embeddingModelName } from '../../ai/provider.ts';
import { config } from '../../shared/config.ts';
import { run } from '../../shared/database.ts';
import { now } from '../../shared/crypto.ts';
import { BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { cosine, decodeVector, dotSimilarity, encodeVector, vectorize } from './rag.ts';
import { count, deleteRows, insertRow, rows } from './store.ts';

export type MemoryKind = 'preference' | 'fact' | 'project';
export type MemoryLayer = 'working' | 'preference' | 'semantic' | 'episodic';

export const MEMORY_LAYERS: MemoryLayer[] = ['working', 'preference', 'semantic', 'episodic'];

export const LAYER_LABELS: Record<MemoryLayer, string> = {
  working: '会话短期',
  preference: '用户偏好',
  semantic: '事实与项目',
  episodic: '执行经验',
};

interface MemoryRow {
  id: string; workspace_id: string; user_id: string; kind: string; layer: string;
  content: string; normalized_content: string;
  embedding_vec: Uint8Array | null; embedding_model: string; dim: number;
  expires_at: string | null; source: string; created_at: string;
  conversation_id: string | null; run_id: string | null;
  hit_count: number; last_hit_at: string | null;
}

/** kind → layer 的映射：对外的 kind 语义保持不变，层是内部组织方式。 */
function layerOfKind(kind: string): MemoryLayer {
  return kind === 'preference' ? 'preference' : 'semantic';
}

const LAYER_CAP: Record<MemoryLayer, number> = {
  get working() { return config.memory.workingMax; },
  get preference() { return config.memory.preferenceMax; },
  get semantic() { return config.memory.semanticMax; },
  get episodic() { return config.memory.episodicMax; },
} as Record<MemoryLayer, number>;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function toDto(row: MemoryRow) {
  return {
    id: row.id, kind: row.kind, layer: row.layer, layerLabel: LAYER_LABELS[row.layer as MemoryLayer] ?? row.layer,
    content: row.content, source: row.source, expiresAt: row.expires_at, createdAt: row.created_at,
    conversationId: row.conversation_id, runId: row.run_id,
    hitCount: row.hit_count, lastHitAt: row.last_hit_at,
  };
}

/** 过期记忆不参与召回，也不展示——但仍留在库里，由用户显式删除或清理任务处理。 */
function alive(row: MemoryRow): boolean {
  return !row.expires_at || row.expires_at > now();
}

function isoAfter(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export interface RecallOptions {
  conversationId?: string;
  /** 每层条数覆盖，主要给测试与特殊场景用。 */
  budget?: Partial<Record<MemoryLayer, number>>;
}

export interface LayeredRecall {
  /** 拍平后的内容列表，兼容旧调用方。 */
  items: string[];
  /** 按层分组，供提示词分区注入与界面展示。 */
  byLayer: Record<MemoryLayer, string[]>;
  /** 命中的记忆 id，用于回写命中计数。 */
  hitIds: string[];
}

/**
 * 默认层预算：偏好稳定占位，会话上下文优先，事实按相关性，经验少量。
 * 总和受 `recallTotal` 约束——记忆不该把提示词撑爆。
 */
function defaultBudget(): Record<MemoryLayer, number> {
  const total = Math.max(1, config.memory.recallTotal);
  const preference = Math.max(1, Math.floor(total * 0.3));
  const working = Math.max(1, Math.floor(total * 0.25));
  const episodic = Math.max(1, Math.floor(total * 0.15));
  const semantic = Math.max(1, total - preference - working - episodic);
  return { working, preference, semantic, episodic };
}

export const memoriesService = {
  count(workspaceId: string, userId: string): number {
    return count('memories', 'workspace_id = ? AND user_id = ?', [workspaceId, userId]);
  },

  countByLayer(workspaceId: string, userId: string): Record<MemoryLayer, number> {
    const result = { working: 0, preference: 0, semantic: 0, episodic: 0 };
    for (const layer of MEMORY_LAYERS) {
      result[layer] = count('memories', 'workspace_id = ? AND user_id = ? AND layer = ?', [workspaceId, userId, layer]);
    }
    return result;
  },

  list(workspaceId: string, userId: string, layer?: MemoryLayer) {
    const where = layer
      ? 'workspace_id = ? AND user_id = ? AND layer = ?'
      : 'workspace_id = ? AND user_id = ?';
    const params = layer ? [workspaceId, userId, layer] : [workspaceId, userId];
    return rows<MemoryRow>('memories', where, params, 'created_at DESC', 1000)
      .filter(alive)
      .map(toDto);
  },

  /**
   * 保存一条长期记忆（偏好或事实）：归一化去重，重复则更新原文不新增。
   * **只由显式调用产生**——工具 memory_save 或用户手动，不做任何自动推断。
   */
  save(workspaceId: string, userId: string, content: string, kind: string = 'preference', source = 'manual') {
    const trimmed = content.trim();
    if (!trimmed) throw new BadRequestError('记忆内容不能为空');
    if (trimmed.length > 2000) throw new BadRequestError('单条记忆不能超过 2000 字符');
    const safeKind = (['preference', 'fact', 'project'] as string[]).includes(kind) ? kind : 'fact';
    const layer = layerOfKind(safeKind);
    const normalized = normalize(trimmed);

    // 去重跨层进行：同一句话不该在偏好与事实里各存一份。
    const existing = rows<MemoryRow>('memories',
      'workspace_id = ? AND user_id = ? AND normalized_content = ? AND layer IN (?, ?)',
      [workspaceId, userId, normalized, 'preference', 'semantic'], undefined, 1)[0];
    if (existing) {
      run('UPDATE memories SET content = ?, kind = ?, layer = ?, expires_at = NULL WHERE id = ?',
        trimmed, safeKind, layer, existing.id);
      return { id: existing.id, kind: safeKind, layer, content: trimmed, deduplicated: true };
    }

    const cap = LAYER_CAP[layer];
    if (count('memories', 'workspace_id = ? AND user_id = ? AND layer = ?', [workspaceId, userId, layer]) >= cap) {
      throw new BadRequestError(`${LAYER_LABELS[layer]}层记忆已达上限（${cap}），请先清理`);
    }
    const id = insertRow('memories', {
      workspace_id: workspaceId, user_id: userId, kind: safeKind, layer, content: trimmed,
      normalized_content: normalized, source,
    });
    return { id, kind: safeKind, layer, content: trimmed, deduplicated: false };
  },

  /**
   * 会话短期记忆：带 TTL，只在指定会话内召回。
   * 同样是显式写入——模型判断「这条只在本次任务里有意义」时才调用。
   */
  saveWorking(
    workspaceId: string, userId: string, conversationId: string, content: string,
    ttlMinutes = config.memory.workingTtlMinutes,
  ) {
    const trimmed = content.trim();
    if (!trimmed) throw new BadRequestError('记忆内容不能为空');
    if (!conversationId) throw new BadRequestError('会话短期记忆必须绑定会话');
    if (trimmed.length > 2000) throw new BadRequestError('单条记忆不能超过 2000 字符');
    const normalized = normalize(trimmed);
    const existing = rows<MemoryRow>('memories',
      'workspace_id = ? AND user_id = ? AND layer = ? AND conversation_id = ? AND normalized_content = ?',
      [workspaceId, userId, 'working', conversationId, normalized], undefined, 1)[0];
    if (existing) {
      run('UPDATE memories SET content = ?, expires_at = ? WHERE id = ?', trimmed, isoAfter(ttlMinutes), existing.id);
      return { id: existing.id, layer: 'working' as MemoryLayer, content: trimmed, deduplicated: true };
    }
    const cap = LAYER_CAP.working;
    if (count('memories', 'workspace_id = ? AND user_id = ? AND layer = ?', [workspaceId, userId, 'working']) >= cap) {
      // 短期层满了就淘汰最旧的一条，而不是报错——它是流水性质的上下文。
      const oldest = rows<MemoryRow>('memories',
        'workspace_id = ? AND user_id = ? AND layer = ?', [workspaceId, userId, 'working'], 'created_at ASC', 1)[0];
      if (oldest) deleteRows('memories', 'id = ?', [oldest.id]);
    }
    const id = insertRow('memories', {
      workspace_id: workspaceId, user_id: userId, kind: 'fact', layer: 'working', content: trimmed,
      normalized_content: normalized, source: 'agent', conversation_id: conversationId,
      expires_at: isoAfter(ttlMinutes),
    });
    return { id, layer: 'working' as MemoryLayer, content: trimmed, deduplicated: false };
  },

  /**
   * 执行经验：**客观运行记录**，不是对用户意图的推断。
   * 默认关闭（`MEMORY_EPISODIC_ENABLED`）；开启后带 TTL 与 run_id，用户可回溯与删除。
   */
  recordEpisode(
    workspaceId: string, userId: string,
    episode: { runId: string; goal: string; tools: string[]; ok: boolean; detail?: string },
  ): { id: string; recorded: boolean } {
    if (!config.memory.episodicEnabled) return { id: '', recorded: false };
    const tools = episode.tools.slice(0, 8).join('、') || '无工具';
    const content = [
      `任务「${episode.goal.slice(0, 60)}」：${episode.ok ? '完成' : '未完成'}，用到 ${tools}。`,
      episode.detail ? `结论：${episode.detail.slice(0, 120)}` : '',
    ].filter(Boolean).join(' ');
    const normalized = normalize(content);
    const existing = rows<MemoryRow>('memories',
      'workspace_id = ? AND user_id = ? AND layer = ? AND normalized_content = ?',
      [workspaceId, userId, 'episodic', normalized], undefined, 1)[0];
    if (existing) return { id: existing.id, recorded: false };

    const cap = LAYER_CAP.episodic;
    if (count('memories', 'workspace_id = ? AND user_id = ? AND layer = ?', [workspaceId, userId, 'episodic']) >= cap) {
      const oldest = rows<MemoryRow>('memories',
        'workspace_id = ? AND user_id = ? AND layer = ?', [workspaceId, userId, 'episodic'], 'created_at ASC', 1)[0];
      if (oldest) deleteRows('memories', 'id = ?', [oldest.id]);
    }
    const id = insertRow('memories', {
      workspace_id: workspaceId, user_id: userId, kind: 'project', layer: 'episodic',
      content, normalized_content: normalized, source: 'agent_run', run_id: episode.runId,
      expires_at: isoAfter(config.memory.episodicTtlDays * 24 * 60),
    });
    return { id, recorded: true };
  },

  remove(workspaceId: string, userId: string, id: string): void {
    const found = rows<MemoryRow>('memories', 'id = ? AND workspace_id = ? AND user_id = ?', [id, workspaceId, userId], undefined, 1)[0];
    if (!found) throw new NotFoundError('记忆', id);
    deleteRows('memories', 'id = ? AND workspace_id = ? AND user_id = ?', [id, workspaceId, userId]);
  },

  /** 按层清空：用户可只清执行经验而保留偏好。 */
  clearLayer(workspaceId: string, userId: string, layer: MemoryLayer): number {
    if (!MEMORY_LAYERS.includes(layer)) throw new BadRequestError('未知的记忆层');
    const before = count('memories', 'workspace_id = ? AND user_id = ? AND layer = ?', [workspaceId, userId, layer]);
    deleteRows('memories', 'workspace_id = ? AND user_id = ? AND layer = ?', [workspaceId, userId, layer]);
    return before;
  },

  /** 清理已过期记忆。返回删除条数；由用户显式触发或启动时调用。 */
  purgeExpired(workspaceId: string, userId: string): number {
    const expired = rows<MemoryRow>('memories',
      'workspace_id = ? AND user_id = ? AND expires_at IS NOT NULL AND expires_at <= ?',
      [workspaceId, userId, now()]);
    for (const item of expired) deleteRows('memories', 'id = ?', [item.id]);
    return expired.length;
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
   * 分层召回：每层独立按相关性排序并受各自预算约束。
   *
   * 与旧版的关键差别：旧版把全部记忆混在一起取 topN，导致「最近写入的琐事」
   * 挤掉「稳定偏好」。现在偏好有固定配额，会话上下文只在本会话内出现，
   * 执行经验只在相关时出现且配额最小。
   */
  async recallLayered(
    workspaceId: string, userId: string, query: string, options: RecallOptions = {},
  ): Promise<LayeredRecall> {
    const budget = { ...defaultBudget(), ...(options.budget ?? {}) };
    const all = rows<MemoryRow>('memories',
      'workspace_id = ? AND user_id = ?', [workspaceId, userId], 'created_at DESC', 1000).filter(alive);
    const empty: LayeredRecall = {
      items: [], byLayer: { working: [], preference: [], semantic: [], episodic: [] }, hitIds: [],
    };
    if (!all.length) return empty;

    // 会话短期记忆只在指定会话内可见——换个会话就不该带过来。
    const scoped = all.filter((item) => {
      if (item.layer !== 'working') return true;
      return Boolean(options.conversationId) && item.conversation_id === options.conversationId;
    });

    const model = embeddingModelName();
    let queryArr: Float32Array | null = null;
    if (model) {
      const vectors = await embed([query]);
      const queryVec = vectors?.[0];
      if (queryVec) queryArr = decodeVector(encodeVector(queryVec));
    }
    const queryVector = vectorize(query);

    const scoreOf = (item: MemoryRow): number => {
      if (queryArr && item.embedding_model === model && item.embedding_vec) {
        const vec = decodeVector(item.embedding_vec);
        if (vec && vec.length === queryArr.length) return dotSimilarity(queryArr, vec);
      }
      return cosine(queryVector, vectorize(item.content));
    };

    const byLayer: Record<MemoryLayer, string[]> = { working: [], preference: [], semantic: [], episodic: [] };
    const hitIds: string[] = [];
    for (const layer of MEMORY_LAYERS) {
      const pool = scoped.filter((item) => item.layer === layer);
      if (!pool.length) continue;
      const limit = Math.max(0, budget[layer]);
      if (!limit) continue;
      const scored = pool.map((item) => ({ item, score: scoreOf(item) }));
      // 偏好层即使相关性为 0 也要保底带上——它是稳定约束，不该因措辞不同而消失。
      const threshold = layer === 'preference' ? -1 : layer === 'episodic' ? 0.15 : 0;
      const picked = scored
        .filter((entry) => entry.score > threshold)
        .sort((a, b) => b.score - a.score || b.item.hit_count - a.item.hit_count)
        .slice(0, limit);
      // 偏好层一条都没命中时，退回最近写入的若干条，保证稳定约束不丢。
      const final = picked.length ? picked
        : layer === 'preference' ? scored.slice(0, Math.min(limit, 2)) : [];
      byLayer[layer] = final.map((entry) => entry.item.content);
      hitIds.push(...final.map((entry) => entry.item.id));
    }

    // 跨层去重：同一句话可能同时存在于两层（历史数据），不重复占预算。
    const seen = new Set<string>();
    for (const layer of MEMORY_LAYERS) {
      byLayer[layer] = byLayer[layer].filter((content) => {
        const key = normalize(content);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const items = MEMORY_LAYERS.flatMap((layer) => byLayer[layer]).slice(0, config.memory.recallTotal);
    if (hitIds.length) this.markHits(hitIds);
    return { items, byLayer, hitIds };
  },

  /** 回写命中计数：让用户看得出哪条记忆真在被用。 */
  markHits(ids: string[]): void {
    const stamp = now();
    for (const id of ids) {
      run('UPDATE memories SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?', stamp, id);
    }
  },

  /** 兼容旧调用方：只要拍平的内容列表。 */
  async recall(workspaceId: string, userId: string, query: string, limit = 5, conversationId?: string): Promise<string[]> {
    const result = await this.recallLayered(workspaceId, userId, query, {
      ...(conversationId ? { conversationId } : {}),
      budget: {
        preference: Math.max(1, Math.ceil(limit * 0.4)),
        semantic: Math.max(1, Math.ceil(limit * 0.3)),
        working: Math.max(1, Math.floor(limit * 0.2)),
        episodic: Math.max(0, limit - Math.ceil(limit * 0.4) - Math.ceil(limit * 0.3) - Math.floor(limit * 0.2)),
      },
    });
    return result.items.slice(0, limit);
  },

  /** 分层配置与用量，供界面与状态接口展示。 */
  layerStatus(workspaceId: string, userId: string) {
    const counts = this.countByLayer(workspaceId, userId);
    return {
      layers: MEMORY_LAYERS.map((layer) => ({
        layer, label: LAYER_LABELS[layer], count: counts[layer], cap: LAYER_CAP[layer],
      })),
      episodicEnabled: config.memory.episodicEnabled,
      workingTtlMinutes: config.memory.workingTtlMinutes,
      episodicTtlDays: config.memory.episodicTtlDays,
      recallTotal: config.memory.recallTotal,
      note: config.memory.episodicEnabled
        ? '执行经验层已开启：自动记录客观运行结果，带保留期，可随时清空。偏好与事实仍只由显式保存产生。'
        : '执行经验层默认关闭。偏好与事实只由显式保存产生，不做自动推断。',
    };
  },
};