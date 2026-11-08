---
id: papers
type: module-design
status: draft
title: 论文整理 · 文献库、BibTeX 导入与三种导出
parent: architecture
depends-on:
  - shared-kernel
  - ai-layer
  - activity
  - auth
---

## 职责

一个本机文献库：增删改查、按关键词/标签/阅读状态筛选、BibTeX 导入、BibTeX / RIS / APA 三种格式导出，以及三种 AI 产出（研究脉络、综述大纲、综述初稿）。

## 边界

- **允许**：`shared/*`、`ai/provider`、`activity`；控制器层需要 `auth` 的 `currentUserId`。
- **禁止**：`documents`（综述不落文档库）、`research`（文献与实验是两套实体）。
- **被谁调用**：前端页面、`workspace` 的 `paper.review` 自动化动作、`platform/rag.ts` 的 `reindex`（直接 `SELECT` papers 表）。注意 `platform` 里有一个**同名但不同实现**的工具 `paper_review`：它由 `TASK_KINDS` 自动生成，`run` 直接调 `generate`，**不经过本模块**——payload 取决于调用参数，改这里不会影响它。

## 关键决定

- **标签是 JSON 数组字符串，筛选靠 `tags LIKE '%tag%'`**：不是关联表，也没有索引。因此按标签筛选是**子串匹配**——`LLM` 会命中 `LLMs`，也不会命中写成 `"大模型"` 的标签。
- **导入去重按标题完全相等**：`countByTitle(userId, title)` 是 `title = ?`，所以同一篇文献换了大小写、副标题或年份都会被当成新条目再插一次。
- **BibTeX 键在导出时现算**：`第一作者拉丁字母 + 年份 + 列表下标`，下标来自当前列表顺序。两处退化：作者名里的**非拉丁字符会被剥掉**，中文第一作者（如「张三」）得到空串后回落成 `ref`，所以中文文献的 key 实际只剩 `ref{年份}{下标}`；而**导入更多文献会让已有条目的 key 变化**。
- **导出不接筛选，但仍受列表的 300 行上限约束**：`GET /export` 只接受 `format`，不接 `q/tag/status`；而它走的是同一个 `list()`，仓储带 `LIMIT 300`——库存 350 篇时导出的 `.bibtex` 会静默少于库内篇数。
- **AI 只看前 40 篇，而且前端另有一份同样的截断**：`papersService.ai` 传 `papers.slice(0, 40)`（按列表顺序，年份倒序，所以文献多时综述只覆盖最近一批）；但**产品 UI 不走 `POST /api/papers/ai`**，`client/pages/Papers.tsx` 自己 `slice(0, 40)` 后打 `/api/agent/run`。两处必须同步改，否则改服务端等于没改。AI 输出不落库。

## 已知问题

- **`PATCH` 只改传入字段**：`updateSchema` = `partialOf(createSchema)`（剥掉字段默认值再整体可选）。曾经直接复用 `createSchema.partial()`，导致「推进状态」「保存笔记」会把摘要、标签、评分清空——新增字段时请继续走 `partialOf`。
- **一次导入会写出 N+1 条流水**：`importBibtex` 对每篇新文献都调 `this.create`，所以导入 N 篇会先写 N 条 `paper/create` 再加 1 条 `paper/import`。其他写操作（`create`/`update`/`delete`/`ai`）各一条。
- **`papersRepository.update` 找不到行时静默返回**：目前靠 service 先 `get()` 抛 `NotFoundError` 兜住。
- **`stats` 与导出现在都是全量**：仓储把「全量读取（`all`）」与分页（`page`）」分开了——`stats`/`export`/`ai` 走全量，列表接口走分页。曾经的 `LIMIT 300` 会同时截断统计与导出，已修。
- **列表分页**：`GET /api/papers` 回 `{ items, total, limit, offset }`（默认 20、上限 100）；关键词搜索是 `title/authors/abstract/venue` 四个 `LIKE '%q%'`。
- **`year` 的可写范围与显示口径不一致**：接口限制 1500–2200，但 APA 导出对 `null` 年份写「年份待补充」，BibTeX 里 `year` 留空——同一篇缺年份的文献在三种格式里长得不一样。
- **导出文件名固定且带原始扩展名**：`references.bibtex` / `references.ris` / `references.txt`（`format` 直接拼进名字，只有 APA 换成 `.txt`），多份导出会互相覆盖（浏览器另存时靠重名后缀区分）。
- **没有自动化测试**：导入去重、三种导出格式、AI 的 40 篇截断都只有 `scripts/smoke.ts` 里「导出包含 `@article`」一条断言。
