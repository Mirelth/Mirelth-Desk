---
id: activity
type: module-design
status: draft
title: 活动流水与工作台概览
parent: architecture
depends-on:
  - shared-kernel
  - auth
---

## 职责

两件事，共用一个模块：**写**——各业务域把「谁做了什么」记成一条 `activity` 行；**读**——工作台概览（`GET /api/dashboard`）返回首页需要的全部计数与最近动态。

## 边界

- **没有 repository**：`activity.service.ts` 直接用 `shared/database.ts` 的 `all/get/run` 发 SQL。这与「controller → service → repository」的通用形状不同，是有意省的——只有一张表和几条固定语句。
- **允许**：`shared/*`（database、crypto 的 `newId/now`、config）。
- **禁止**：导入任何业务域的 service。它是被依赖方，不是依赖方。
- **依赖方向**：每个业务域的 service 在写操作后调用 `activityService.record(...)`（已覆盖全部已知写路径，见下一节的口径取舍）；`activity` 不反向依赖任何业务域，只向下依赖 `shared`，以及控制器里的 `currentUserId`（来自 `auth`）。

## 关键决定

- **活动流水用英文动作码 + 中文描述**：`module` 的逻辑枚举值有 7 个，但**实际写进去的很少**——绝大多数写操作记 `module='agent'`（`document_ai`/`analytics_ai`/`paper_ai`/`research_ai`/`mail_ai`/`automation_*`/`connector_*`），而枚举里的 `'system'` **从未被写入**。所以按 `module` 分组时，「智能体」里会混着各模块的 AI 与自动化动作。`action` 是调用方传入的**英文标识符**（`create`/`update`/`delete`/`sync`/`send`/`read`/`document_ai`/`automation_run` 等，没有约束表）；`description` 才是中文句子。三者都是自由字符串，没有类型或白名单。
- **概览是跨表聚合而不是物化视图**：`stats()` 一共发 **8 条** `COUNT`，覆盖 **7 张表**（`messages` 占两条），每次请求都现算。数据量在单机单用户下无所谓，但见下面的耦合问题。
- **计数口径不统一**：`tasks` 只数 `status != 'done'`，`unreadMail` 带 `folder = 'inbox' AND is_read = 0`，其余（documents/datasets/papers/projects/experiments/totalMail）是全量计数。读概览的人容易把 `unreadMail` 当成邮件总量。
- **AI 状态在这里也有一份**：`stats().ai` 返回 `mode/model/baseUrl`，与 `/api/agent/status` 的内容重叠，且模式是直接读 `config.llm.enabled` 而不是 `aiStatus()`（见 `ai-layer`）。

## 已知问题

- **概览直读 7 张业务表，是隐性耦合**：`documents`、`datasets`、`papers`、`projects`、`experiments`、`tasks`、`messages` 任何一张改表名或改 `user_id` 语义，工作台首页会静默报 0 或直接 500，而类型系统完全拦不住。
- **写入留痕已补齐，但是“全记”口径**：9 条曾经漏记的写路径（文献编辑、项目/任务/实验的改与删、自动化任务与连接器编辑、**每次连通性测试**、手动标记已读、**打开未读邮件的隐式已读**）现在都写流水。后两类是「读操作或探针只因实现而落库」，会明显刷屏——想把首页恢复成「只看内容变更」，删掉 `mail.setRead`/`mailService.get` 与 `testConnector` 那三处 `record` 即可。`scripts/activity.test.ts` 会因删掉而变红，需同步改。
- **同一操作会落到两个不同的动作码**：产品 UI 里文档/数据/文献/科研的 AI 动作实际都走 `/api/agent/run`，只留下 `module='agent', action='stream'`（同步接口 `/api/agent/generate` 记 `generate`）。模块专属动作码的产生源各不同：`analytics_ai` 来自 `POST /api/analytics/datasets/:id/insights`，`paper_ai` 来自 `POST /api/papers/ai`，`research_ai` 来自 `POST /api/research/experiments/:id/ai` 与 `POST /api/research/projects/:id/plan`，以及各自的自动化动作；**`document_ai` 只由 `POST /api/documents/:id/ai` 产生**（即 `scripts/smoke.ts`）——自动化的 `document.draft` 走的是 `generate` + `documentsService.create`，记的是 `document/create`。按 `action` 聚合会得到与用户感知不一致的结果。
- **`recent` 的条数在两处各写一遍**：`stats()` 取 8 条；`GET /api/dashboard/activity` 的控制器只做 `parseInt(...) || 20`，**100 的上限是在 `activity.service.ts` 的 `Math.min(Math.max(limit, 1), 100)` 里夹的**，不属控制器。
