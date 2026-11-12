# Mirelth Desk · 办公智能体工作台

面向办公场景的单机全栈应用：**文档写作、数据分析、论文整理、科学研究、智能邮箱**，外加统一对话式智能体。所有数据保存在本机 SQLite，AI 可接入任意 OpenAI 兼容接口；未配置密钥时自动使用离线规则引擎，保证开箱即用且不编造数据。

## 快速开始

要求 Node.js ≥ 22.18（开发验证环境为 Node 24，使用原生 TypeScript 类型剥离与内置 `node:sqlite`）。

```bash
npm install
cp .env.example .env        # 可选：不创建 .env 也能用默认配置启动
npm run dev                 # 同时启动 API (3001) 与前端 (5173)
```

打开 `http://127.0.0.1:5173`，默认账号 `admin` / `admin123`（可在 `.env` 中修改）。

其他命令：

```bash
npm run build       # 类型检查 + 前端生产构建（输出 dist/）
npm start           # 生产模式：由 Express 同时托管 API 与 dist/
npm run smoke       # 端到端接口冒烟测试（需先启动服务）
```

## 功能

| 模块 | 能力 |
| --- | --- |
| 工作台 / 首页 | 一屏对话式入口：六个分类（日常办公/文档写作/数据分析/科学研究/衣食出行/人文娱乐）各 3 组任务卡，点卡片把提示词填进输入框；智能体对话抽屉（SSE 流式） |
| 文档协作 | 6 类模板、Markdown 编辑/预览、AI 大纲/起草/润色/续写/摘要、MD/HTML 导出 |
| 数据分析 | CSV 导入与类型推断、描述统计、分组柱状图、趋势折线图、相关性、AI 洞察/报告、CSV 导出 |
| 论文整理 | 文献 CRUD、主题与状态筛选、笔记与评分、BibTeX 导入、BibTeX/RIS/APA 导出、AI 综述 |
| 科学研究 | 项目、实验记录（假设/方法/结果/结论/指标）、任务看板、AI 实验设计/结果解读/研究计划 |
| 智能邮箱 | IMAP 收件同步（幂等）、SMTP 发送、演示模式降级、AI 摘要/回复/起草、账户加密存储 |
| 自动化任务 | 手动/定时触发、7 种真实办公动作、运行记录与结果查看、每分钟轻量调度器 |
| 技能专家连接器 | 内置模型/邮箱/存储状态、自定义 Webhook/API 连接器、连通性测试、Token 加密存储 |
| 平台与协作 | 多账号（安装管理员建号）、工作区与角色、文档分享/评论/版本快照与恢复、附件、事件与工作流、审计与用量、MCP；外部系统用**工作区 API Key** 调 `/webhook/:key` 与 `/mcp` |

**导航结构**：侧栏只有「新建任务」、四个应用（智能邮箱、自动化任务、技能专家连接器、智能体工作台）与可折叠的最近任务；设置、活动、外观（浅色/深色/系统）、日志打包、检查更新、退出登录都在左下角头像菜单里。文档协作、数据分析、论文整理、科学研究目前只保留页面本身（`#/documents` 等直达），不再占导航位。

## 架构决策

- **单体全栈**：Express 5 提供 REST + SSE；生产构建由同一进程托管前端静态产物。
- **feature-first 三层**：`controller`（HTTP + Zod 校验）→ `service`（业务与 AI 编排）→ `repository`（SQLite）。
- **数据库**：`node:sqlite` + 版本化迁移（`server/shared/migrations/*.sql`），WAL、外键、索引。
- **AI**：`server/ai/provider.ts` 抽象 OpenAI 兼容流式接口；`offline.ts` 基于真实输入数据生成确定性结构化内容。
- **鉴权**：`scrypt` 密码哈希、`httpOnly` Cookie + HMAC 签名会话、服务端会话表可撤销。
- **实时**：AI 生成走 SSE（POST + `fetch` 流解析）；邮件同步显式触发，不做长连接。
- **自动化**：`server/features/workspace/` 统一承载自动化任务与连接器；调度器每分钟检查到期任务并执行真实业务动作，结果写回运行记录。
- **可靠性**：集中配置启动校验、类型化错误 + 全局处理器、结构化 JSON 日志 + requestId、健康检查、优雅退出、限流、helmet、显式 CORS 来源。

## 配置

复制 `.env.example` 为 `.env`：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | API 端口 | `3001` |
| `CLIENT_ORIGIN` | 允许的前端来源（逗号分隔） | `http://127.0.0.1:5173` |
| `APP_SECRET` | 生产必填（≥16 字符）；开发环境自动生成到 `.data/secret.key` | 自动生成 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 本机登录账号 | `admin` / `admin123` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容接口；无密钥时使用离线引擎 | 离线引擎 |
| `DATABASE_PATH` | SQLite 文件位置 | `.data/mirelth.db` |

## 主要接口

```
/health  /ready
/api/auth/{login,logout,me}  /api/auth/users（安装管理员）
/api/dashboard  /api/dashboard/activity
/api/documents  /api/documents/templates  /:id/{ai,export}
/api/analytics/datasets  /:id/{insights,export}
/api/papers  /stats  /import  /ai  /export  /:id
/api/research/{overview,projects,experiments,tasks}  /experiments/:id/ai  /projects/:id/plan
/api/mail/{status,accounts,sync,messages,send,ai}
/api/automation/{actions,tasks}  /:id/run
/api/connectors  /:id/test
/api/agent/{status,generate,run(SSE)}
/api/platform/{status,tools,knowledge,conversations,chat(SSE),runs}
/api/platform/{workspaces,agents,shares,comments,versions,files,events,workflows,audit,usage,mcp}
/api/platform/workspaces/:id/{members,keys}  /api/platform/webhook/:key（X-Api-Key）
```

## 边界与后续

单机部署，可以多账号（安装管理员建号、工作区与角色控制可见范围），但没有邀请/注册/审批等组织流程；CSV 单次最多 5000 行；离线引擎是规则模板，风格改写能力弱于真实模型；AI 结论只使用你提供的材料；`AI_DAILY_LIMIT` 只统计平台会话的模型调用，不是全站预算。生产化建议：配置 `APP_SECRET` 与 HTTPS、迁移到 PostgreSQL、把配额与审计扩到全站 AI 调用、为邮件同步引入后台队列。
