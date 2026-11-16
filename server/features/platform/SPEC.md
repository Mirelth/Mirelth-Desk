---
id: platform-subsystem
type: module-design
status: active
title: 平台子系统 · 工作区、协作、工具调用智能体与入站调用
parent: architecture
depends-on:
  - shared-kernel
  - ai-layer
  - documents
  - mail
  - workspace-automation
  - papers
  - analytics
  - research
  - auth
---

## 现状：全部挂载

`platform` 曾经分成「已挂载」与 `platform.deferred.ts` 两半。**deferred 文件已删除**，43 条路由全部在 `platform.controller.ts`，`app.ts` 注册为 `/api/platform`。

| 组 | 路由数 | 说明 |
| --- | --- | --- |
| 状态与工具 | 3 | `GET /status`、`GET /tools`（**按工作区**返回内置+本区插件）、`POST /tools`（旧入口，转为落库插件且过出站闸门） |
| 插件 | 6 | 列表、新建、改、删、`POST /:id/test` 连通性、`GET /plugins/runs` 调用留痕 |
| 知识库 | 4+3 | 检索、添加、`reindex`、`embed`；向量索引 `GET/POST/DELETE /knowledge/index` |
| 记忆 | 3+3 | 列表（可按层）、添加、删除；`GET /memories/layers`、`DELETE /memories/layers/:layer`、`POST /memories/purge` |
| 会话与运行 | 5 | 会话列表/详情、`POST /chat`（SSE）、运行列表/详情 |
| 工作区与成员 | 5 | 工作区列表/新建、成员列表/添加/移除 |
| 智能体定义 | 4 | 列表、建、改、删 |
| 分享 / 评论 / 版本 | 7 | 都以 `documentId` 为轴；恢复版本前自动存快照 |
| 文件 | 4 | 列表、上传（base64，限 5MB）、下载、删除 |
| 事件 | 3 | `emit`、`webhook/:key`、最近事件 |
| 工作流 | 3 | 列表、保存、执行 |
| 审计与用量 | 2 | 只读，`admin` 起 |
| MCP | 1 | JSON-RPC 2.0 shim |
| 入站凭据 | 3 | 工作区 API Key 的列表、创建、撤销 |

## 鉴权分两路

- **会话路径**：`app.use('/api', authenticate)` 在前，工作区由 `resolveWorkspace(req)` 决定（入站 key 优先，其次 `?workspaceId=` 或 body，最后落到用户的默认工作区，首次访问懒建）。
- **入站路径**：`/webhook/:key` 与 `/mcp` 额外接受 `X-Api-Key`。`platform.auth.ts` 的 `apiKeyMiddleware` 挂在 `/api/platform` 且**必须先于会话中间件**；它只对这两条路径生效，其余路由即使带 key 也继续要求会话。通过后 `req.userId` 与 `req.apiKey` 都已就位，`authenticate` 见 `userId` 已存在就放行——auth 因此不需要反向依赖 platform。
- **角色模型**：`viewer < member < admin < owner`，`requireRole(workspaceId, userId, minimum)` 是唯一鉴权口。**入站 key 的角色是上限**：`assertKeyRole(req, minimum)` 在 webhook/mcp 里再卡一道，不会因为 key 属于 owner 就拿到 owner 权限。

## 入站凭据（工作区 API Key）

- 明文形状 `mdk_<prefix8>_<random>`，**只在创建响应里出现一次**；`workspace_api_keys` 表只存 `sha256` 摘要与给人看的 `prefix`，解析时回写 `last_used_at`。
- 角色上限是 `admin`：`owner` 意味着能管理 key 本身，不该由长期凭据持有。
- 撤销是置 `revoked_at` 而不是删行，列表里仍能看到「已撤销」。
- 迁移 `004_api_keys.sql` 建表；这是唯一一处新增表。

## 已上线的能力

