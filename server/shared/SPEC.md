---
id: shared-kernel
type: module-design
status: draft
title: 共享内核 · 配置、数据库、HTTP 管线、加密与日志
parent: architecture
---

## 职责

服务器侧的公共地基，不含任何业务语义：从环境读出配置，把 SQLite 打开并跑迁移，给 HTTP 请求套上 requestId / 结构化日志 / 统一错误信封 / 限流，提供密码哈希与会话签名（及凭据的对称加密），提供 Markdown → HTML 渲染，给路由层提供 Zod 校验适配器，以及灌入演示数据（幂等键是 **documents 表是否为空**）。

## 边界

- **允许**：`node:*` 内置模块；`express`（HTTP 管线与 Request/Response 类型）与 `zod`（校验适配器，`validate.ts`）；`shared/` 内部互引。
- **禁止**：被业务域带来的反向依赖。`features/*`、`ai/*` 都可以导入 `shared/*`，`shared/*` 不应知道任何业务域——**现状有一处例外**：`shared/seed.ts` 导入 `features/auth/auth.service.ts`（种子流程末尾要调 `authService.cleanup()`）。演示数据的表清单（documents/datasets/papers/projects/experiments/tasks/messages/activity/automation_tasks/connectors）也直接写在 seed 里，等于让共享层知道了每个域的表结构；这是一处待收拢的耦合。
- 领域「不重复发明这里已有的东西」是**约定而非强制**：不应自己读 `process.env`（走 `config`）、不应抛裸 `Error`（用 `AppError` 子类）、不应自己拼 error JSON（用 `errorHandler`）。这三条都有现实违反者，列在下面的已知问题里。

## 关键决定

- **手写 `.env` 解析而不是引 `dotenv`**：只有 KEY=VALUE、注释和去引号三条规则，十几行；少一个运行期依赖。
- **`APP_SECRET` 双轨**：**配置了但短于 16 字符，在任何环境都启动失败**；**完全未配置**时，开发环境自动生成 32 字节写入 `.data/secret.key`（mode 0600）并复用，生产环境则启动失败。密钥同时用于会话 HMAC 与凭据 AES-256-GCM（经 SHA-256 派生），所以轮换它等于让所有会话、已存的邮箱密码与连接器 token 全部失效。
- **会话是「签名 Cookie + 服务端会话表」双检**：Cookie 里只有 `{sid, exp}` 与 HMAC，撤销靠删 `sessions` 行，而不只是等过期。
- **迁移只追加**：启动时按文件名排序逐文件执行，每文件一个事务，成功后写 `schema_migrations`。改已应用的迁移不会生效。
- **日志是单行 JSON**：level/time/msg/request_id 加业务字段，error 走 stderr；requestId 用 `AsyncLocalStorage` 隐式透传，业务代码不需要传参。
- **错误分两类**：`AppError` 子类（isOperational）回具体 code/status/detail；其他一律 500「服务内部错误」，堆栈只进日志不进响应。

## 已知问题

- **限流器是模块级 `Map` 且从不淘汰**：键是 `ip:path`，长期运行会无界增长；多进程部署时各自计数，起不到全局限流。
- **配置项一览（都在 `config` 上）**：`PORT`/`HOST`（监听）、`CLIENT_ORIGIN`、`APP_SECRET`、`ADMIN_USERNAME`/`ADMIN_PASSWORD`、`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`、`DATABASE_PATH`，以及 **`config.ai.dailyLimit`**（`AI_DAILY_LIMIT`，默认 200）——平台会话的每日模型调用配额。它统计的是 `model_usage` 行数，而只有平台写这张表，所以**不是全站 AI 预算**。
- **`settings` 表建而不用**（`001_init.sql`），配置全走环境变量。
- **「不读 `process.env`、不抛裸 `Error`」这条约定已被违反**：
  - **已接线**：`auth.middleware.ts:18` 的 `currentUserId` 在缺会话时抛裸 `Error`。
  - **休眠中（全在未接线的 `platform/`）**：`platform/engine.ts:30` 与 `platform.service.ts:14` 直读 `AI_DAILY_LIMIT`；`platform/tools.ts:112`（工具名非法）与 `platform/store.ts:14`（`assertTable` 未知表名）抛裸 `Error`；`platform/store.ts:74` 的 `requireRole` 抛「带 `status: 403` 的普通 Error」，接线后会被 `errorHandler` 记成 500 而不是 403。接线前应一并收拾。
  - **已修**：`decryptSecret` 曾经整段裸抛（三段不齐 / IV 非法 / tag 非法 / GCM 校验失败四个失败点），现在包成 `AppError('CREDENTIAL_DECRYPT_FAILED', 500)`，调用方拿到可操作的 detail。
