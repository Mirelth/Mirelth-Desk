---
id: workspace-automation
type: module-design
status: draft
title: 自动化任务与连接器 · 触发、执行与调度
parent: architecture
depends-on:
  - shared-kernel
  - ai-layer
  - activity
  - auth
  - documents
  - analytics
  - papers
  - research
  - mail
---

## 职责

两件事共用一个目录、两张表：**自动化任务**（手动 / 定时 / 事件三种触发，7 种真实办公动作，保留运行记录）与**连接器**（内置模型/邮箱/存储状态 + 自定义 Webhook，带连通性测试）。再加一个每分钟 tick 的轻量调度器。

## 边界

- **允许**：所有同级业务 service（`documents`/`analytics`/`papers`/`research`/`mail`）、`ai/provider`、`shared/*`、`activity`。**在已上线的模块里，只有这里会横向调用多个业务域**（未接线的 `platform` 同样如此，但它不在线上）。
- **禁止**：`platform/*`。注意目录名歧义——这里的 `workspace` 指「办公自动化 + 连接器」，`platform` 里的 `workspace` 指「多工作区/成员」，两者无关。
- 两张表 `automation_tasks` 与 `connectors` 由本模块负责读写；**但两个都不是独占的**：`platform.emitEvent` 会绕过本模块直接 `SELECT id FROM automation_tasks WHERE workspace_id … AND event_key …` 挑出事件型任务再调 `runTask`；`shared/seed.ts` 也会在首次启动时直接 `INSERT` 这两张表（`seedWorkspaceApps`）。**所以改表结构时五个地方要一起看**：本模块、`platform`、`shared/seed.ts`，以及两个迁移文件——`002_automation.sql` 建了这两张表，`003_platform.sql` 又给 `automation_tasks` 追加了 `workspace_id`/`event_key`。在 `seed` 里撞上一条无默认值的 NOT NULL 列，会让下一支全新安装的进程在启动阶段直接报错；而把 `003` 当成「无用平台代码」删掉，会让全新安装的 `createTask` INSERT 报缺列。

## 关键决定

- **动作是 switch 分支，不是插件**：`AUTOMATION_ACTIONS` 是 7 项常量，`runTask` 里是一段 `switch (current.action)`，每种动作调对应 service。新增一种动作要同时改常量表与 switch，且 `createTask`/`updateTask` 会用常量表校验 `action` 是否受支持。
- **`runTask` 的真抛错路径有两条，不止「任务不存在」**：任务 id 查不到时抛 `NotFoundError`（在 try 之前）；此外 **try 之后的 `taskDto(workspaceRepository.task(userId, id)!)` 会重读该行**，若任务在 await 期间被删掉（例如 `document.draft` 的生成跑了几十秒）就会在非空断言上抛 TypeError。一旦进入 try，内部异常才被 catch 成 `{ ok: false, text: '执行失败：…', error }`，同时用 `recordRun` 写回 `last_status/last_result`（结果截断 4000 字符）并把 `run_count` 加一。**副作用**：`emitEvent` 与调度器都是串行 `await runTask(...)`，上面两条抛错都会中断本轮剩下的任务（调度器的情况见已知问题）。
- **下一轮时间只由 `interval_minutes` 推**：执行后 `next_run_at = now + interval`（非 interval 任务置 `null`），没有 cron 表达式、没有错过的补偿执行。
- **调度器是「每分钟扫一遍」**：`dueTasks` 取 `enabled = 1 AND next_run_at <= now LIMIT 20`（**无 ORDER BY**），逐个串行执行；`ticking` 布尔量防止上一轮未跑完时重入；`timer.unref()` 让它不阻止进程退出。
- **事件触发经 `platform.emitEvent`**：`automation_tasks.event_key` 只在被事件匹配时用到，事件入口在未接线的 `platform` 里——**当前没有任何已挂载的路由能触发事件型任务**。
- **连接器内置三项是现算的**：模型（看 `aiStatus`）、邮箱（看 `mailService.status`）、SQLite（恒为已连接）不落库，`id` 前缀 `builtin-`；自定义连接器才进 `connectors` 表。
- **连通性测试判 `response.ok`（2xx）**：`testConnector` 用 `fetch GET`，只有 2xx 算连接成功；401/403 报「鉴权失败」，其余非 2xx 报「地址可达但返回 HTTP …」。凭据解密失败不再是“静默不发 Authorization 头”，而是直接返回 `ok: false` 并把原因落库。

## 已知问题

- **`updateTask` 改不了 `workspace_id` 与 `event_key`**：PATCH 路由用的是 `updateTaskSchema`（无默认值的可选集），它接受这两个字段，service 也把它们传进仓储，但仓储的 `UPDATE` 语句里**没有这两列**——改了等于没改。
- **`testConnector` 也记流水了，而且会吵**：实现被抽成模块级 `performConnectorTest`，`testConnector` 变成「执行 + 记 `connector_test` + 返回」。每调一次连通性测试就会改 `status/last_checked_at/last_error` 并留一条流水。
- **`taskDto` 也不返回 `workspace_id`/`event_key`**：即使把仓储的 `UPDATE` 补齐，`GET /api/automation` 仍然看不到这两个字段，前端也无法回填——事件型任务的归属依旧不可见。
- **事件型任务可以被建出来，但永远不会执行**：`taskSchema` 接受 `triggerType: 'event'` 与 `eventKey`（界面不暴露），这类任务建的 `next_run_at` 是 `null`，调度器永远不会选到它们，而唯一的触发路径在未接线的 `platform` 里——没有任何提示。**即使接上线也不够**：`emitEvent` 按 `automation_tasks.workspace_id` 筛选，而现有任务全部 `workspace_id = NULL`（客户端从不传这个字段），结果就是 `matched: 0`。
- **两条 PATCH 用的是 `partialOf` 而不是 `*.partial()`**：Zod 的 `.partial()` 会保留字段默认值，曾经导致「启用/停用」开关把定时任务永久降为手动（`triggerType` 被填成 `manual`）、把自定义连接器的 `kind` 改回 `webhook` 并抹掉描述。新增字段时继续走 `partialOf`。
- **「更新即重算 `next_run_at`」是活路径**：`updateTask` 里算完 `triggerType ?? current.trigger_type` 后**无条件**算出 `nextRunAt` 并传给仓储（interval 推后一个周期，否则 `null`）。所以只 PATCH `{name}` 也会把定时任务的下次执行时间推到「现在 + 间隔」——重命名的副作用是延后执行。
- **调度器没有顺序与补偿**：`LIMIT 20` 无 `ORDER BY`，同一分钟内到期的任务超过 20 个时，其余要等下一分钟且可能反复饿死；进程停机期间错过的时间点不会补跑。
- **token 只有两种意图：不传 = 保留，传空串 = 清空**（前端把空输入转成 `undefined` 再发，所以 UI 不会误清空）；但也意味着没有「只改 token」的字段级入口，且清空是**破坏性的、无确认**的。
- **调度器逐任务隔离**：`scheduler.tick` 在循环体内逐任务 `try/catch`——某条到期任务在 `runTask` 期间被删（`NotFoundError`）或在 try 之后重读行失败（TypeError），只记一条 `automation.task_failed` 并继续下一条，不再连坐整批。
- **`runTask` 内部串行 await**：一次 tick 里 20 个任务全部待跑时，最坏情况会让下一分钟的 tick 被 `ticking` 挡掉。
