-- 工作区入站凭据：给 `/webhook/:key` 与 `/mcp` 这类没有会话的外部调用方使用。
-- 只存 SHA-256 摘要，明文只在创建响应里出现一次；`prefix` 是给人看的识别段。
CREATE TABLE IF NOT EXISTS workspace_api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON workspace_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON workspace_api_keys(workspace_id, created_at);