- **导入即产生副作用，两个文件都是**：`config.ts` 在模块初始化时就完成环境解析、密钥校验与（开发下）密钥文件生成——`NODE_ENV=production` 而缺 `APP_SECRET` 时，**仅仅 import `shared/crypto.ts` 就会抛出**「APP_SECRET is required in production」；`database.ts` 在初始化时就 `mkdir` 并打开/新建 `.data/mirelth.db`，同时 `PRAGMA` 设好 WAL/外键/超时。因此任何测试或脚本一旦 import 到这两个模块（间接也不行），就会在 cwd 生 `.data/secret.key` 与 `.data/mirelth.db` 并复用它们——**默认开发环境不会因此失败**，真正的约束是两块磁盘副作用，以及 `NODE_ENV=production` 且缺 `APP_SECRET` 时的抛错。写迁移幂等或 `decryptSecret` 单测时要先把这一层拆开，或改为在临时 cwd 下跑。
- **入站校验有两个入口，语义不同**：`validateBody` 用原 schema，默认值照常生效（新建记录要拿默认值）；PATCH 一律用 `partialOf(schema)`——它逐个剥掉字段的 `.default()` 再 `.optional()`，使「没传」在解析结果里保持缺席。**新增或修改 PATCH 路由时应使用 `partialOf`**：Zod 的 `.partial()` 不剥默认值，误用就会让未传字段被写成默认值（这正是修过的一批数据丢失缺陷的根因）。
- **错误信封只有 `sendError` 一个出口**：`errorHandler` 的 `AppError` 分支、限流 429、`/api` 404 都经它写出 `{title,status,detail,errors?,request_id}`。新增错误响应时不要再手写 `res.json`——信封一旦分叉，用户贴的 `request_id` 就对不上日志。
- **body-parser 的 4xx 会被映射成 `AppError`**：`asClientError` 把带 `status` 的 4xx 转正——畸形 JSON → 400 `BAD_REQUEST`，超过 12MB → 413 `PAYLOAD_TOO_LARGE`，其余 4xx → 400「请求格式不正确」。不把上游 `err.message` 拼进 detail（会带出解析器内部描述）。
- **测试覆盖了四类，但要紧的几项仍无断言**：`npm test` 跑三个文件——`regression.test.ts`（`partialOf` 的四个 update schema、`decryptSecret` 的错误类型、CSV 的两处报错与空值口径、离线引擎的大纲与文档摘要）、`db.test.ts`（临时库上验证 `insertSent` 如实记录发件人）、`http-errors.test.ts`（HTTP 层：畸形 JSON、未知路径、限流 429 的信封形状，以及外键冲突转 404）。**迁移幂等与限流窗口边界仍未覆盖**。
- **`logger.ts` 自己读 `process.env.NODE_ENV`**，与「配置单点」约定不一致（只是拿一个布尔判断是否输出 debug）。
- **Markdown 渲染器有两份**：`server/shared/markdown.ts`（含 `exportHtml`）与 `client/lib/markdown.ts`（64 行，仅 `renderMarkdown`）逐行等价但各自演化。只改一侧时，「导出的 HTML 文件」与「站内预览」会静默分歧——与 `ai-layer` 在 `TaskKind`、运行模式处点出的问题是同一类双真相源。
- **requestId 采信客户端传值**：`http.ts:10-11` 会直接采用请求头里合法的 `x-request-id`（仅 `/^[\w-]{1,64}$/` 校验）。代理或客户端固定发同一个值时，所有请求共享一个 id，按 id 检索日志会串号，上面那条「靠 request_id 对日志」的说法因此只在客户端不传该头时成立。
- **演示数据的幂等键只有 documents**：`seedDemoData` 的守卫是 `documents` 表是否为空（`seed.ts:10`），所以把文档删空后重启，会再插一遍 datasets/papers/projects/experiments/tasks/messages/activity（`seedWorkspaceApps` 另有自己的守卫，不会重复）。
- **`validateQuery` 未接线且无法工作**：`validate.ts` 导出了它，但没有任何路由使用，且在 Express 5 下 `req.query = …` 是只读访问器，赋值会抛 TypeError。入站校验实际只有 body 一条路径（见 `architecture` 约束 #2）。
- **`logger.ts` 自己读 `process.env.NODE_ENV`**