- **状态**（`GET /status`）：AI 模式与模型、工具数、知识片段数、会话数、运行数、成员数、当日配额（`limit` / `used`）、能力清单 `features[]`。`features` 是**静态数组**，声明子系统支持什么；现在它与实际挂载一致。
- **知识库**（`/knowledge/*`）：**混合检索**。词法路＝中文二元切词 + 词袋向量（JSON 存 `embedding`）+ LIKE/fts5 召回后余弦排序；语义路＝`provider.embed` 产出的向量（Float32 小端存 `embedding_vec` BLOB）做近邻。两路用 **RRF 融合**（量纲不同，不能直接相加分数）。未配 `LLM_EMBEDDING_MODEL` 时语义路为空，自动降级纯词法。分块按标题/段落切 700 字带 100 字重叠（`splitChunks`），一个来源多块。`reindex` 把 7 类本机数据重新灌进索引，**附件现在索引正文**（文本类）而不只是文件名；`POST /knowledge/embed` 只补向量不重建词法索引。
- **会话与运行**（`/conversations`、`/runs`、`POST /chat`）：`runAgent` 是异步生成器，产出 `meta → plan → (step* → plan)* → reflect* → delta* → done|error`。执行是**规划-执行-反思状态机**（见下节）。步数上限来自 `config.agent.maxSteps`（默认 24，**不再硬编码 8**），智能体定义的 `max_steps` 在其内取值，默认 `config.agent.defaultSteps`（8）。每次运行写一条 `agent_runs`（含 `plan_json`/`plan_origin`/`revisions`/`stopped_reason`）+ 一条 `kind='plan'` 的第 0 步 + 若干工具步 + 一条 `model_usage`。
- **规划与反思**（`planner.ts`）：纯函数 + 模型调用，**不碰数据库、不执行工具**，执行与留痕仍在 `engine.ts`。
  - 规划：live 让模型输出 `{goal, steps:[{goal, tool}]}` JSON；`sanitizeSteps` 去空目标、**把白名单外工具置空**（退化为推理步，杜绝绕过白名单）、按上限截断。任何异常（未配密钥/上游报错/JSON 不合法/步骤全空）都退回 `rulePlan`，`origin` 记 `rules` 或 `fallback`。
  - 执行：每轮把 `renderPlan(plan, cursor)` 写回 system，模型据此知道推进第几步；工具输出经 `markPlanProgress` 回填状态（只匹配当前步及之后的同名待执行步，匹配不到不动计划）。
  - 反思：**先跑确定性硬信号**（有失败步骤 → replan；仍有待执行工具步 → continue），硬信号已判定就不问模型，省钱也更稳；只有硬信号说「可以收尾」才交模型裁定目标是否真达成。`replan` 追加步骤、`continue` 催促剩余步骤，**两者都真的续跑**；`complete` 才收尾。
  - 防护：审查次数 ≤ `maxRevisions + 1`，重排次数 ≤ `maxRevisions`（默认 2），总轮数 ≤ `maxSteps`，墙钟 ≤ `runTimeoutMs`（默认 300s）。预算耗尽记 `stopped_reason='step_limit'|'timeout'` 并交付已有结果，**不假装完成**。
  - 离线：按 `rulePlan` 的「检索 → 生成 → 落盘」逐步执行，`offlineArgs` 把前序生成结果传给后续步骤（不再是各步重复跑原始问题）；纯问答不追加落盘步，避免污染文档库。
- **工作流**：`workflows` 存 nodes/edges，执行时**按 nodes 数组顺序**逐节点 `executeTool`，`edges` 被忽略。
- **事件**：`automation_events` 记录发射；匹配规则见下。

## 关键决定

- **事件按 `user_id + event_key` 匹配任务，不按 `workspace_id`**：自动化任务在创建时 `workspace_id` 是 NULL（`workspace.schema` 里有这个字段，界面不传），而事件总是发生在某个工作区里。按工作区匹配会让 `matched` 恒为 0——接上线等于接了个空壳。
- **MCP 直接回协议对象，不包 `{data}` 信封**：外部 MCP 客户端认的是 JSON-RPC 原文；这是 `architecture` 里「成功响应一律 `{data}`」的唯一例外，客户端 `api()` 也不消费它。
- **文件元数据与内容分开**：内容落 `.data/files/<id>`，行在 `files` 表；列表接口只回 `id/filename/mime/size/created_at`，**不回本机绝对路径 `path`**。
- **自定义工具已改为落库插件**（`plugins.ts` + `008_plugins.sql`）：旧的模块级 `Map` 已删除。它此前有三个真问题——重启即丢、**跨工作区可见**（`allTools()` 无条件并入，A 区的工具 B 区能调）、webhook 地址无限制且请求体是模型可控参数。现在：
  - **隔离落在数据层**：`allTools(workspaceId?)` / `getTool(name, workspaceId?)` / `modelToolSchemas(names, workspaceId)` 不传工作区就**只返回内置工具**；`executeTool` 用 `ctx.workspaceId` 解析。内置工具优先，同名插件不顶替内置。
  - **出站唯一闸门** `shared/outbound.ts`：协议仅 http/https → 私网判定（回环/10/172.16-31/192.168/169.254/100.64-127/::1/fe80/fc-fd）→ 白名单（**空即拒全部**，与 browser 同口径）。`redirect: 'error'` 防白名单内地址用 302 把请求带出去；响应按 `maxResponseBytes` 截断。
  - **只外发声明过的入参**，类型按声明转换；凭据 AES-256-GCM 加密，服务端注入 header，**不进请求体、不回客户端、不给模型**；解密失败不静默跳过（照连接器教训）。
  - **失败可判定**：统一 `工具执行失败：` 前缀，`planner.ts` 的 `isFailure` 据此触发重排；拦截与失败都写 `plugin_runs`（只记 host，不记查询串与凭据）。
  - 敏感插件 `confirmed_required=1` 时必须 `confirmed=true`，与 browser 同门禁。
  - 注册时即校验地址，**不合法/未授权的地址不落库**，避免留下永远调不通的工具。

