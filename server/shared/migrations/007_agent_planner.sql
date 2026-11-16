-- 007: 规划-执行-反思层
-- 只追加列，不改历史迁移；旧运行记录这些列取默认值，仍然可读。

ALTER TABLE agent_runs ADD COLUMN plan_json TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runs ADD COLUMN plan_origin TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runs ADD COLUMN revisions INTEGER NOT NULL DEFAULT 0;
-- 收尾原因：'' 正常结束 / step_limit 步数用尽 / timeout 墙钟超时。
ALTER TABLE agent_runs ADD COLUMN stopped_reason TEXT NOT NULL DEFAULT '';