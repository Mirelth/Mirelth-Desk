-- 006: 语义检索与记忆升级
-- 只追加列，不改历史迁移；旧数据保持可读（词法 embedding 列保留用于降级）。

-- 知识片段：语义向量与分块元信息
ALTER TABLE knowledge_chunks ADD COLUMN embedding_vec BLOB;
ALTER TABLE knowledge_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_chunks ADD COLUMN dim INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_chunks ADD COLUMN chunk_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_chunks_source ON knowledge_chunks(workspace_id, source_type, source_id);

-- 记忆：去重、相关性与可过期
ALTER TABLE memories ADD COLUMN normalized_content TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN embedding_vec BLOB;
ALTER TABLE memories ADD COLUMN embedding_model TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN dim INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN expires_at TEXT;
ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(workspace_id, user_id);

-- 浏览器自动化：任务留痕（配置走环境变量与 settings 表之外的独立表，便于审计）
CREATE TABLE IF NOT EXISTS browser_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'success',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_browser_runs_scope ON browser_runs(workspace_id, user_id);