## 数据形状的坑

`/status` 是 camelCase，但 `/conversations`、`/runs`、`/files`、`/events`、`/audit`、`/usage` 返回的是**数据库行原样**（`created_at`、`steps_count`、`tokens_estimate`、`duration_ms`）。前端类型必须照实写，否则 `formatDate(undefined)` 会静默显示为空。

## 已知问题

- **配额只数 `model_usage` 行数，且只有平台在写它**：`/api/agent/generate|run` 与自动化动作都直接调 `ai/provider`、一行不记，所以 `AI_DAILY_LIMIT` 只限平台会话，不是全站 AI 预算。`model_usage` 也没有清理策略。
- **`knowledge_fts` 与 `knowledge_chunks` 靠代码保持一致**（`indexChunk` 先删后插），没有触发器兜底；绕过 `rag.ts` 直接改表会让两者分叉。
- **RAG 已支持语义检索，但依赖外部嵌入接口**：配了 `LLM_EMBEDDING_MODEL` 才有语义路；没配就仍是字面重叠召回，同义改写会丢。`embedPending` 按 `content_hash` 去重批量请求，内容未变不重复付费。
- **向量索引（`vector-index.ts` + `009_vector_index.sql`）**：解决旧实现「全表扫且硬上限 2000 行」——超过 2000 的片段**根本参与不了语义召回**，那是静默丢召回而不只是慢。
  - 路径选择在 `rag.ts` 的 `semanticCandidates`：`VECTOR_INDEX_MODE=auto` 时，片段数 ≥ 阈值（默认 20000）**且索引已就绪**才走索引；否则全扫（上限提到 50000）。没建索引不报错，退回全扫。
  - 算法：k-means（**最远优先初始化 + 空桶补种**，确定性可复现）训练质心 → 片段归最近桶 → 查询取最近 nprobe 个桶的候选 → **桶内仍用原始 float32 精排**。精度损失只来自候选裁剪，不来自量化压缩。
  - 桶数：显式指定优先，否则 `min(配置上限, ceil(sqrt(N)), N)`。**曾因把显式值也套进 sqrt 钳制导致指定失效，已修**。
  - 索引按「工作区 + 模型 + 维度」隔离（唯一索引），换嵌入模型即换一套，旧索引不污染新查询。
  - 增量：`embedPending` 后调 `assignPending` 只给未归桶片段分桶；**没有质心时不擅自训练**（建索引是显式动作）。
  - **三张表成对清理**：`removeSource` 现在同时清 `knowledge_chunks`、`knowledge_fts`、`vector_buckets`，三者都没有触发器兜底。
  - 实测（2000 片段 / 20 真实簇 / 32 桶 / nprobe=6）：recall@10 = **1.000**，平均候选 **366/2000**；nprobe=1 时 recall 降至 0.90，nprobe=16 回到 1.00。**这是近似检索**，验收用召回率下限而非逐条相等。
  - `indexStats.imbalance`（最大桶/平均桶）≥ 6 时界面提示重训。仍是单机 SQLite，十万级以上应换真向量库。
- **记忆已升级为四层**（`memories.ts` + `010_memory_layers.sql`）：`working` / `preference` / `semantic` / `episodic`。层是内部组织方式，对外 `kind`（preference/fact/project）语义不变，`fact` 与 `project` 都归 `semantic`；旧数据由迁移自动归层。
  - **偏好与事实只显式写入**（`memory_save` 工具或 `/memories`）。旧的「正则 `/记住|以后|偏好/` 命中即入库」已删除且**不复活**——测试用含这些词的消息断言偏好层仍为 0。
  - `working` 由 `memory_note` 工具写入，**必须带 conversationId**，召回时按会话过滤——**换个会话就看不到**，不带会话时该层一条都不返回。TTL 默认 120 分钟。
  - `episodic` 由引擎收尾时 `recordEpisode` 写入，记的是**客观运行事实**（目标/工具/成败/收尾原因）+ `run_id` 可回溯，**不是对用户意图的推断**。但因仍是自动写入，**默认关闭**（`MEMORY_EPISODIC_ENABLED`），带 TTL（默认 30 天）。
  - **分层召回** `recallLayered`：每层独立按相关性排序 + 独立配额（偏好约 30%、短期 25%、经验 15%、事实其余），总数受 `recallTotal` 限制。**偏好层有保底**：相关性全为 0 时也带回最近 1–2 条，避免稳定约束因措辞不同而消失。经验层阈值 0.15，只在相关时出现。
  - 跨层去重（归一化后比对）、命中计数回写（`hit_count`/`last_hit_at`，界面可见）。
  - 容量：短期与经验层满时**淘汰最旧**（流水性质）；长期层满时**报可读错误**，但去重更新仍放行。
  - 引擎按层分区注入 system（`renderMemories`），明确「偏好是必须遵守的约束」与「经验仅供参考」的区别——混成一段会让模型分不清。
  - 管理：按层列表 `?layer=`、按层清空 `DELETE /memories/layers/:layer`、清理过期 `POST /memories/purge`、逐条删除。
