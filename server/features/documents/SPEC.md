---
id: documents
type: module-design
status: active
title: 文档协作 · 模板、AI 动作与导出
parent: architecture
depends-on: [shared-kernel, ai-layer, activity, auth]
---

## 职责

文档的增删改查与搜索、6 类办公模板、5 个 AI 动作（大纲/起草/润色/续写/摘要）、以及 Markdown / HTML 导出。AI 只产出文本，**不落库**——落库由调用方决定（前端拿到结果后自己 `PATCH`，自动化任务则调 `create` 存成新文档）。

## 边界

- **允许**：`shared/*`、`ai/provider`（`generate`）、`ai/prompts`（仅 `import type { TaskKind }`）、`activity`（写流水）；控制器层另需 `auth` 的 `currentUserId`（只限控制器，service 不碰会话）。
- **禁止**：直接读写 `document_shares` / `comments` / `document_versions` 三张表——它们属于 `platform` 的分享、评论与版本能力（但那张能力本身是通过 `documentsService` 读文档内容的）。反过来，**`platform/rag.ts` 的 `reindex` 会直接 `SELECT id, title, content FROM documents`**，这是一处已存在的直连（见 `platform-subsystem`）。本模块也不得调用任何 `mail`/`research` 的 service。
- **被谁调用**：前端页面、`workspace` 的 `document.draft` 自动化动作、`platform` 的 `document_save` 工具，以及 `platform` 的 `snapshot`（读）与 `restoreVersion`——后者通过 `documentsService.update` 直接覆写文档的标题与正文，平台接上线后，文档可能在没有任何本模块路由参与的情况下被改写。

## 关键决定

- **AI 的输入组装有三处，各自为政**：①服务端 `documentsService.ai`：`title` + 模板名（模板为空时用 `doc.kind`）+ 模板章节 + 现有正文 + 用户勾选的 `points`；②前端 `client/pages/Documents.tsx` 的 `runAi`：同形但回退值是固定的 `'通用文档'`，且直接打 `/api/agent/run`——**当前 UI 走的是这条，`POST /api/documents/:id/ai` 只有 `scripts/smoke.ts` 在打**；③自动化动作 `document.draft`（`workspace.service.ts`）：完全无视文档模板，硬编码 `template: '工作周报'`、`sections: []`、`points: []`、`content: ''`，然后 `create` 一份新文档。改 payload 形状时要同步三处，否则同一份材料能出三种结果。
- **模板是常量而非数据**：`DOCUMENT_TEMPLATES` 硬编码 6 项（weekly/proposal/minutes/report/email/general），每项带 `id/kind/name/description` 与 `sections` 章节名；**除标识与展示文案外只有章节名，没有正文模板**。`name` 参与 AI 输入组装，`description` 被选模板界面渲染，`GET /templates` 返回的就是这个数组。新增模板要改代码。
- **AI 的输入组装方式（服务端这条）**：`title` + 模板名（或 `kind`）+ 模板章节 + 现有正文 + 用户勾选的 `points`，整包交给 `generate`。所以 AI 的输出质量取决于「文档有没有按模板填章节」；前端那条同形但回退值不同，见上一条。
- **字数是非空白字符数**：`content.replace(/\s/g, '').length`，创建与更新时各算一次；中文按字、英文按字母，不是词数。
- **导出靠 `Content-Disposition: filename*=UTF-8''<encoded>`**：文件名里的 `/ \ : * ? " < > |` 被替换成 `_`；HTML 导出走 `shared/markdown.ts` 的 `exportHtml`（自带样式与标题）。

## 已知问题

- **列表分页**：`GET /api/documents` 回 `{ items, total, limit, offset }`（`pageQuery` 默认 20、上限 100）；搜索是 `title/content/tags` 三个 `LIKE '%q%'`，前端把 `q` 拼进请求路径，翻页由 `usePaged` 的「加载更多」驱动。
- **`kind` 与 `template` 是两个独立字段**：`template` 是模板 id、可为 `null`，`kind` 是自由字符串（默认 `general`）。AI 组装时优先用模板名，模板为空才退回 `kind`——两者可以不一致，没人校验。
- **`word_count` 只在创建/更新时算**：直接改库或迁移不会刷新 `word_count`。
- **仓储层的 `update` 找不到行时静默返回**：目前靠 service 先 `get()` 抛 `NotFoundError` 兜住；若将来有别的调用方直接用仓储，会变成「更新成功但什么都没发生」。
- **`PATCH` 只改传入字段**：`updateSchema` = `partialOf(createSchema)`（剥掉字段默认值再整体可选）。曾经直接复用 `createSchema.partial()`，导致只改标题会清空正文、把 `final` 打回 `draft`——新增字段时请继续走 `partialOf`。
- **`PATCH` 接受 `template` 但静默丢弃**：`documentsService.update` 的入参类型不含 `template`、仓储也不写这一列——换模板的请求能过校验并拿到 200，但模板永远不会改。
- **导出内容与站内预览同源但实现不同**：MD 导出就是把 `content` 原样吐出，HTML 导出用 `shared/markdown.ts`，而前端预览用 `client/lib/markdown.ts` 的副本（**服务端没有预览接口**，只有 `/:id/export`；见 `shared-kernel` 的双份渲染器条目）。
