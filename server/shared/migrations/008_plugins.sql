-- 008: 插件体系（P0 落库与工作区隔离 + P1 真实入参与敏感确认）
-- 替代此前「模块级 Map、重启即丢、跨工作区可见」的自定义工具。
-- 只追加表，不改历史迁移。

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- 工具名：模型看到的名字，工作区内唯一，且不得与内置工具重名。
  name TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'http',
  endpoint TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'POST',
  -- 真实入参 schema（JSON），替代此前写死的单个 query 字段。
  parameters_json TEXT NOT NULL DEFAULT '{}',
  auth_header_name TEXT NOT NULL DEFAULT '',
  auth_token_encrypted TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- 敏感插件（有外部副作用）：调用必须带 confirmed=true，与 browser 同门禁。
  confirmed_required INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER NOT NULL DEFAULT 8000,
  status TEXT NOT NULL DEFAULT 'untested',
  last_checked_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 工作区内工具名唯一：同名注册直接冲突，不做静默覆盖。
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugins_name ON plugins(workspace_id, name);
CREATE INDEX IF NOT EXISTS idx_plugins_scope ON plugins(workspace_id, enabled);

-- 插件调用留痕：只记目标 host 与结果，不记完整查询串、不记凭据。
CREATE TABLE IF NOT EXISTS plugin_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'success',
  detail TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_runs_scope ON plugin_runs(workspace_id, created_at);