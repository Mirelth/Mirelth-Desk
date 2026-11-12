---
id: research
type: module-design
status: active
title: 科学研究 · 项目、实验记录与任务看板
parent: architecture
depends-on: [shared-kernel, ai-layer, activity, auth]
---

## 职责

三类实体的 CRUD 加看板视图：研究项目（名称/描述/目标/状态）、实验记录（假设/方法/结果/结论/指标/状态）、任务（标题/状态/优先级/截止日）。以及三种 AI 产出：实验设计、结果解读、研究计划。

## 边界

- **允许**：`shared/*`、`ai/provider`、`activity`；控制器层需要 `auth` 的 `currentUserId`。
- **禁止**：`analytics`（实验指标与数据集是两套东西，`metrics` 是手填的 `{name, value}` 数组）、`documents`。
- **被谁调用**：前端页面、`workspace` 的 `research.plan` 自动化动作、`platform/rag.ts` 的 `reindex`（直接 `SELECT experiments/projects`，取 `title/hypothesis/result/conclusion` 与 `name/objective/description`——改这些列名会静默丢检索内容）。`platform` 里另有一个**同名但不同实现**的工具 `research_plan`：它由 `TASK_KINDS` 自动生成、直接调 `generate`，**不经过本模块**，所以下面的 payload 描述只对 `researchService.plan` 成立。

## 数据形状

- `experiments.project_id` 与 `tasks.project_id` 都是**可空外键，`ON DELETE SET NULL`**（见 `001_init.sql`）：删项目不会删实验或任务，只会把它们变成「不属于任何项目」。
- `metrics` 存 JSON 数组，元素是 `{ name: string, value: number }`，最多 20 条。
- 任务排序在 SQL 里做：`doing` → `todo` → `done`，同组内按创建时间倒序。**它只决定列内顺序**；看板的**列序**来自客户端常量 `KANBAN`（未完 → 进行中 → 已完成，见 `client/pages/Research.tsx`）——前两列与 SQL 的 doing→todo 正好互换，`done` 两边都排末位。

## 关键决定

- **`overview` 一次返回全部三类**，不是三个分页接口：前端看板一次拿全量，`stats` 也在同一个响应里算。项目上的 `experimentCount`/`taskCount` 是 service 在内存里过滤出来再数的（`experiments.filter(...).length`），不是 SQL 聚合。
- **AI 的上下文就是数据库里的记录，但产品路径在前端**：`researchService.ai` / `researchService.plan` 分别把实验的 8 个键（标题、目标、假设、方法、结果、结论、指标、项目名）、项目字段+该项目实验与任务清单交给 `generate`；然而**前端不调 `/api/research/experiments/:id/ai` 与 `/projects/:id/plan`**，`client/pages/Research.tsx` 自己拼了同形 payload 打 `/api/agent/run`。所以「AI 知道多少」取决于这些字段填了没有，而改 payload 要同时改两处。
- **状态机是三个独立枚举、互不校验**：项目 `active/paused/archived`、实验 `planned/running/completed/abandoned`、任务 `todo/doing/done`。任务完成不会推进实验状态，实验完成也不会推进项目状态。

## 已知问题

- **写路径全部记流水了**：`updateProject`/`updateTask`/`deleteExperiment`/`deleteTask` 与 `create*`/`deleteProject`/`updateExperiment` 一致。
- **项目引用已统一校验**：`createProject` 之外的 `createExperiment` / `createTask` / `updateExperiment` 在 `projectId` 非空时都会先查项目是否存在，不存在就 404（以前只 `createExperiment` 查，其余两条会撞外键约束变 500）。
- **`updateTask` 改不了 `projectId`**：仓储的 patch 里没有 `project_id`，任务无法在项目之间移动。
- **`deleteProject` 把实验与任务变成孤儿**：外键是 `SET NULL`，它们会继续留在列表里但失去项目归属，且没有任何提示。
- **`overview` 每次都全表读三类实体**并按 `user_id` 过滤，无分页、无时间窗；实验和任务的正文都是大文本字段，几千条之后首页会变慢。
- **任务的更新与删除不校验存在性**：`updateTask`/`deleteTask` 既不查存在也不报 404（仓储里是 `if (!current) return` 与直接 `DELETE`）。跨标签页删掉任务后，看板拖拽 `PATCH /tasks/:id` 仍返回 200 且响应里**没有 `data` 键**（service 返回 `undefined`，`res.json` 会直接丢弃这个键），删除返回 `{ ok: true }`——用户看到成功而任务早已不存在。注意这与建任务的「不校验项目」是两个不同问题。
- **`updateProject`/`updateExperiment` 靠仓储里的 `if (!current) return` 兜「找不到」**，service 层先自查了一次，两处判断重复。
