---
id: agent-api
type: module-design
status: draft
title: 智能体端点 · 无状态的生成与流式接口
parent: architecture
depends-on:
  - shared-kernel
  - ai-layer
  - activity
  - auth
---

## 职责

把 AI 层直接暴露给前端的三个无状态端点：`GET /status`（当前模式与模型）、`POST /generate`（一次性生成）、`POST /run`（SSE 流式生成）。没有会话、没有工具调用、没有历史——调用方每次自带 `kind + input`。

## 边界

- **只有 controller 一个文件**：没有表、没有 repository、没有 service。它做的三件事是：Zod 校验 `kind`、调 `ai/provider`、记一条活动流水。
- **允许**：`ai/provider`、`ai/prompts` 的类型、`shared/*`（http、validate、logger）、`activity`、`auth` 的 `currentUserId`。
- **禁止**：任何业务 service。想要「文档 AI」的语义，前端自己拼 payload——**文档、文献、科研、分析与智能体抽屉都打 `/api/agent/run`**；邮件分流：**回复草稿走 `/api/agent/run`（`streamTask('mail.reply')`）**，而**摘要与起草走 `/api/mail/ai`**（`mailService.ai`）。收紧 kind 白名单或 payload 形状时，邮件回复按钮会直接挂掉。
- **与 `platform` 的区别**：`/api/platform/chat` 是有状态、会调工具、带配额的会话式智能体（已挂载）；这里是「单次生成 + 流」。两条路径只有前者用到了工具调用。

## 关键决定

- **SSE 用 POST + 手写帧**：`res.writeHead` 直接设 `text/event-stream`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`，然后按 `event: meta|delta|done|error` + `data: <json>` 写帧。**失败也返回 200**——先发 `meta`，流中途出错再发 `error` 帧并 `res.end()`，状态码无法再改。
- **`kind` 是白名单**：`z.enum(taskKinds)` 在控制器里复制了一份任务清单，非法 kind 直接 422；但这份清单要与 `ai/prompts.ts` 的 `TaskKind` 手抄同步（见 `ai-layer`）。
- **限流 40 次/分钟**，按 `ip:path` 计数；`generate` 与 `run` 各自独立计数。
- **活动流水分两种**：`/generate` 记 `action='generate'`，`/run` 记 `action='stream'`，`module` 都是 `agent`。

## 已知问题

- **任务清单在这里被复制了一份**：`taskKinds` 数组与 `TaskKind` 联合类型、`platform/tools.ts` 的 `TASK_KINDS`、`client/lib/types.ts` 的同名类型共四份。
- **流式失败不留痕**：`/run` 只在成功时记流水；中途报错只写日志，`activity` 里看不到失败的生成。
- **没有取消语义**：客户端断开只会让 `res.write` 静默失败，生成循环仍会跑完（`ai/provider` 的 90 秒超时是唯一的止损）。
- **`/generate` 没有任何客户端使用**：前端一律走流式，这个一次性接口目前只有 `scripts/smoke.ts` 在打。
