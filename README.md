# Mirelth Desk · 办公智能体工作台

面向办公场景的单机全栈应用：**文档写作、数据分析、论文整理、科学研究、智能邮箱**，外加统一对话式智能体。所有数据保存在本机 SQLite，AI 可接入任意 OpenAI 兼容接口；未配置密钥时自动使用离线规则引擎，保证开箱即用且不编造数据。

## 快速开始

要求 Node.js ≥ 22.18（开发验证环境为 Node 24，使用原生 TypeScript 类型剥离与内置 `node:sqlite`）。

```bash
npm install
cp .env.example .env        # 可选：不创建 .env 也能用默认配置启动
npm run dev                 # 同时启动 API (3001) 与前端 (5173)
```

打开 `http://127.0.0.1:5173`，账号名默认 `admin`。**口令不再内置**：未配置 `ADMIN_PASSWORD` 时首次启动随机生成并写入 `.data/admin-password`（权限 0600），从该文件读取即可；也可在 `.env` 中自行指定。

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
| 文档协作 | 6 类模板、Markdown 编辑/预览、AI 大纲/起草/润色/续写/摘要、MD/HTML/DOCX 导出、**DOCX/PDF/图片导入**、AI 生成演示文稿（PPTX，**9 种版式 + 7 套主题 + 品牌套件**：组织名/副标题/页脚/字体/品牌色/Logo） |
| 数据分析 | CSV/XLSX 导入与类型推断、描述统计、分组柱状图、趋势折线图、相关性、AI 洞察/报告、CSV/XLSX 导出 |
| 知识检索 | **语义向量 + 词法混合召回（RRF 融合）**、按标题分块带重叠、文档改动增量索引、附件正文入索引；未配嵌入模型时自动降级词法，离线可用 |
| 向量索引 | 大库用**粗量化分桶（IVF）+ 原始向量精排**替代全表扫；k-means 确定性训练、增量归桶、nprobe 可调；小库仍全扫（更准更快）。实测 2000 片段 recall@10=1.0、候选降至 18% |
| 图片与扫描件识别 | 交**多模态模型**转录为 Markdown（手写体、表格、版面均支持）；扫描件 PDF **自动逐页转图识别**；有文本层的 PDF 直接提取不花模型钱；结果标注模型来源 |
| 分层记忆 | **四层**：会话短期（TTL 分钟级、不跨会话）／用户偏好／事实与项目／执行经验（默认关闭、TTL 天级、可回溯运行）。各层独立配额与相关性召回、跨层去重、命中计数；偏好与事实**只由显式保存产生**，可按层清空 |
| 浏览器自动化 | 连接本机已有浏览器（CDP，不下载内核）；**默认关闭** + 域名白名单 + 敏感动作人工确认 + 全程留痕 |
| 论文整理 | 文献 CRUD、主题与状态筛选、笔记与评分、BibTeX 导入、BibTeX/RIS/APA 导出、AI 综述 |
| 科学研究 | 项目、实验记录（假设/方法/结果/结论/指标）、任务看板、AI 实验设计/结果解读/研究计划 |
| 智能邮箱 | IMAP 收件同步（幂等）、SMTP 发送、演示模式降级、AI 摘要/回复/起草、账户加密存储 |
| 自动化任务 | 手动/定时触发、7 种真实办公动作、运行记录与结果查看、每分钟轻量调度器 |
| 技能专家连接器 | 内置模型/邮箱/存储状态、自定义 Webhook/API 连接器、连通性测试、Token 加密存储 |
| 智能体执行 | **规划 → 执行 → 反思**多步任务：先出计划再逐步推进，收尾前审查目标是否真的达成，未达成自动补做；步数与时长双上限、计划全程留痕可回放；无密钥时走确定性规则计划 |
| 插件 | 把外部接口接成智能体工具：**HTTP 接口**与**外部 MCP 服务器**两种；落库保存、按工作区隔离、凭据加密由服务端注入；**出站白名单默认空即拒绝全部**、默认拒本机与内网、重定向每跳复核、响应体积封顶；敏感插件需人工确认；调用全程留痕 |
| MCP 双向 | **入站**：外部系统调我们的工具（`/mcp`，X-Api-Key）；**出站**：连接外部 MCP 服务器，自动握手并把它的工具映射为 `plug_<插件名>_<远端名>`；支持 JSON 与 SSE 两种响应体，远端不可达时工具自动移出候选 |
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
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 本机登录账号；口令留空则随机生成到 `.data/admin-password` | `admin` / 随机生成 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容接口；无密钥时使用离线引擎 | 离线引擎 |
| `LLM_EMBEDDING_MODEL` | 语义检索的嵌入模型；留空则降级词法检索 | 空（词法） |
| `LLM_VISION_MODEL` | 图片与扫描件识别用的多模态模型；留空沿用 `LLM_MODEL` | 空 |
| `VISION_MAX_PAGES` / `VISION_RENDER_SCALE` | 扫描件识别页数上限与渲染倍率 | `10` / `2` |
| `BROWSER_ENABLED` | 浏览器自动化总开关 | `false`（关闭） |
| `BROWSER_CDP_URL` | 本机调试地址，只允许回环 | `http://127.0.0.1:9222` |
| `BROWSER_ALLOWED_HOSTS` | 域名白名单，逗号分隔；留空拒绝全部 | 空 |
| `AGENT_MAX_STEPS` / `AGENT_DEFAULT_STEPS` | 智能体单次运行的步数硬上限与默认值 | `24` / `8` |
| `AGENT_PLANNER_ENABLED` / `AGENT_REFLECT_ENABLED` | 规划层与反思层开关；关掉即退回单段工具循环 | `true` / `true` |
| `AGENT_MAX_REVISIONS` | 反思后最多重排次数 | `2` |
| `AGENT_RUN_TIMEOUT_MS` | 单次运行墙钟上限（毫秒） | `300000` |
| `PLUGINS_ENABLED` | 插件体系开关 | `true` |
| `PLUGINS_ALLOWED_HOSTS` | 插件出站白名单，逗号分隔；**留空拒绝全部** | 空 |
| `PLUGINS_ALLOW_PRIVATE_NETWORKS` | 允许本机/内网地址（仍需命中白名单） | `false` |
| `PLUGINS_TIMEOUT_MS` / `PLUGINS_MAX_RESPONSE_BYTES` | 插件调用超时与响应体积上限 | `8000` / `65536` |
| `PLUGINS_MAX_PER_WORKSPACE` | 单工作区插件数量上限 | `30` |
| `PLUGINS_MAX_REMOTE_TOOLS` | 单个 MCP 插件引入的远端工具数上限 | `20` |
| `PLUGINS_REMOTE_CACHE_MS` | 远端工具清单缓存时长；0 表示每次拉取 | `300000` |
| `VECTOR_INDEX_MODE` / `VECTOR_INDEX_THRESHOLD` | 索引模式（auto/scan/index）与启用阈值 | `auto` / `20000` |
| `VECTOR_BUCKETS` / `VECTOR_PROBES` | 桶数上限与查询探查桶数 | `256` / `8` |
| `MEMORY_EPISODIC_ENABLED` | 执行经验层（自动记客观运行结果） | `false`（关闭） |
| `MEMORY_WORKING_TTL_MINUTES` / `MEMORY_EPISODIC_TTL_DAYS` | 短期记忆与执行经验保留期 | `120` / `30` |
| `MEMORY_RECALL_TOTAL` | 单次召回记忆总条数上限 | `8` |
| `DATABASE_PATH` | SQLite 文件位置 | `.data/mirelth.db` |

