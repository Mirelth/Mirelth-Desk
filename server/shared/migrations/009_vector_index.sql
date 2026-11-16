-- 009: 向量检索索引（粗量化分桶 + 精排），替代大库全表扫。
-- 只追加表与列，不改历史迁移；未建索引时检索行为与旧版完全一致。

-- 每个「工作区 + 模型 + 维度」一套质心。换嵌入模型即换一行，旧索引不污染新查询。
CREATE TABLE IF NOT EXISTS vector_centroids (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  bucket_count INTEGER NOT NULL,
  -- 质心矩阵：bucket_count * dim 个 Float32 小端。
  centroids BLOB NOT NULL,
  trained_on INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_centroids_scope ON vector_centroids(workspace_id, model, dim);

-- 片段到桶的归属。查询时先按桶取候选，再精排。
CREATE TABLE IF NOT EXISTS vector_buckets (
  chunk_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  centroid_id TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_buckets_lookup ON vector_buckets(centroid_id, bucket);
CREATE INDEX IF NOT EXISTS idx_buckets_scope ON vector_buckets(workspace_id);

-- 知识片段记下所属桶，便于增量分配与统计（真正的查询走 vector_buckets 的索引）。
ALTER TABLE knowledge_chunks ADD COLUMN bucket INTEGER NOT NULL DEFAULT -1;