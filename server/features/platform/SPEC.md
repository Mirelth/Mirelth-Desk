---
id: platform-subsystem
type: module-design
status: active
title: 平台子系统 · 工作区、协作、工具调用智能体与入站调用
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
  - auth
---

## 现状：全部挂载

`platform` 曾经分成「已挂载」与 `platform.deferred.ts` 两半。**deferred 文件已删除**，43 条路由全部在 `platform.controller.ts`，`app.ts` 注册为 `/api/platform`。

| 组 | 路由数 | 说明 |
| --- | --- | --- |
| 状态与工具 | 3 | `GET /status`、`GET /tools`、`POST /tools`（注册自定义工具） |
| 知识库 | 3 | 检索、添加、`reindex` |
| 会话与运行 | 5 | 会话列表/详情、`POST /chat`（SSE）、运行列表/详情 |
| 工作区与成员 | 5 | 工作区列表/新建、成员列表/添加/移除 |
| 智能体定义 | 4 | 列表、建、改、删 |
| 分享 / 评论 / 版本 | 7 | 都以 `documentId` 为轴；恢复版本前自动存快照 |
| 文件 | 4 | 列表、上传（base64，限 5MB）、下载、删除 |
| 事件 | 3 | `emit`、`webhook/:key`、最近事件 |
| 工作流 | 3 | 列表、保存、执行 |
| 审计与用量 | 2 | 只读，`admin` 起 |
| MCP | 1 | JSON-RPC 2.0 shim |
| 入站凭据 | 3 | 工作区 API Key 的列表、创建、撤销 |

## 鉴权分两路

- **会话路径**：`app.use('/api', authenticate)` 在前，工作区由 `resolveWorkspace(req)` 决定（入站 key 优先，其次 `?workspaceId=` 或 body，最后落到用户的默认工作区，首次访问懒建）。
- **入站路径**：`/webhook/:key` 与 `/mcp` 额外接受 `X-Api-Key`。`platform.auth.ts` 的 `apiKeyMiddleware` 挂在 `/api/platform` 且**必须先于会话中间件**；它只对这两条路径生效，其余路由即使带 key 也继续要求会话。通过后 `req.userId` 与 `req.apiKey` 都已就位，`authenticate` 见 `userId` 已存在就放行——auth 因此不需要反向依赖 platform。
- **角色模型**：`viewer < member < admin < owner`，`requireRole(workspaceId, userId, minimum)` 是唯一鉴权口。**入站 key 的角色是上限**：`assertKeyRole(req, minimum)` 在 webhook/mcp 里再卡一道，不会因为 key 属于 owner 就拿到 owner 权限。

## 入站凭据（工作区 API Key）

- 明文形状 `mdk_<prefix8>_<random>`，**只在创建响应里出现一次**；`workspace_api_keys` 表只存 `sha256` 摘要与给人看的 `prefix`，解析时回写 `last_used_at`。
- 角色上限是 `admin`：`owner` 意味着能管理 key 本身，不该由长期凭据持有。
- 撤销是置 `revoked_at` 而不是删行，列表里仍能看到「已撤销」。
- 迁移 `004_api_keys.sql` 建表；这是唯一一处新增表。

## 已上线的能力

- **状态**（`GET /status`）：AI 模式与模型、工具数、知识片段数、会话数、运行数、成员数、当日配额（`limit` / `used`）、能力清单 `features[]`。`features` 是**静态数组**，声明子系统支持什么；现在它与实际挂载一致。
- **知识库**（`/knowledge/*`）：中文二元切词 → 词袋向量（JSON 存 `embedding`）→ 检索时 LIKE 召回 + fts5 `MATCH` 召回取并集，再按余弦排序。`reindex` 把 7 类本机数据（文档、文献、数据集、邮件、实验、项目、附件）重新灌进索引。
- **会话与运行**（`/conversations`、`/runs`、`POST /chat`）：`runAgent` 是异步生成器，产出 `meta → step* → delta* → done|error`；在线走 `chatWithTools` 多轮工具调用（`max_steps` 夹在 1–8），离线走正则挑选工具。每次运行写一条 `agent_runs` + 若干 `agent_run_steps` + 一条 `model_usage`。
- **工作流**：`workflows` 存 nodes/edges，执行时**按 nodes 数组顺序**逐节点 `executeTool`，`edges` 被忽略。
- **事件**：`automation_events` 记录发射；匹配规则见下。

## 关键决定

- **事件按 `user_id + event_key` 匹配任务，不按 `workspace_id`**：自动化任务在创建时 `workspace_id` 是 NULL（`workspace.schema` 里有这个字段，界面不传），而事件总是发生在某个工作区里。按工作区匹配会让 `matched` 恒为 0——接上线等于接了个空壳。
- **MCP 直接回协议对象，不包 `{data}` 信封**：外部 MCP 客户端认的是 JSON-RPC 原文；这是 `architecture` 里「成功响应一律 `{data}`」的唯一例外，客户端 `api()` 也不消费它。
- **文件元数据与内容分开**：内容落 `.data/files/<id>`，行在 `files` 表；列表接口只回 `id/filename/mime/size/created_at`，**不回本机绝对路径 `path`**。
- **自定义工具注册在模块级 `Map` 里**：重启即丢、不按工作区隔离——所以界面上写明「重启后失效」，不假装它是持久配置。

## 数据形状的坑

`/status` 是 camelCase，但 `/conversations`、`/runs`、`/files`、`/events`、`/audit`、`/usage` 返回的是**数据库行原样**（`created_at`、`steps_count`、`tokens_estimate`、`duration_ms`）。前端类型必须照实写，否则 `formatDate(undefined)` 会静默显示为空。

## 已知问题

- **配额只数 `model_usage` 行数，且只有平台在写它**：`/api/agent/generate|run` 与自动化动作都直接调 `ai/provider`、一行不记，所以 `AI_DAILY_LIMIT` 只限平台会话，不是全站 AI 预算。`model_usage` 也没有清理策略。
- **`knowledge_fts` 与 `knowledge_chunks` 靠代码保持一致**（`indexChunk` 先删后插），没有触发器兜底；绕过 `rag.ts` 直接改表会让两者分叉。
- **RAG 不是语义检索**：二元切词 + 词袋余弦，召回依赖字面重叠；同义改写会直接丢掉。
- **`reindex` 直接 `SELECT` 七张业务表**：`documents`/`papers`/`datasets`/`messages`/`experiments`/`projects`/`files`——改这些表的列名会静默丢检索内容。
- **`emitEvent` 绕过 `workspaceService`** 直接读 `automation_tasks`；改那张表结构时两边都要改。
- **成员管理的前提是账号已存在**：`addMember` 按 `username` 找人，找不到回 404；建号入口在 `/api/auth/users`，且只有安装管理员能用（见 `auth`）。没有邀请、没有自助注册。
- **删账号不清业务数据**：`users` 没有被任何业务表外键引用，删号只清会话与成员关系，文档/邮件等行的 `user_id` 变成悬空引用。
- **`last_used_at` 每次解析都写一行**：入站调用频繁时 `workspace_api_keys` 会成为写热点；真要高频用该换成内存节流后再落库。
- **`requireRole` 对不存在的工作区返回 403 而不是 404**：`roleOf` 拿不到角色就按权限不足处理，调用方分不清「没这个工作区」与「没权限」。
