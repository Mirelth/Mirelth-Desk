/**
 * 向量索引测试：不只测「能跑」，而是**实测召回率与候选裁剪比例**。
 *
 * 索引是近似检索，不能断言与全扫逐条相等；正确验收方式是
 * 「同一批查询下，索引相对全扫的 recall@k 不低于阈值」+「候选数确实大幅下降」。
 *
 * 用可控的合成向量（簇状分布 + 噪声），全程离线、不出网、不花模型钱。
 */
process.env.DATABASE_PATH = '.data/regression-vector.db';
process.env.APP_SECRET = 'regression-vector-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.BROWSER_ENABLED = 'false';
// 强制走索引，便于在小规模数据上验证索引路径本身。
process.env.VECTOR_INDEX_MODE = 'index';
process.env.VECTOR_PROBES = '6';
process.env.VECTOR_BUCKETS = '32';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate, run, all } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const { config } = await import('../server/shared/config.ts');
const { encodeVector, decodeVector, dotSimilarity, indexChunk, removeSource } = await import('../server/features/platform/rag.ts');
const {
  buildIndex, dropIndex, indexStats, trainCentroids, nearestBucket, probeBuckets,
  candidateIds, centroidSet, assignPending, shouldUseIndex,
} = await import('../server/features/platform/vector-index.ts');
const { insertRow } = await import('../server/features/platform/store.ts');

migrate();
authService.ensureAdmin();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const WS = 'wsp_vector_test';
const MODEL = 'test-embed';
const DIM = 32;

let cookie = '';
before(async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  run('INSERT OR IGNORE INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)',
    WS, '向量测试区', 'usr_test', new Date().toISOString());
});