## 主要接口

```
/health  /ready
/api/auth/{login,logout,me}  /api/auth/users（安装管理员）
/api/dashboard  /api/dashboard/activity
/api/documents  /api/documents/templates  /api/documents/import  /:id/{ai,export,slides}
/api/analytics/datasets  /api/analytics/datasets/xlsx  /:id/{insights,export}
/api/papers  /stats  /import  /ai  /export  /:id
/api/research/{overview,projects,experiments,tasks}  /experiments/:id/ai  /projects/:id/plan
/api/mail/{status,accounts,sync,messages,send,ai}
/api/automation/{actions,tasks}  /:id/run
/api/connectors  /:id/test
/api/agent/{status,generate,run(SSE)}
/api/platform/{status,tools,knowledge,conversations,chat(SSE),runs}
/api/platform/knowledge/{search,reindex,embed,index}  /api/platform/memories（GET/POST/DELETE）
/api/platform/memories/{layers,purge}  /api/platform/memories/layers/:layer（DELETE 按层清空）
/api/platform/plugins（GET/POST/PATCH/DELETE）  /:id/test  /api/platform/plugins/runs
/api/documents/slides/catalog  /api/documents/:id/slides（GET 与 POST 均可）
/api/platform/{workspaces,agents,shares,comments,versions,files,events,workflows,audit,usage,mcp}
/api/platform/workspaces/:id/{members,keys}  /api/platform/webhook/:key（X-Api-Key）
/api/browser/{status,runs,run}
```

