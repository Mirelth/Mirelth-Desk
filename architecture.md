---
id: architecture
type: architecture-design
status: draft
title: 单体全栈拓扑与模块边界
parent: goal
depends-on:
  - goal
---

## 拓扑

一个 Node 进程同时是 API 与（生产下）前端静态宿主；开发下前端由 Vite 独立进程提供并把 `/api`、`/health`、`/ready` 代理到 API。

```
browser ── React SPA (client/, hash 路由)
   │  fetch(credentials: include) + POST SSE
   ▼
Express 5 app (server/app.ts)  ← 组合根，唯一装配路由的地方
   │  helmet → cors → requestId → 请求日志 → json → cookie → 会话中间件
   ▼
features/*  controller ─▶ service ─▶ repository ─▶ node:sqlite (.data/mirelth.db)
                │            │
                │            └─▶ ai/provider（live | offline）
                └─▶ shared/*（errors、http、validate、crypto、logger、markdown）
```

启动序（`server/index.ts`）：迁移 → 建管理员 → 演示数据 → 自动化调度器 → 监听。优雅退出先停调度器再关连接池。

## 运行时决定

- **原生 TypeScript 类型剥离**：`node server/index.ts` 直跑源码，无构建步骤。代价是相对导入必须写 `.ts` 后缀（`allowImportingTsExtensions` + `noEmit`），且不能用 enum、装饰器等需要转译的语法。
- **`node:sqlite` 直连**，无 ORM、无查询构造器；仓库层就是带类型的 prepared statement 包装。
- **同 tsconfig 两份**（`tsconfig.server.json` / `tsconfig.client.json`），`npm run build` = 双端 typecheck + `vite build`。

## 模块边界

一个 `SPEC.md` 落在它描述的模块旁。`client/` 与 `server/` 各自成层；`server/features/*` 每个业务域自带表、仓库、服务、路由。

依赖方向（箭头表示「调用/导入」）：

```
app.ts ─▶ features.{auth, activity, documents, analytics, papers, research, mail, agent, workspace}
features.* ─▶ shared/*        除 seed 外，shared 不反向依赖任何 feature
ai        ─▶ shared/*        provider 用 config/errors/logger；AI 层不依赖任何 feature
features.* ─▶ ai/provider     需要生成内容的域（documents, analytics, papers, research, mail, workspace, agent）
features.* ─▶ auth           每个受保护路由用 currentUserId 取会话用户；auth 只向下依赖 shared
workspace  ─▶ documents, analytics, papers, research, mail   自动化任务直接调用同级的业务 service
platform   ─▶ documents, mail, papers, analytics, research, workspace   已挂载四组，其余 31 条在 deferred，见 platform-subsystem
features.* ─▶ activity        写操作记流水（有遗漏，见已知漂移）；activity 向下只再依赖 auth 的 currentUserId
shared/seed ─▶ features/auth  唯一一处 shared → features 的反向边（种子数据要建管理员会话清理）
```

两条跨域信号的解读：**activity 是名义上的汇点**——多数域向它写，但它自己的工作台概览并不是自足的：`activityService.stats()` 直接对 documents、datasets、papers、projects、experiments、tasks、messages 七张业务表发 COUNT。改这七张表的表结构会静默打断工作台概览。**workspace 是编排者**——自动化动作不是通用插件，而是逐个调用同级 service 的 switch 分支。

`platform` 与 `agent` 的区别值得记牢：`agent` 是无状态的任务端点（给 kind + input，拿回生成文本），`platform` 是有状态的会话式智能体（会话、运行记录、工具调用、RAG、配额），后者目前无人引用。

## 已强制的约束

这些由代码结构保证，违反会被类型系统或运行时打到：