- **`reindex` 直接 `SELECT` 七张业务表**：`documents`/`papers`/`datasets`/`messages`/`experiments`/`projects`/`files`——改这些表的列名会静默丢检索内容。
- **`emitEvent` 绕过 `workspaceService`** 直接读 `automation_tasks`；改那张表结构时两边都要改。
- **成员管理的前提是账号已存在**：`addMember` 按 `username` 找人，找不到回 404；建号入口在 `/api/auth/users`，且只有安装管理员能用（见 `auth`）。没有邀请、没有自助注册。
- **删账号不清业务数据**：`users` 没有被任何业务表外键引用，删号只清会话与成员关系，文档/邮件等行的 `user_id` 变成悬空引用。
- **`last_used_at` 每次解析都写一行**：入站调用频繁时 `workspace_api_keys` 会成为写热点；真要高频用该换成内存节流后再落库。
- **`requireRole` 对不存在的工作区返回 403 而不是 404**：`roleOf` 拿不到角色就按权限不足处理，调用方分不清「没这个工作区」与「没权限」。
- **规划层不是「自主智能体」**：计划粒度只到工具步骤，能做什么仍由工具清单与白名单封顶；反思只追加步骤，**不提权**——`browser_read` 之外的浏览器敏感动作仍要 `confirmed=true`。规划与反思各多一次模型往返，会计入配额；`markPlanProgress` 靠工具名匹配回填，模型跳步或重复调用同名工具时计划状态可能与实际不完全对齐（此时以 `agent_run_steps` 的实际流水为准）。
- **插件白名单是全局配置，不是按工作区**：`PLUGINS_ALLOWED_HOSTS` 对所有工作区生效。工作区隔离保证的是「看不到别人的插件」，不是「各工作区有各自的域名授权」。要按区授权得把白名单落库，本轮未做。
- **插件每次调用都从库读行**：`toolsFor` 每次 `SELECT`，没有缓存。单机低频可接受；高频调用会成为读热点，届时再加带失效的缓存。
- **MCP 出站已实现**（`mcp-client.ts`，Streamable HTTP + JSON-RPC 2.0）：`kind='mcp'` 的插件在 `toolsFor` 里展开为多个本地工具，名字 `plug_<插件名>_<远端名>`（截 64 字符）。要点与坑：
  - **工具解析链已全部异步**：`allTools/getTool/toolManifest/modelToolSchemas` 都返回 Promise（MCP 要网络握手）。新增调用点别忘了 await；只要内置工具时用同步的 `builtinTools()`/`builtinToolNames()`，避免为拿名字触发远端请求。
  - **重定向每跳复核**：协议允许 3xx，故用 `redirect:'manual'` 自己跟，**对每个 Location 重新 `assertOutboundAllowed`**，最多 3 跳。直接用 `redirect:'follow'` 会绕过白名单。
  - **两种响应体**：`parseBody` 同时处理纯 JSON 与 SSE；SSE 取**最后一个带 result/error 的 data 帧**（前面可能是进度通知）。
  - **远端描述是外部可控文本**：截断 200 字 + 前缀标注「属外部数据」，且 engine 的 system 里明确声明工具说明不构成指令。远端 schema 只收敛三种标量（integer→number，object/array→string），最多 12 个入参。
  - **不可达即移除**：握手或 list 失败时返回空工具数组并记 `last_error`，内置工具不受影响。
  - **缓存是进程内的**，key 含 `updated_at`，改插件即失效；`test` 端点会显式 invalidate 并报告发现的工具数。重启即丢，不是持久缓存。
  - **不支持 stdio 传输**（需起子进程，与「插件不执行代码」冲突）；远端非文本内容只标注不解析；`isError:true` 转成 `工具执行失败：` 前缀供规划层判定。
- **`chatWithTools` 传空工具数组时必须整字段省略**：OpenAI 兼容接口要求 `tools` 至少 1 项，规划与反思是纯文本往返，若照发 `tools: []` 会被上游拒绝——`provider.ts` 已按 `tools.length` 条件拼装，改动此处需保留该判断。