## 边界与后续

单机部署，可以多账号（安装管理员建号、工作区与角色控制可见范围），但没有邀请/注册/审批等组织流程；CSV/XLSX 单次最多 5000 行；Office 导入只支持 .docx / .xlsx（旧版 .doc / .xls 需先另存为新格式），DOCX 导入不保留图片，XLSX 只读第一个工作表，上传文件解码后不超过 5MB；PPTX 大纲离线时按文档标题结构切分，配模型后由模型产出；离线引擎是规则模板，风格改写能力弱于真实模型；AI 结论只使用你提供的材料；`AI_DAILY_LIMIT` 只统计平台会话的模型调用，不是全站预算。

**本轮新增能力的边界（如实声明）**：

- **PDF**：有文本层时直接提取（不花模型钱），不还原复杂表格与多栏排版；加密 PDF 直接拒绝。**扫描件自动逐页转图交多模态模型识别**，页数受 `VISION_MAX_PAGES` 限制（默认 10 页），超出部分会在文档里明确标注「仅识别前 N 页」。
- **图片与扫描件识别**：需要配置支持图片输入的模型（`LLM_API_KEY` + `LLM_VISION_MODEL`）。**未配置时直接报错并提示如何配置，不静默返回空**——图片识别没有可用的离线替代。模型不支持图片时会提示更换模型。识别质量取决于所选模型；提示词已约束「逐字转录、不补写、存疑处标注」，但**机器识别结果仍需人工核对**，文档里会自动标注模型来源。
- **语义检索与向量索引**：需配置 `LLM_EMBEDDING_MODEL` 且接口兼容 `/embeddings`；未配置时降级词法，功能不中断。向量存 SQLite BLOB。**小库全扫**（上限 50000 片段），**大库走粗量化分桶索引**：k-means 训练质心 → 片段归桶 → 查询只探查最近的 nprobe 个桶，桶内仍用原始 float32 精排（精度损失只来自候选裁剪，不来自量化压缩）。索引需**显式建立**（界面「建立/补全」或 `POST /api/platform/knowledge/index`），新片段自动增量归桶。实测 2000 片段 / 32 桶 / nprobe=6：recall@10 = 1.000，候选 366/2000（降至 18%）；nprobe=1 时 recall 降到 0.90——**这是近似检索，不保证与全扫逐条一致**。桶不平衡度超过 6 倍时界面提示重训。仍是单机 SQLite，未引入外部向量库；十万级以上或需要高并发时应换真正的向量数据库。
- **浏览器自动化**：**本身需要网络**，「完全离线」承诺不覆盖它。Chrome 136+ 要求调试端口搭配独立 `--user-data-dir`，因此是全新 profile，**不复用日常浏览器登录态**，首次需在自动化浏览器内登录目标站点。调试端口能读取页面内容与 Cookie，等同高权限通道，故默认关闭、白名单默认拒绝全部、点击与填写必须人工确认；程序不读取也不存储 Cookie。
- **分层记忆**：四层各有配额——会话短期 20 条（保留 120 分钟，**只在当前会话内可见**）、用户偏好 200 条、事实与项目 300 条、执行经验 200 条（保留 30 天）。**偏好与事实只由 `memory_save` 工具或手动保存产生，绝不自动推断**；会话短期由 `memory_note` 工具显式记录。**执行经验层默认关闭**（`MEMORY_EPISODIC_ENABLED=true` 才开），开启后自动记录的是**客观运行事实**（任务目标、用到的工具、成败、收尾原因），带 `run_id` 可回溯，不是对用户意图的猜测。召回按层分配预算（偏好有保底配额，不会被最新琐事挤掉），跨层去重，总数受 `MEMORY_RECALL_TOTAL` 限制。短期与经验层满时淘汰最旧一条；长期层满时报可读错误。可按层清空、可清理过期、可逐条删除。
- **插件**：**只支持声明式 HTTP 调用，不执行任何代码**（不加载 JS、不起子进程、不装包）。出站需显式授权域名（`PLUGINS_ALLOWED_HOSTS` 留空即拒绝全部），默认拒绝本机与内网地址——含 `169.254.169.254` 等云元数据端点；连本机自建服务需显式开 `PLUGINS_ALLOW_PRIVATE_NETWORKS=true` 且该地址仍在白名单内。只有声明过的入参会外发，凭据由服务端注入请求头、不进请求体也不交给模型。**破坏性变更**：旧的「注册自定义工具」存于进程内存、重启即丢且不按工作区隔离，现已改为落库插件——**旧的内存工具无法迁移，需重新添加为插件**；无端点的「回声工具」不再支持。**MCP 出站已实现**（Streamable HTTP 传输）：连接外部 MCP 服务器并引入其工具，工具名带 `plug_` 命名空间避免撞名。远端工具说明按**外部数据**处理——截断、标注来源，并在系统提示里声明它不构成指令；远端 schema 只收敛为三种标量，复杂类型降级为字符串。远端不可达时其工具**自动移出候选**，不让规划器许诺调不通的工具。清单默认缓存 5 分钟（`PLUGINS_REMOTE_CACHE_MS`），单插件远端工具数上限 20（`PLUGINS_MAX_REMOTE_TOOLS`）。**不支持 stdio 传输**（那需要起子进程，与「不执行代码」的底线冲突），也不解析远端返回的图片等非文本内容（会如实标注）。
- **演示文稿模板库**：9 种版式（要点/分节/双栏/表格/引述/指标卡/时间线/图表/结束）、7 套主题、品牌套件（组织名、封面副标题、页脚、字体、品牌主色与强调色、Logo）。**指标卡与图表只使用文档里真实出现的数字**——提示词已明确禁止推算，离线规则引擎干脆不产出这两种版式（它拿不到真实数字）。声明某版式但没给对应数据时**自动退回要点页**，不出空白页。Logo 只接受 PNG/JPG 的 data URI（界面限 500KB），固定尺寸放右上角以免撑破版面；品牌色只接受 6 位 hex，非法值丢弃而非注入 XML。图表是**用形状绘制的柱状图**，不是 PowerPoint 原生图表对象，因此在 PowerPoint 里不能改数据源。字体需本机已安装，否则 PowerPoint 会回退到默认字体。
- **规划与反思**：计划的粒度是「工具步骤」，**不是任意代码执行**——能做什么仍由工具清单与白名单决定，规划器许诺的白名单外工具会被降级为纯推理步骤。反思只判定「目标是否达成」并追加步骤，**不会自动获得新权限**：浏览器点击/填写等敏感动作仍需人工确认。步数用尽或超时会**如实标注 `stopped_reason` 并交付已有结果**，不假装完成。无密钥时走确定性规则计划（检索 → 生成 → 落盘），能力弱于模型规划但可用。规划与反思各会额外产生模型调用，计入 `AI_DAILY_LIMIT`。

生产化建议：配置 `APP_SECRET` 与 HTTPS、迁移到 PostgreSQL、把配额与审计扩到全站 AI 调用、为邮件同步引入后台队列。
