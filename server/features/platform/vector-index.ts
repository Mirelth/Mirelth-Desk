import { config } from '../../shared/config.ts';
import { now } from '../../shared/crypto.ts';
import { all, run } from '../../shared/database.ts';
import { logger } from '../../shared/logger.ts';
import { decodeVector, dotSimilarity, encodeVector } from './rag.ts';
import { count, insertRow, row, rows } from './store.ts';

/**
 * 向量检索索引：**粗量化分桶（IVF）+ 原始向量精排**。
 *
 * 为什么需要它：原实现对 `knowledge_chunks` 全表扫且硬上限 2000 行——
 * 超过 2000 的片段**根本参与不了语义召回**，这不只是慢，是静默丢召回。
 *
 * 做法：k-means 训练一批质心，每个片段归到最近质心所在桶；查询时只探查
 * 与查询向量最近的若干个桶（nprobe），桶内仍用**原始 float32 精排**。
 * 因此精度损失只来自「候选裁剪」，不来自量化压缩——比标量量化更保真。
 *
 * 刻意保留的边界：
 * - 小库（默认 < 20000 片段）**仍走全扫**，因为全扫更准且更快，建索引纯属浪费；
 * - 索引是**近似**检索，不保证与全扫完全一致，测试用召回率下限而非逐条相等来验收；
 * - 不引入外部向量库，仍是单机 SQLite，符合「不自建向量数据库」的既有决定。
 */

export interface CentroidSet {
  id: string; workspace_id: string; model: string; dim: number;
  bucket_count: number; centroids: Uint8Array; trained_on: number;
  created_at: string; updated_at: string;
}

export interface IndexStats {
  mode: 'scan' | 'index';
  indexed: boolean;
  chunks: number;
  assigned: number;
  buckets: number;
  probes: number;
  /** 最大桶 / 平均桶，用于判断是否需要重建。 */
  imbalance: number;
  trainedOn: number;
  updatedAt: string | null;
}

/** 取某工作区某模型的质心集合；维度必须匹配，否则视为无索引。 */
export function centroidSet(workspaceId: string, model: string, dim: number): CentroidSet | undefined {
  return row<CentroidSet>('vector_centroids',
    'workspace_id = ? AND model = ? AND dim = ?', [workspaceId, model, dim]);
}

/**
 * 决定本次查询走全扫还是索引。
 * `auto` 下只有「片段数超阈值」且「索引已就绪」才走索引——没建好就退回全扫，不报错。
 */
export function shouldUseIndex(workspaceId: string, model: string, dim: number, total: number): boolean {
  const mode = config.vector.mode;
  if (mode === 'scan') return false;
  const set = centroidSet(workspaceId, model, dim);
  if (!set) return false;
  if (mode === 'index') return true;
  return total >= config.vector.autoThreshold;
}

/** 找最近质心：返回桶号与相似度。质心已归一化时用点积即可，这里仍做完整余弦。 */
export function nearestBucket(query: Float32Array, centroids: Float32Array, bucketCount: number, dim: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const center = centroids.subarray(bucket * dim, (bucket + 1) * dim);
    const score = dotSimilarity(query, center);
    if (score > bestScore) { bestScore = score; best = bucket; }
  }
  return best;
}