1. **会话前置**：`app.use('/api', authenticate)` 挂载在业务路由之前，只有 `/api/auth/*` 在其上方；任何新业务路由自动要求登录。
2. **入站校验只覆盖 body**：路由层用 `validateBody` 过 Zod，失败抛 `ValidationError`（422）；service 只接受已校验的类型。`validateQuery` 虽已导出，但既无人使用又在 Express 5 下因 `req.query` 只读而无法工作——查询参数目前靠各控制器手动 `parseInt` 与默认值处理。
3. **SQL 唯一入口**：仓库层 prepared statement；迁移是只追加的编号 `.sql`，启动时按文件名排序、每文件一个事务，应用记录写入 `schema_migrations`。
4. **错误信封**：所有错误响应都经 `shared/http.ts` 的 `sendError` 写出 `{title,status,detail,errors,request_id}`——包括限流 429 与 `/api` 404。`AppError` 子类直接映射；**body-parser 的 4xx 会被先映射成 `AppError`**（畸形 JSON → 400 `BAD_REQUEST`，超限 → 413 `PAYLOAD_TOO_LARGE`）；其余未被识别的异常一律 500 且不泄漏内部信息。**成功响应另有约定**：业务路由一律回 `{ data: <payload> }`，客户端 `client/lib/api.ts` 统一解包 `data` 字段——新增接口必须包在这一层里（例外：`/health`、`/ready` 与导出/下载接口直接写 body）。**列表接口另有约定**：一律回 `{ data: { items, total, limit, offset } }`，分页参数由 `shared/http.ts` 的 `pageQuery(req)` 解析（`?limit=&offset=`，夹在 1..100、offset ≥ 0）。
5. **模型调用单点**：只有 `server/ai/provider.ts` 发 LLM 请求；feature 组装 payload 而不是拼 HTTP。
6. **单账户隔离靠约定，不靠机制**：业务查询通常带 `user_id` 过滤（由 `authenticate` 提供），但没有任何类型或运行时检查会拦住一条漏了过滤的新查询。两处刻意例外：邮件仓储按 `account_id` 匹配，`workspace.repository.dueTasks` 跨用户取到期任务（调度器必须如此）。
7. **凭据静态加密**：邮箱密码与连接器 token 走 AES-256-GCM，密钥由 `APP_SECRET` 经 SHA-256 派生（`shared/crypto.ts`）。
8. **配置单点（有例外，见已知漂移）**：环境读取集中在 `shared/config.ts`（支持 `.env` 文件 + `APP_SECRET` 的启动校验）。

## 决定与理由

- **单体而非前后端分离部署**：单机单用户，没有扩缩需求；同进程托管 `dist/` 让「装完即用」成立，也省掉一套反向代理配置。
- **feature-first 三层而非按技术分层**：多数业务域自带表、仓库、服务、路由，域内改动集中；`controller → service → repository` 三层在同一目录里，跨域调用必须显式走对方的 service。两处不成形，写模块 spec 时别去找不存在的层：`activity/` 没有 repository（service 直接发 SQL），`agent/` 只有 controller（无表、无仓库、无 service）。
- **离线规则引擎而非「缺密钥就报错」**：默认安装可用，且离线路径输出确定性内容，使冒烟与人工核查不依赖外部模型。
- **SSE 用 POST + `fetch` 流解析而非 `EventSource`**：请求需要 body（任务 kind + input），`EventSource` 只能 GET。
- **客户端 hash 路由 + 手写 UI kit**：页面数量固定，不引路由库与组件库；`lib/ui.tsx` 自带给按钮、模态、图表、Markdown 渲染。

## 已知漂移

代码与上述描述或彼此之间尚不一致的地方，修的时候顺手删掉对应条目：

- `platform` **已部分接线**：`app.ts` 挂了 `/api/platform` 的 10 条（状态/工具/知识库/会话与运行），其余 31 条在 `platform.deferred.ts`（无任何文件导入）。详见 `platform-subsystem`。
- `003_platform.sql` 建出 17 张普通表加 1 张 `knowledge_fts` fts5 虚拟表（共 18 个对象）；其中工作区、会话、运行步骤、知识片段、审计、用量已随上面四组投入使用，**其余仍无 API**（成员、分享、评论、版本、文件、事件、工作流）。注意 `grep 'create table'` 只能数到 17，fts 那行走的是 `CREATE VIRTUAL TABLE`。
- **默认口令仍在服务端**：API 已只绑 `127.0.0.1`，登录页也不再预填或显示密码，但 `shared/config.ts` 里 `ADMIN_PASSWORD` 的默认值仍是 `admin123`，`.env.example` 与 README 照旧写着它。要彻底消除得另起一轮（会牵动首次启动体验与 `scripts/smoke.ts`）。
- `requireRole` 已改抛 `ForbiddenError`（`AppError` 子类）——以前是带 `status: 403` 的普通 `Error`，接线后会被记成 500。
- `settings` 表在 `001_init.sql` 建好但无任何读写。
- **环境读取还有一处绕开 `config`**：`shared/logger.ts:7` 读 `NODE_ENV`（`AI_DAILY_LIMIT` 已收进 `config.ai.dailyLimit`）。
- **活动流水已覆盖全部写路径，口径是「全记」**：包括连通性测试、手动标记已读、打开未读邮件时的隐式已读——它们只因实现而落库，会让「最近动态」比较吵。取舍见 `activity`。
- `workspace` 目录指「自动化任务 + 连接器」，`platform` 里的 workspace 指「多工作区」——同名不同义，读代码时先分辨。
