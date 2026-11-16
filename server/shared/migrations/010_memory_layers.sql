-- 010: 四层记忆体系
-- working（会话短期）/ preference（用户偏好）/ semantic（事实与项目）/ episodic（执行经验）
-- 只追加列与表，不改历史迁移；旧记忆按 kind 自动归层，仍然可读可删。

ALTER TABLE memories ADD COLUMN layer TEXT NOT NULL DEFAULT 'semantic';
-- 会话短期记忆的归属会话；长期层为空。
ALTER TABLE memories ADD COLUMN conversation_id TEXT;
-- episodic 关联的运行记录，便于用户回溯「这条经验从哪来」。
ALTER TABLE memories ADD COLUMN run_id TEXT;
-- 命中次数与最近命中时间：用于同分时的排序，也让用户看得出哪条记忆真在用。
ALTER TABLE memories ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_hit_at TEXT;

-- 旧数据归层：preference 保持，fact/project 归入 semantic。
UPDATE memories SET layer = 'preference' WHERE kind = 'preference';
UPDATE memories SET layer = 'semantic' WHERE kind IN ('fact', 'project');

CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(workspace_id, user_id, layer);
CREATE INDEX IF NOT EXISTS idx_memories_conversation ON memories(conversation_id);

-- 会话短期记忆有 TTL，需要按过期时间批量清理。
CREATE INDEX IF NOT EXISTS idx_memories_expiry ON memories(expires_at);