/** 取与查询最近的 nprobe 个桶号（按相似度降序）。 */
export function probeBuckets(query: Float32Array, set: CentroidSet, probes: number): number[] {
  const centers = decodeVector(set.centroids);
  if (!centers || centers.length !== set.bucket_count * set.dim) return [];
  const scored: Array<{ bucket: number; score: number }> = [];
  for (let bucket = 0; bucket < set.bucket_count; bucket += 1) {
    const center = centers.subarray(bucket * set.dim, (bucket + 1) * set.dim);
    scored.push({ bucket, score: dotSimilarity(query, center) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(probes, set.bucket_count))).map((item) => item.bucket);
}

/**
 * 按桶取候选片段 id。
 * 用 `IN (...)` 一次查完，避免逐桶往返；桶数受 nprobe 限制，参数量可控。
 */
export function candidateIds(centroidId: string, buckets: number[]): string[] {
  if (!buckets.length) return [];
  const placeholders = buckets.map(() => '?').join(', ');
  return all<{ chunk_id: string }>(
    `SELECT chunk_id FROM vector_buckets WHERE centroid_id = ? AND bucket IN (${placeholders})`,
    centroidId, ...buckets,
  ).map((item) => item.chunk_id);
}

/** 确定性采样：按固定步长取，保证同一批数据每次训练结果一致（可复现）。 */
function sampleVectors(vectors: Float32Array[], limit: number): Float32Array[] {
  if (vectors.length <= limit) return vectors;
  const step = vectors.length / limit;
  const picked: Float32Array[] = [];
  for (let index = 0; index < limit; index += 1) {
    const vector = vectors[Math.floor(index * step)];
    if (vector) picked.push(vector);
  }
  return picked;
}

/**
 * k-means 训练质心。
 *
 * 初始质心用「最远优先」而非随机：确定性、可复现，且能避免多个质心挤在同一簇。
 * 空桶用当前最大桶里最远的点补种，防止桶退化导致召回塌陷。
 */
export function trainCentroids(vectors: Float32Array[], bucketCount: number, iterations: number): Float32Array {
  const dim = vectors[0]?.length ?? 0;
  const count = Math.max(1, Math.min(bucketCount, vectors.length));
  const centers = new Float32Array(count * dim);
  if (!dim || !vectors.length) return centers;

  // 第一个质心取第一个样本；后续每次取「距已选质心最近距离最大」的样本。
  centers.set(vectors[0].subarray(0, dim), 0);
  const chosen = new Set<number>([0]);
  for (let slot = 1; slot < count; slot += 1) {
    let farthest = -1;
    let farthestDistance = -Infinity;
    for (let index = 0; index < vectors.length; index += 1) {
      if (chosen.has(index)) continue;
      let nearest = Infinity;
      for (let taken = 0; taken < slot; taken += 1) {
        const similarity = dotSimilarity(vectors[index], centers.subarray(taken * dim, (taken + 1) * dim));
        const distance = 1 - similarity;
        if (distance < nearest) nearest = distance;
      }
      if (nearest > farthestDistance) { farthestDistance = nearest; farthest = index; }
    }
    if (farthest < 0) farthest = slot % vectors.length;
    chosen.add(farthest);
    centers.set(vectors[farthest].subarray(0, dim), slot * dim);
  }

  const assign = new Int32Array(vectors.length);
  for (let round = 0; round < iterations; round += 1) {
    let moved = 0;
    for (let index = 0; index < vectors.length; index += 1) {
      const bucket = nearestBucket(vectors[index], centers, count, dim);
      if (assign[index] !== bucket) moved += 1;
      assign[index] = bucket;
    }
    const sums = new Float64Array(count * dim);
    const sizes = new Int32Array(count);
    for (let index = 0; index < vectors.length; index += 1) {
      const bucket = assign[index];
      sizes[bucket] += 1;
      for (let axis = 0; axis < dim; axis += 1) sums[bucket * dim + axis] += vectors[index][axis];
    }
    for (let bucket = 0; bucket < count; bucket += 1) {
      if (!sizes[bucket]) continue;
      for (let axis = 0; axis < dim; axis += 1) centers[bucket * dim + axis] = sums[bucket * dim + axis] / sizes[bucket];
    }
    // 空桶补种：从最大桶里挑一个离其质心最远的点，避免桶白白浪费。
    for (let bucket = 0; bucket < count; bucket += 1) {
      if (sizes[bucket]) continue;
      let largest = 0;
      for (let other = 1; other < count; other += 1) if (sizes[other] > sizes[largest]) largest = other;
      let seed = -1;
      let worst = -Infinity;
      for (let index = 0; index < vectors.length; index += 1) {
        if (assign[index] !== largest) continue;
        const distance = 1 - dotSimilarity(vectors[index], centers.subarray(largest * dim, (largest + 1) * dim));
        if (distance > worst) { worst = distance; seed = index; }
      }
      if (seed >= 0) {
        centers.set(vectors[seed].subarray(0, dim), bucket * dim);
        assign[seed] = bucket;
        sizes[largest] -= 1;
        sizes[bucket] = 1;
      }
    }
    if (!moved && round > 0) break;
  }
  return centers;
}

export interface BuildOptions {
  /** 强制重建（即使已有索引）。 */
  force?: boolean;
  /** 桶数上限覆盖，主要给测试用。 */
  buckets?: number;
}

/**
 * 为某工作区建索引：训练质心 → 给全部已嵌入片段分桶。
 * 未配嵌入模型或没有向量时返回 null，调用方据此如实报告「未建索引」。
 */
export function buildIndex(
  workspaceId: string,
  model: string,
  options: BuildOptions = {},
): { centroidId: string; buckets: number; assigned: number; trainedOn: number } | null {
  if (!model) return null;
  const stored = rows<{ id: string; embedding_vec: Uint8Array; dim: number }>(
    'knowledge_chunks',
    'workspace_id = ? AND embedding_model = ? AND embedding_vec IS NOT NULL',
    [workspaceId, model], 'created_at ASC',
  );
  if (!stored.length) return null;
  const dim = stored[0].dim || (decodeVector(stored[0].embedding_vec)?.length ?? 0);
  if (!dim) return null;

  const existing = centroidSet(workspaceId, model, dim);
  // 桶数：显式指定优先（用户/调用方明确要多少就多少），否则按 sqrt(N) 估算并受配置上限约束。
  // 两者都不超过样本数——小库不该有比向量还多的桶。
  const bucketCount = options.buckets !== undefined
    ? Math.max(1, Math.min(options.buckets, stored.length))
    : Math.max(1, Math.min(config.vector.buckets, Math.ceil(Math.sqrt(stored.length)), stored.length));
  if (existing && !options.force && existing.bucket_count === bucketCount) {
    // 已有同规格索引：只补分配新增片段，不重复训练（训练是最贵的一步）。
    const assigned = assignAll(workspaceId, existing, stored);
    return { centroidId: existing.id, buckets: existing.bucket_count, assigned, trainedOn: existing.trained_on };
  }

  const vectors: Float32Array[] = [];
  for (const item of stored) {
    const vector = decodeVector(item.embedding_vec);
    if (vector && vector.length === dim) vectors.push(vector);
  }
  if (!vectors.length) return null;
  const sample = sampleVectors(vectors, config.vector.trainSample);
  const centers = trainCentroids(sample, bucketCount, config.vector.trainIterations);
  const actualBuckets = centers.length / dim;

  const centroidId = existing?.id ?? insertRow('vector_centroids', {
    workspace_id: workspaceId, model, dim, bucket_count: actualBuckets,
    centroids: encodeVector(Array.from(centers)), trained_on: sample.length, updated_at: now(),
  });
  if (existing) {
    run('UPDATE vector_centroids SET bucket_count = ?, centroids = ?, trained_on = ?, updated_at = ? WHERE id = ?',
      actualBuckets, encodeVector(Array.from(centers)), sample.length, now(), centroidId);
    // 规格变了，旧归属全部作废。
    run('DELETE FROM vector_buckets WHERE centroid_id = ?', centroidId);
  }
  const set = centroidSet(workspaceId, model, dim)!;
  const assigned = assignAll(workspaceId, set, stored);
  logger.info('vector.index_built', { workspace_id: workspaceId, buckets: actualBuckets, assigned, model });
  return { centroidId, buckets: actualBuckets, assigned, trainedOn: sample.length };
}

/** 给一批片段分配桶并落库。返回实际写入条数。 */
function assignAll(
  workspaceId: string,
  set: CentroidSet,
  stored: Array<{ id: string; embedding_vec: Uint8Array; dim: number }>,
): number {
  const centers = decodeVector(set.centroids);
  if (!centers) return 0;
  let written = 0;
  for (const item of stored) {
    const vector = decodeVector(item.embedding_vec);
    if (!vector || vector.length !== set.dim) continue;
    const bucket = nearestBucket(vector, centers, set.bucket_count, set.dim);
    run(
      `INSERT INTO vector_buckets (chunk_id, workspace_id, centroid_id, bucket, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET centroid_id = excluded.centroid_id, bucket = excluded.bucket`,
      item.id, workspaceId, set.id, bucket, now(),
    );
    run('UPDATE knowledge_chunks SET bucket = ? WHERE id = ?', bucket, item.id);
    written += 1;
  }
  return written;
}

/**
 * 增量分配：只给「有向量但还没归属」的片段分桶。
 * 新文档入库后调用，避免每次检索都重建索引。
 */
export function assignPending(workspaceId: string, model: string, limit = 512): number {
  if (!model) return 0;
  const pending = all<{ id: string; embedding_vec: Uint8Array; dim: number }>(
    `SELECT c.id, c.embedding_vec, c.dim FROM knowledge_chunks c
     LEFT JOIN vector_buckets b ON b.chunk_id = c.id
     WHERE c.workspace_id = ? AND c.embedding_model = ? AND c.embedding_vec IS NOT NULL AND b.chunk_id IS NULL
     LIMIT ?`,
    workspaceId, model, limit,
  );
  if (!pending.length) return 0;
  const dim = pending[0].dim;
  const set = centroidSet(workspaceId, model, dim);
  // 还没训练过：不擅自建索引（建索引是显式动作），留给调用方决定。
  if (!set) return 0;
  return assignAll(workspaceId, set, pending);
}

/** 删除某来源片段的桶归属——与 knowledge_chunks/FTS 的清理成对进行。 */
export function removeAssignments(chunkIds: string[]): void {
  for (const id of chunkIds) run('DELETE FROM vector_buckets WHERE chunk_id = ?', id);
}

export function dropIndex(workspaceId: string): void {
  const sets = rows<{ id: string }>('vector_centroids', 'workspace_id = ?', [workspaceId]);
  for (const set of sets) run('DELETE FROM vector_buckets WHERE centroid_id = ?', set.id);
  run('DELETE FROM vector_centroids WHERE workspace_id = ?', workspaceId);
  run('UPDATE knowledge_chunks SET bucket = -1 WHERE workspace_id = ?', workspaceId);
}

export function indexStats(workspaceId: string, model: string): IndexStats {
  const chunks = count('knowledge_chunks',
    'workspace_id = ? AND embedding_model = ? AND embedding_vec IS NOT NULL', [workspaceId, model]);
  const sets = rows<CentroidSet>('vector_centroids', 'workspace_id = ? AND model = ?', [workspaceId, model]);
  const set = sets[0];
  if (!set) {
    return {
      mode: 'scan', indexed: false, chunks, assigned: 0, buckets: 0,
      probes: config.vector.probes, imbalance: 0, trainedOn: 0, updatedAt: null,
    };
  }
  const assigned = count('vector_buckets', 'centroid_id = ?', [set.id]);
  const distribution = all<{ bucket: number; c: number }>(
    'SELECT bucket, COUNT(*) AS c FROM vector_buckets WHERE centroid_id = ? GROUP BY bucket', set.id);
  const largest = distribution.reduce((max, item) => Math.max(max, item.c), 0);
  const average = assigned / Math.max(set.bucket_count, 1);
  return {
    mode: shouldUseIndex(workspaceId, model, set.dim, chunks) ? 'index' : 'scan',
    indexed: true, chunks, assigned, buckets: set.bucket_count,
    probes: Math.min(config.vector.probes, set.bucket_count),
    imbalance: average ? Number((largest / average).toFixed(2)) : 0,
    trainedOn: set.trained_on, updatedAt: set.updated_at,
  };
}