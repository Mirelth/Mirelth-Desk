---
id: platform-subsystem
type: module-design
status: draft
title: 平台子系统 · 工作区、RAG、工具调用智能体与 MCP
parent: architecture
depends-on:
  - shared-kernel
  - ai-layer
  - documents
  - mail
  - workspace-automation
  - papers
  - analytics
  - research
---

## 现状：四组已上线，其余显式搁置

`platform` 曾经是「完整实现但无人引用」。现在它分成两半，边界写在文件名上：

- **已挂载**（`platform.controller.ts`，`app.ts` 注册为 `/api/platform`，10 条路由）：状态与配额、工具清单（只读）、知识库（检索/添加/重建）、会话与运行记录（含 `POST /chat` 的 SSE）。
- **未挂载**（`platform.deferred.ts`，31 条路由，**没有任何文件导入它**）：成员管理、工作流、文件、分享/评论/版本、事件、审计、用量、MCP、`/webhook/:key`。

不挂后三类的理由，写在 `platform.deferred.ts` 文件头，也是本 spec 的一部分：

1. **成员管理**与 `goal` 的非目标「多用户与协作」直接冲突——一次安装只有一个账号，挂上等于开一个永远只有 owner 的多用户入口。
2. **`/webhook/:key` 与 `/mcp`** 靠 `currentUserId` 定位调用者；外部系统没有会话，未登录时必 500。要让它们可用，需要先设计入站 key（绑定工作区与权限）。
3. **工作流/文件/分享/版本/事件/审计** 在单用户单机场景下价值低，且会把未验证的写路径一次性放上台面。

## 已上线的能力

- **状态**（`GET /status`）：AI 模式与模型、工具数、知识片段数、会话数、运行数、成员数、当日配额（`limit` / `used`）、能力清单 `features[]`。注意 `features` 是**静态数组**，声明的是子系统支持什么，不代表全部已挂载。
- **知识库**（`/knowledge/*`）：中文二元切词 → 词袋向量（JSON 存 `embedding`）→ 检索时 LIKE 召回 + fts5 `MATCH` 召回取并集，再按余弦排序。`reindex` 把 7 类本机数据（文档、文献、数据集、邮件、实验、项目、附件）重新灌进索引。
- **会话与运行**（`/conversations`、`/runs`、`POST /chat`）：`runAgent` 是异步生成器，产出 `meta → step* → delta* → done|error`；在线走 `chatWithTools` 多轮工具调用（`max_steps` 夹在 1–8），离线走正则挑选工具。每次运行写一条 `agent_runs` + 若干 `agent_run_steps` + 一条 `model_usage`。
- **工具清单**（`GET /tools`）：`generate` 类由 17 个 `TaskKind` 自动派生（名字把 `.` 换成 `_`），`action` 类 6 个（RAG 检索、存文档、同步邮件、列最新邮件、执行自动化、列文件）。

## 数据形状的坑

`/status` 是 camelCase，但 `/conversations` 与 `/runs` 返回的是**数据库行原样**（`created_at`、`steps_count`、`tokens_estimate`、`duration_ms`）。前端类型必须照实写，否则 `formatDate(undefined)` 会静默显示为空。

## 未上线部分的设计（改挂载时先读这里）

- **多工作区与角色**：`viewer < member < admin < owner`，`requireRole(workspaceId, userId, minimum)` 是唯一鉴权口；`defaultWorkspace(userId)` 在首次访问时懒建「默认工作区」并给 owner（注意它是**写事务**，被 `resolveWorkspace` 每个请求调用）。
- **工作流**：`workflows` 存 nodes/edges，执行时**按 nodes 数组顺序**逐节点 `executeTool`，`edges` 被忽略。
- **事件**：`automation_events` + `emitEvent` 按 `automation_tasks.workspace_id` 与 `event_key` 挑任务——但线上创建的任务 `workspace_id` 全是 `NULL`，所以即使接线 `matched` 也会是 0。
- **MCP**：一个最小 JSON-RPC 2.0 shim，支持 `initialize` / `tools/list` / `tools/call`。

## 已知问题

- **配额只数 `model_usage` 行数，且只有平台在写它**：`/api/agent/generate|run` 与自动化动作都直接调 `ai/provider`、一行不记，所以 `AI_DAILY_LIMIT` 只限平台会话，不是全站 AI 预算。`model_usage` 也没有清理策略。
- **`custom` 工具存在模块级 `Map` 里**：重启即丢、不按工作区隔离。注册路由目前未挂载，所以只影响 `GET /tools` 的可见性。
- **`knowledge_fts` 与 `knowledge_chunks` 靠代码保持一致**（`indexChunk` 先删后插），没有触发器兜底；绕过 `rag.ts` 直接改表会让两者分叉。
- **RAG 不是语义检索**：二元切词 + 词袋余弦，召回依赖字面重叠；同义改写会直接丢掉。
- **审计有缺口**：`updateAgent`/`deleteAgent` 与 `saveWorkflow` 的更新分支都不写 `audit_logs`（都在未挂载部分）。
- **`reindex` 直接 `SELECT` 七张业务表**：`documents`/`papers`/`datasets`/`messages`/`experiments`/`projects`/`files`——改这些表的列名会静默丢检索内容。
- **`emitEvent` 绕过 `workspaceService`** 直接读 `automation_tasks`；改那张表结构时两边都要改。
