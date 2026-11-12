---
id: ai-layer
type: module-design
status: active
title: AI 层 · 双通道生成、任务提示词与离线规则引擎
parent: architecture
depends-on: [shared-kernel]
---

## 职责

所有模型相关能力的唯一出口：把「任务类型 + 输入材料」变成内容。对调用方只暴露三种形态——一次性生成（`generate`）、流式生成（`streamTask` 返回 `AsyncGenerator<string>`）、带工具调用的对话（`chatWithTools`）。同时负责：任务类型的闭集与中文标签、每种任务的中文系统提示词、以及没有模型密钥时用规则拼出确定性内容。

## 边界

- **允许**：`shared/*`（config、errors、logger）。
- **禁止**：导入任何 `features/*`。AI 层不知道这些域的内部结构——它只认识 `TaskKind` 的字符串名（这些名字本身带着 `document.` / `mail.` 前缀），以及 `agent.chat` 里写死的五个模块中文名。所以「新增或重命名一个业务模块」确实需要改这一层，但只是改文案与路由关键词，不是引入依赖。
- **唯一发 LLM HTTP 的地方**：`provider.ts` 的 `liveStream` / `chatWithTools`。业务域组装 payload，不拼 HTTP、不碰 baseUrl/apiKey。`platform/` 的自定义工具会 `fetch` 用户配置的 Webhook，但模型调用仍走 `chatWithTools`——**不存在第二个 LLM HTTP 入口**。

## 三个文件的分工

- `prompts.ts` —— `TaskKind` 联合类型（17 种）、`TASK_LABELS`、`TASK_PROMPTS`、`buildMessages`。`BASE_PROMPT` 里立着「不编造」原则：一律简体中文、只用给定事实、信息不足标「待补充」。用户输入以 JSON 序列化进 user 消息，截断到 24000 字符。
- `provider.ts` —— 双通道切换与 `aiStatus()`。`liveStream` 走 `/chat/completions`（`stream: true`, 90s 超时），逐帧解析 `data:` SSE，坏帧只 warn 不中断。`chatWithTools` 只支持非流式 + `tool_choice: auto`，无密钥时直接抛 `UpstreamError`。
- `offline.ts` —— 规则引擎。按 `kind` 分派到 **17 个分支、13 个函数**：`analytics.report` 复用 `analyticsInsights`、`research.plan` 复用 `researchDesign` 再替换标题。所以改这两个函数会同时影响两个 kind 的输出。各自从 `input` 里取字段（标题、数据集统计、文献列表、实验记录表）拼 Markdown——但**渲染 fidelity 有已知缺陷**，见下方。**它不引入 input 之外的事实性数值、文献与引用**，但会输出固定模板内容：`documentDraft` 的推进方案表写着「第 1 周 / 第 2–3 周 / 第 4 周」，`researchDesign` 写着「质量总分（1–5 分）」「至少 2 名评审」，都不来自 input。再加上它确实会写模板化套话与承诺（`documentContinue` 整段是固定续写建议，`mailReply` 会写「由我负责汇总」，`paperSynthesis` 无条件断言共识与分歧）——所以离线产物是「不含凭空事实」，不是「内容全部来自你给的材料」。

## 关键决定

- **两个通道共享同一签名**：调用方写一次 `for await (const chunk of streamTask(kind, input))`，在线/离线在 provider 内部决定；**生成调用**因此没有 `if (hasKey)` 分支。（状态**展示**是另一回事，见已知问题。）离线通道把整段文本按 24 字符切块并 sleep 12ms，让前端流式渲染的代码路径被真实执行到。
- **`TaskKind` 是闭集而不是自由字符串**：路由层用 `z.enum(taskKinds)` 拦非法值；`TASK_LABELS` / `TASK_PROMPTS` 是 `Record<TaskKind, …>`，新增一种任务时类型检查会强制补齐这两张表。**离线分派不受保护**：`offlineGenerate` 的 `switch` 带 `default: '## 暂无法处理该任务'`，漏写分支不报错，而是让新任务在离线模式下静默降级——而离线正是默认安装。
- **上游错误分两种形状**：**非 2xx** 时 `UpstreamError` 带状态码与响应体前 300 字符；**无响应体**时（`provider.ts:36`）只带一句「模型服务未返回响应体」，既无状态码也无片段——别指望从这个消息里解析上游信息。**网络层失败只在 `chatWithTools` 漏掉归一化**：`liveStream` 把任何非 `UpstreamError` 都包成 `UpstreamError`（`provider.ts:64-68`），而 `chatWithTools` 没有这层 try/catch——DNS/连接失败或 90s 超时（`AbortSignal.timeout` 抛的是 DOMException `TimeoutError`，不是 TypeError）会原样逃出，调用方拿不到 `AppError` 的 code/status。它目前的唯一调用点 `platform/engine.ts` 自己 try/catch，会写失败 run 行并 yield `{type:'error'}`，所以细节不丢——但这是调用方的补救，不是 provider 的保证。

## 已知问题

- **任务清单被复制了四份**：`prompts.ts` 的 `TaskKind` 联合类型、`features/agent/agent.controller.ts` 的 `taskKinds` 数组、`features/platform/tools.ts` 的 `TASK_KINDS`、以及 **`client/lib/types.ts:3` 的同名 `TaskKind`**（被 `client/lib/api.ts` 与四个页面消费）。四者靠人肉同步：服务端删掉一个 kind 而客户端还留着时，前端仍能编译通过，直到调 `/api/agent/run` 才吃 422。
- **`.map(clip)` 的坑已修**：`offline.ts` 曾经有 7 处 `points.map(clip)`，`Array.map` 把数组下标当作 `clip(value, max)` 的 `max`，第一个元素被截到 0 字只剩「…」。现在都是 `.map((item) => clip(item))`——**新增用到 `clip` 的映射时不要再直接传函数名**。
- **`document.summarize` 有自己的函数**：曾经直接复用 `mailSummary`，于是文档摘要顶着「## 邮件摘要」与「**发件人**：文档」——现在是独立的 `documentSummarize`（一句话 / 关键要点 / 后续事项）。**不要把两个任务的输出函数再次合并**：它们的字段语义不同（邮件有发件人，文档有标题）。
- **离线引擎的 13 个生成函数只有 2 个有断言**（大纲、文档摘要）：它是「开箱即用」的承重墙，其余仍只靠 `scripts/smoke.ts` 间接触碰。
- **`chatWithTools` 与离线引擎不共享工具选择逻辑**：在线由模型决定调哪些工具，离线由 `platform/engine.ts` 里的正则猜（`pickOfflineTools`）。后者住在 platform 而不是这里，位置可疑。
- **运行模式被重算了四处**：`server/index.ts:22`、`auth.controller.ts:24`、`auth.controller.ts:42`、`activity.service.ts:45` 各自写 `config.llm.enabled ? 'live' : 'offline'`，一律不经 `aiStatus()`。改变模式的判定方式（例如支持多模型配置）时，这四处会静默落后于 provider——与上面 `TaskKind` 的四份副本同一类问题。