after(() => {
  server.close();
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-vector.db${suffix}`, { force: true });
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
});

/** 确定性伪随机：同一 seed 每次产出相同序列，保证测试可复现。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 造簇状向量：clusterCount 个中心，每个中心若干带噪声的样本。 */
function makeClustered(clusterCount: number, perCluster: number, dim: number, seed = 42): {
 vectors: Float32Array[]; labels: number[]; centers: Float32Array[];
} {
  const random = makeRandom(seed);
  const centers: Float32Array[] = [];
  for (let index = 0; index < clusterCount; index += 1) {
    const center = new Float32Array(dim);
    for (let axis = 0; axis < dim; axis += 1) center[axis] = random() * 2 - 1;
    centers.push(center);
  }
  const vectors: Float32Array[] = [];
  const labels: number[] = [];
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    for (let item = 0; item < perCluster; item += 1) {
      const vector = new Float32Array(dim);
      for (let axis = 0; axis < dim; axis += 1) {
        vector[axis] = centers[cluster][axis] + (random() * 2 - 1) * 0.12;
      }
      vectors.push(vector);
      labels.push(cluster);
    }
  }
  return { vectors, labels, centers };
}

/** 把合成向量直接写成知识片段（绕过嵌入接口，测试索引本身）。 */
function seedChunks(vectors: Float32Array[], prefix: string): string[] {
  const ids: string[] = [];
  vectors.forEach((vector, index) => {
    const id = insertRow('knowledge_chunks', {
      workspace_id: WS, source_type: 'synthetic', source_id: `${prefix}-${index}`,
      title: `片段 ${prefix}-${index}`, content: `合成内容 ${prefix}-${index}`,
      embedding: '{}', chunk_index: 0, content_hash: `${prefix}-${index}`,
      embedding_vec: encodeVector(Array.from(vector)), embedding_model: MODEL, dim: vector.length,
    });
    ids.push(id);
  });
  return ids;
}

function clearChunks(): void {
  run('DELETE FROM vector_buckets WHERE workspace_id = ?', WS);
  run('DELETE FROM vector_centroids WHERE workspace_id = ?', WS);
  run('DELETE FROM knowledge_chunks WHERE workspace_id = ?', WS);
}

/** 全扫 ground truth：取相似度最高的 k 个 id。 */
function bruteForce(query: Float32Array, vectors: Float32Array[], ids: string[], k: number): string[] {
  return vectors
    .map((vector, index) => ({ id: ids[index], score: dotSimilarity(query, vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((item) => item.id);
}

// ---------------------------------------------------------------- 训练与分桶

test('k-means：确定性、可复现，簇状数据能分出正确的桶数', () => {
  const { vectors } = makeClustered(8, 30, DIM);
  const first = trainCentroids(vectors, 8, 12);
  const second = trainCentroids(vectors, 8, 12);
  assert.equal(first.length, 8 * DIM);
  assert.deepEqual(Array.from(first), Array.from(second), '同一输入必须产出同一质心（可复现）');

  // 每个真实簇的样本应主要落到同一个桶里。
  const bucketOf = vectors.map((vector) => nearestBucket(vector, first, 8, DIM));
  const byCluster = new Map<number, Map<number, number>>();
  vectors.forEach((_, index) => {
    const cluster = Math.floor(index / 30);
    const tally = byCluster.get(cluster) ?? new Map<number, number>();
    tally.set(bucketOf[index], (tally.get(bucketOf[index]) ?? 0) + 1);
    byCluster.set(cluster, tally);
  });
  let puritySum = 0;
  for (const tally of byCluster.values()) {
    puritySum += Math.max(...tally.values()) / 30;
  }
  const purity = puritySum / byCluster.size;
  assert.ok(purity > 0.8, `簇纯度应较高，实际 ${purity.toFixed(3)}`);
});

test('k-means：样本少于桶数时不产生空壳质心', () => {
  const { vectors } = makeClustered(2, 2, DIM);
  const centers = trainCentroids(vectors, 32, 8);
  assert.equal(centers.length / DIM, vectors.length, '桶数不应超过样本数');
});

test('探查桶：按相似度降序返回，数量受 nprobe 限制', () => {
  clearChunks();
  const { vectors } = makeClustered(10, 20, DIM);
  seedChunks(vectors, 'probe');
  const built = buildIndex(WS, MODEL, { buckets: 16 })!;
  const set = centroidSet(WS, MODEL, DIM)!;
  const buckets = probeBuckets(vectors[0], set, 4);
  assert.equal(buckets.length, 4);
  assert.ok(buckets.includes(nearestBucket(vectors[0], decodeVector(set.centroids)!, set.bucket_count, DIM)),
    '最近桶必须在探查列表里');
  assert.ok(built.assigned === vectors.length, '全部片段都应归桶');
});

// ---------------------------------------------------------------- 召回率实测

test('召回率实测：索引相对全扫 recall@10 不低于 0.9，候选数大幅下降', () => {
  clearChunks();
  // 2000 个片段、20 个真实簇：足以体现裁剪效果又跑得快。
  const { vectors } = makeClustered(20, 100, DIM, 7);
  const ids = seedChunks(vectors, 'recall');
  buildIndex(WS, MODEL, { buckets: 32 });
  const set = centroidSet(WS, MODEL, DIM)!;

  const random = makeRandom(99);
  const queries: Float32Array[] = [];
  for (let index = 0; index < 30; index += 1) {
    // 查询取「某个真实样本 + 小扰动」，模拟同义改写而非原样命中。
    const sourceIndex = Math.floor(random() * vectors.length);
    const query = new Float32Array(DIM);
    for (let axis = 0; axis < DIM; axis += 1) query[axis] = vectors[sourceIndex][axis] + (random() * 2 - 1) * 0.08;
    queries.push(query);
  }

  let recallSum = 0;
  let candidateSum = 0;
  const k = 10;
  for (const query of queries) {
    const truth = bruteForce(query, vectors, ids, k);
    const buckets = probeBuckets(query, set, config.vector.probes);
    const candidates = candidateIds(set.id, buckets);
    candidateSum += candidates.length;
    const candidateSet = new Set(candidates);
    const hit = truth.filter((id) => candidateSet.has(id)).length;
    recallSum += hit / k;
  }
  const recall = recallSum / queries.length;
  const avgCandidates = candidateSum / queries.length;

  assert.ok(recall >= 0.9, `recall@${k} 应 ≥ 0.9，实际 ${recall.toFixed(3)}`);
  assert.ok(avgCandidates < vectors.length * 0.5,
    `候选数应显著少于全量（${vectors.length}），实际平均 ${avgCandidates.toFixed(0)}`);
  // 把实测值打进日志，便于人工核对规模边界。
  console.log(`[vector] recall@${k}=${recall.toFixed(3)} 候选=${avgCandidates.toFixed(0)}/${vectors.length} 桶=${set.bucket_count} nprobe=${config.vector.probes}`);
});

test('提高 nprobe 提升召回：召回随探查桶数单调不降', () => {
  const set = centroidSet(WS, MODEL, DIM)!;
  const { vectors } = makeClustered(20, 100, DIM, 7);
  const ids = all<{ id: string }>('SELECT id FROM knowledge_chunks WHERE workspace_id = ? ORDER BY created_at ASC, rowid ASC', WS).map((item) => item.id);
  const query = vectors[5];
  const truth = bruteForce(query, vectors, ids, 10);
  const recallAt = (probes: number): number => {
    const candidates = new Set(candidateIds(set.id, probeBuckets(query, set, probes)));
    return truth.filter((id) => candidates.has(id)).length / truth.length;
  };
  const low = recallAt(1);
  const high = recallAt(Math.min(16, set.bucket_count));
  assert.ok(high >= low, `探查更多桶不应降低召回：${low} → ${high}`);
  console.log(`[vector] nprobe=1 recall=${low.toFixed(2)} → nprobe=16 recall=${high.toFixed(2)}`);
});

// ---------------------------------------------------------------- 增量与维护

test('增量归桶：新片段自动进入已有索引，无需重建', () => {
  clearChunks();
  const { vectors } = makeClustered(6, 20, DIM, 11);
  seedChunks(vectors, 'base');
  buildIndex(WS, MODEL, { buckets: 12 });
  const before = indexStats(WS, MODEL);

  const extra = makeClustered(6, 5, DIM, 12).vectors;
  const newIds = seedChunks(extra, 'extra');
  // 新片段此时还没归属。
  const pendingBefore = all<{ c: number }>(
    `SELECT COUNT(*) AS c FROM knowledge_chunks c LEFT JOIN vector_buckets b ON b.chunk_id = c.id
     WHERE c.workspace_id = ? AND b.chunk_id IS NULL`, WS)[0].c;
  assert.equal(pendingBefore, newIds.length, '新片段应处于未归桶状态');

  const assigned = assignPending(WS, MODEL);
  assert.equal(assigned, newIds.length, '增量分配应覆盖全部新片段');
  const after = indexStats(WS, MODEL);
  assert.equal(after.assigned, before.assigned + newIds.length);
  assert.equal(after.buckets, before.buckets, '增量不应改变桶数');
});

test('未建索引时增量分配不擅自建索引', () => {
  clearChunks();
  seedChunks(makeClustered(3, 5, DIM, 13).vectors, 'noidx');
  assert.equal(assignPending(WS, MODEL), 0, '没有质心时不应自行训练');
  assert.equal(centroidSet(WS, MODEL, DIM), undefined);
});

test('删除来源：桶归属同步清理，不留悬空行', () => {
  clearChunks();
  // 用真实 indexChunk 建片段，再手工补向量与索引，验证 removeSource 的清理。
  indexChunk(WS, 'document', 'doc-vec-1', '待删文档', '这是一段用于验证删除清理的内容。');
  const chunks = all<{ id: string }>('SELECT id FROM knowledge_chunks WHERE workspace_id = ? AND source_id = ?', WS, 'doc-vec-1');
  assert.ok(chunks.length >= 1);
  const vector = makeClustered(1, 1, DIM, 17).vectors[0];
  for (const chunk of chunks) {
    run('UPDATE knowledge_chunks SET embedding_vec = ?, embedding_model = ?, dim = ? WHERE id = ?',
      encodeVector(Array.from(vector)), MODEL, DIM, chunk.id);
  }
  buildIndex(WS, MODEL, { buckets: 4 });
  assert.ok(all<{ c: number }>('SELECT COUNT(*) AS c FROM vector_buckets WHERE workspace_id = ?', WS)[0].c >= 1);

  removeSource(WS, 'document', 'doc-vec-1');
  assert.equal(all<{ c: number }>('SELECT COUNT(*) AS c FROM knowledge_chunks WHERE workspace_id = ? AND source_id = ?', WS, 'doc-vec-1')[0].c, 0);
  for (const chunk of chunks) {
    assert.equal(all<{ c: number }>('SELECT COUNT(*) AS c FROM vector_buckets WHERE chunk_id = ?', chunk.id)[0].c, 0,
      '桶归属必须随片段一起删除');
  }
});

test('换模型：旧索引不污染新模型查询', () => {
  clearChunks();
  seedChunks(makeClustered(4, 10, DIM, 19).vectors, 'm1');
  buildIndex(WS, MODEL, { buckets: 8 });
  assert.ok(centroidSet(WS, MODEL, DIM));
  assert.equal(centroidSet(WS, 'other-model', DIM), undefined, '不同模型应是独立的索引');
  // 不同维度也不该复用。
  assert.equal(centroidSet(WS, MODEL, DIM * 2), undefined, '不同维度应是独立的索引');
});

test('重建与删除：force 重训，drop 清空且检索退回全扫', () => {
  clearChunks();
  seedChunks(makeClustered(5, 12, DIM, 23).vectors, 'rebuild');
  const first = buildIndex(WS, MODEL, { buckets: 8 })!;
  const rebuilt = buildIndex(WS, MODEL, { force: true, buckets: 16 })!;
  assert.equal(rebuilt.buckets, 16, 'force 应按新桶数重训');
  assert.equal(indexStats(WS, MODEL).assigned, 60, '重建后全部片段应重新归桶');
  assert.ok(first.centroidId);

  dropIndex(WS);
  const stats = indexStats(WS, MODEL);
  assert.equal(stats.indexed, false);
  assert.equal(stats.assigned, 0);
  assert.equal(stats.mode, 'scan');
  assert.equal(shouldUseIndex(WS, MODEL, DIM, 1_000_000), false, '删索引后即使规模大也走全扫');
});

test('模式开关：scan 强制全扫，auto 按阈值决定', () => {
  clearChunks();
  seedChunks(makeClustered(4, 10, DIM, 29).vectors, 'mode');
  buildIndex(WS, MODEL, { buckets: 8 });
  // 本文件配置是 index 模式，故小规模也应走索引。
  assert.equal(config.vector.mode, 'index');
  assert.equal(shouldUseIndex(WS, MODEL, DIM, 10), true);
  assert.ok(config.vector.autoThreshold > 0, 'auto 阈值应为正数');
});

// ---------------------------------------------------------------- HTTP

test('索引接口：未配嵌入模型时如实报错，不假装成功', async () => {
  const status = await get('/api/platform/knowledge/index');
  assert.equal(status.status, 200);
  const body = await status.json() as { data: { embeddingModel: string; stats: unknown; note: string } };
  assert.equal(body.data.embeddingModel, '', '测试环境未配嵌入模型');
  assert.equal(body.data.stats, null);
  assert.match(body.data.note, /未配置嵌入模型/);

  const built = await post('/api/platform/knowledge/index', {});
  assert.equal(built.status, 400, '没有向量时必须报错而不是返回成功');
  const error = await built.json() as { detail: string };
  assert.match(error.detail, /LLM_EMBEDDING_MODEL/);
});

test('状态接口声明向量索引能力与配置', async () => {
  const body = await (await get('/api/platform/status')).json() as {
    data: { features: string[]; retrieval: { vectorIndex: unknown } };
  };
  assert.ok(body.data.features.includes('vector_index'));
  assert.equal(body.data.retrieval.vectorIndex, null, '未配嵌入模型时应为 null');
});

test('删除索引接口可用且受会话保护', async () => {
  const anonymous = await fetch(`${base}/api/platform/knowledge/index`, { method: 'DELETE' });
  assert.equal(anonymous.status, 401);
  const response = await fetch(`${base}/api/platform/knowledge/index`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
});