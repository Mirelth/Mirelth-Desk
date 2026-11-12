---
id: web-client
type: module-design
status: active
title: 前端 · SPA 外壳、页面与共享 UI 层
parent: architecture
depends-on: [auth, agent-api, documents, analytics, papers, research, mail, workspace-automation, activity, shared-kernel, ai-layer]
---

## 职责

浏览器端的全部代码：一个无路由库的单页外壳（侧栏 + 顶栏 + hash 页面切换 + 智能体抽屉），11 个页面（10 个业务／功能页 + 登录页），以及被页面共享的一层 `lib/`（HTTP 客户端、DTO 类型、加载状态钩子、UI 组件、Markdown 渲染）。

## 边界

- **`lib/ui.tsx` 是所有页面的 UI 底座**（320 行、约 20 个导出）：`ToastProvider`/`useToast`、`Button`/`IconButton`/`Icon`、`Modal`/`Field`/`Segmented`/`Badge`/`Skeleton`/`EmptyState`/`ErrorBanner`/`SectionTitle`，加三个展示件——`MarkdownView`（包 `lib/markdown.ts`）、`AiOutput`（带「追加到内容 / 替换内容 / 复制」的流式输出容器）、`BarChart`/`LineChart`（手写 SVG，靠 `ResizeObserver` 自适应宽度）。AI 相关页面都靠 `AiOutput` + `useStream()` 两个东西拼出交互。
- **`lib/api.ts` 是唯一的网络出口**：四个 `fetch` 全在这里（普通 JSON 调用、`streamTask` 的 SSE、`streamPlatformChat` 的 SSE、下载）。页面不得自己 `fetch`。**它同时强制一条响应契约**：`api()` 只解 `{ data }` 信封（204 回 `undefined`），失败时把 `{title,status,detail,errors}` 转成 `ApiError`；下载接口走 `downloadFile`，靠 `content-disposition` 拿文件名，**不走信封**。基地址是 `import.meta.env.VITE_API_BASE_URL ?? ''`，默认同源（开发下由 Vite 代理到 3001）。
- **页面与模块不是一对一**，真实映射是：`Dashboard` ← `activity` 的 `/api/dashboard`；`Documents`/`Analytics`/`Papers`/`Research` ← 各自模块；`Mail` ← `mail`；**`Automation` 与 `Connectors` 两个页面都 ← `workspace`**（`automationRouter` 与 `connectorsRouter` 同住 `workspace.controller.ts`）；`Settings` ← `mail`（账户）+ `agent/status`；`Platform` ← `platform`（页内 8 个 tab：对话、知识库、智能体、协作、文件、工作流、审计、成员）；`Login` ← `auth`。`agent` 没有自己的页面，但被两处置用：各页的 `/api/agent/run`，以及 `Settings` 的 `GET /api/agent/status`。
- **依赖方向是单向的**：页面与 `App` 可以导入 `lib/*`；**`lib/*` 不得导入任何页面或组件**；页面之间也没有直接导入（跨页只能靠 `navigate()` 改 hash）。想抽公共逻辑（例如各页重复的 AI 流程）只能放进 `lib/`，不能由页面互相引用。
- **不引第三方 UI 或状态库**：没有 react-router、没有 redux/zustand、没有组件库、没有图表库（柱状图与折线图是手写的 SVG），也不引 CSS 框架——只有一份 `styles.css`。
- **`lib/types.ts` 是服务端 DTO 的手抄镜像**：没有任何代码生成或 schema 共享。另有两个纯数据/纯逻辑小模块：`lib/homeCatalog.ts`（首页 72 条提示词）与 `lib/theme.ts`（外观三档）。

## 关键决定

- **登录门在外壳之上**：`App` 启动先调 `/api/auth/me`，拿不到用户就只渲染 `Login`（不渲染侧栏与顶栏）；登录成功可一并拿到 `{ user, aiMode }`，登出时同时清 `user` 与 `stats`。这与 `auth` 模块的响应契约成对。
- **登录页不预填、不显示密码**：`Login.tsx` 的账号/密码初值是空串，底部提示只说「使用 `.env` 中配置的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录」。默认口令仍存在于服务端（`shared/config.ts`），但界面不再泄露或代替用户填写它。
- **hash 路由**：`window.location.hash` 即 `PageId`，`hashchange` 事件驱动 `setPage`。**允许一层子页**：`#/platform/agents` 里的第二段由 `Platform` 自己解析（`readPage` 只看第一段），所以刷新与深链不丢 tab。好处是刷新与深链天然可用、不需要服务端 fallback 配置；代价是没有嵌套路由、没有路由参数。
- **`PageId` 是联合类型，也是导航的唯一真相**：`PAGE_META`（标题/副标题，侧栏标签也取自这里的 `title`）、**`App.tsx` 的 `APP_ENTRIES`（侧栏应用列表的唯一入口，9 项，不含 `dashboard`）**、`MODULE_PAGE`（活动流水 `module` → 页面）、`App.tsx` 的渲染分支都从它派生。新增页面要同时改这四处加 `types.ts`——`dashboard` 不进 `APP_ENTRIES`，回首页靠点品牌区或顶栏首页图。**第五处是统计刷新**：会改数据的页面都要接受可选的 `onChanged?: () => void`，并在 `App` 里传 `onChanged={refreshStats}`。因为它可选，漏传不会报错——页面能编译、能工作，但侧栏的未读计数与「最近任务」会停在旧值，直到下一次 `navigate()` 或手点顶栏刷新按钮。现在所有会写数据的页面（含 `Settings` 与 `Mail`）都接了这一层。**漏掉 `MODULE_PAGE` 不会报错**——它用 `?? 'dashboard'` 兜底，于是侧栏「最近任务」点进去会静默跳到首页；**漏掉 `APP_ENTRIES` 也不会报错**——只是侧栏里少了这项应用，只能靠手敲 `#/<page>` 到达。**流水跳转按 `action` 优先**：`pageForActivity(entry)` 先看 `action`（`automation_*`/`connector_*` → 自动化页，`document_ai`/`analytics_ai`/`paper_ai`/`research_ai`/`mail_ai` → 各业务页，`stream`/`generate`/`chat` → 智能体工作台），再回落到 `MODULE_PAGE[module]`——因为绝大多数写操作记的是 `module='agent'`，只按 module 映射会把它们全导到首页。
- **应用入口只有侧栏一处，且只有 4 项**：智能邮箱、自动化任务、技能专家连接器、智能体工作台。侧栏自上而下是品牌区（点回首页）、「新建任务」按钮、「应用 (4)」、「最近任务 (n)」（可折叠，最多 5 条，点开按 `pageForActivity` 跳转）、底部引擎状态与账号按钮。**设置不占侧栏**，走左下角头像菜单；**文档协作 / 数据分析 / 论文整理 / 科学研究四个页面当前没有界面入口**——它们是「功能不是应用」的定位，只能靠 `#/<page>` 直达（产品决定，见下方已知问题）。新增入口先想清楚放侧栏哪一组，不要再往首页塞副本。
- **「新建任务」打开的是空抽屉**：`openAgent('')` 只把 `preset.nonce` 推进去触发 `AgentDrawer` 打开，`send()` 对空串直接 return，所以不会发出一句空消息——抽屉打开时只有问候语。
- **首页是一屏，不滚动**：`.launch-page` 固定 `height: calc(100vh - 54px)` + `overflow: hidden`，内部 flex 列自上而下是题头（logo + 40px 标题，左对齐）、「想做点什么」六分类标签行（**等分铺满整条**：日常办公/文档写作/数据分析/科学研究/衣食出行/人文娱乐）、四张任务卡、点位 + 「换一换」、弹性占位、贴底通栏输入框、免责说明。**加内容前先量高度**：这套布局没有纵向滚动兜底，多一行就会溢出；窗口窄于 760px 时让位给滚动。
- **卡片只填提示词，不发消息**：点卡片或标签只改输入框内容与分类，发送与否由用户决定；提示词库在 `lib/homeCatalog.ts`（6 分类 × 3 套 × 4 张），「换一换」在当前分类的 3 套之间循环并显示点位，切换分类各自记住上次到第几套。**三套内容必须真的不同**，否则换一换等于没换；改文案只改这个文件。
- **视觉只走令牌层**：全站配色、圆角、阴影、间距都从 `:root` 令牌来（`--primary: #2f4bff`、`--radius` / `--radius-sm`、`--space-1..4`、`--brand-gradient`）；图表（`rect.chart-bar`、折线图面积渐变）与各页状态图标都读 `var(--primary)`，换色只改令牌。**其余 9 个页面不为视觉改造动结构**——想统一某一页时，先看能不能落成一个公共类，不要逐页改 inline 样式。
- **账号菜单挂在左下角头像上**：`AccountMenu` 是 `position: fixed` 弹层（侧栏本身可滚动，绝对定位会被裁切），含活动、设置、外观三档（浅色/深色/系统）、日志打包、检查更新、退出登录。「活动」打开 `ActivityDrawer`，读 `/api/dashboard/activity?limit=50`，与侧栏「最近任务」同源但带模块与时间；「日志打包」走 `downloadFile('/api/system/logs')`，「检查更新」读 `/api/system/info` 的版本号并明说这是本地构建。**这两项都不会假装有更新源或假装有远端日志**。
- **外观是 `html[data-theme]` 上的一个属性**：`lib/theme.ts` 的 `useTheme()` 读 `localStorage['mirelth.theme']`（默认 `system`），写 `data-theme='light'|'dark'`，`system` 下监听 `prefers-color-scheme` 实时跟随。深色靠 `styles.css` 的 `[data-theme='dark']` 令牌块换值，**组件层不写主题分支**；为此页面里原本写死的 tint/状态色已收成 `--card-tint-*`、`--ok/--warn/--danger/--violet` 及其 soft 变体，新增颜色请用令牌。
- **`ToastProvider` 在 `main.tsx` 里包住 `App`**，不在 `App` 内部：外壳自己的账号菜单（日志下载、检查更新）也要能弹提示。- **数据加载通常走 `useLoad(loader, deps)`**：内部用 `loaderRef` 保持 loader 最新但只依赖 `deps`，返回 `{ data, loading, error, reload, setData }`。`reload` 由 `useCallback` 固定，可以安全地传给子组件。**它没有请求序号保护**：谁最后 resolved 谁就覆盖 `data`，所以依赖 `[query]` 的逐键搜索（`Mail`、`Papers`）在快速输入时可能显示上一轮的列表。**有一处绕开 `useLoad`**：`Mail` 的 `loadAccounts`（自己发请求并 `catch { /* ignore */ }`，无 loading/error）——`Documents` 的搜索框已经改回 `usePaged` 的 path 参数。
- **AI 输出的流状态是纯本地状态**：`useStream()` 提供 `text/running/error/label` 四个字段、对应的四个 setter，以及一个 `reset()`；分片由 `streamTask` 的 `onDelta` 累积**在页面里**（`let full = ''`），所以离开页面就丢失。**`/api/agent/run` 的产出一律不落库**；**唯一例外是邮件摘要**：`/api/mail/ai` 会把它写回 `messages.ai_summary`（覆盖上一份、无历史），界面另有一块「已保存的 AI 摘要」渲染它。
- **AI 的 payload 在页面里拼**：文档、文献、科研、分析与智能体抽屉自己组装 `kind + input` 打 `/api/agent/run`；邮件摘要与起草走 `/api/mail/ai`，邮件**回复**仍走 `/api/agent/run`。各页面与服务端同名 service 的组装规则是两份（见各模块 SPEC 的「三处/两处组装」条目）。
- **Markdown 是本地渲染**：`lib/markdown.ts` 的 `renderMarkdown` 先转义再拼 HTML，`MarkdownView` 用 `dangerouslySetInnerHTML` 输出。代码块与行内内容都过 `escapeHtml`，所以 Markdown 源不能注入标签；但这也意味着 HTML 直写不被支持。
- **两个流接口、两种帧格式，一份解析器**：`streamTask` 打 `/api/agent/run`（`event: meta|delta|done|error`，`data` 是片段），`streamPlatformChat` 打 `/api/platform/chat`（event 名就是步骤类型，`data` 是整条事件）。两者共用 `readFrames`——新增流接口时复用它，不要另写一份逐帧循环。
- **流式解析按 `\n\n` 切帧**：与 `agent.controller` 的写帧格式严格配对，认 `event:` 与 `data:` 两种行前缀，JSON 解析失败的帧直接跳过。

## 已知问题

- **四个业务页没有界面入口**：文档协作 / 数据分析 / 论文整理 / 科学研究 只存在于 `#/<page>`，侧栏、首页、账号菜单都不指向它们——这是「功能不是应用」的产品决定，不是漏接。要恢复入口时改 `APP_ENTRIES` 或首页分类即可，别在页面里另塞跳转。
- **`Platform` 页拆成八个面板文件**（`client/pages/platform/*.tsx`）：每个面板自己 `useLoad`，所以切 tab 会重新拉一次；只有 `status` 在父层持有、按需传入。新增面板时照这个形状加，不要再往 `Platform.tsx` 里堆。
- **`lib/markdown.ts` 是 `renderMarkdown` 的手抄副本**：与服务端 `server/shared/markdown.ts` 逻辑等价但写法已分叉（`escapeHtml`、代码块分支都不同），且**服务端那份多一个 `exportHtml`**——不要去整文件同步，会直接毁掉 `documents` 的 HTML 导出。改任一侧都要保证「站内预览」与「导出 HTML」一致。`TaskKind` 的客户端拷贝是**第四份**（见 `ai-layer`）。
- **生成结束会刷新统计**：`Documents`/`Papers`/`Research`/`Analytics`/`Mail` 在 `streamTask` 收尾时都调 `onChanged?.()`；`Settings` 保存/移除邮箱账户也调。所以「最近任务」不再停在旧值。
- **流可以被中止了**：`useStream()` 暴露 `signal`（传给 `streamTask` 的第四个参数）与 `cancel()`；`reset()` 也会 abort 在跑的流，所以切换选中项时原有的 `stream.reset()` 现在同时切断旧流——不会再出现「A 的生成结果被替换进 B 的正文」。**代价**：中止产生的 `AbortError` 会走 `catch` 显示成错误文案，各页暂未区分。
- **`Mail` 打开「邮箱设置」时若请求失败，账户列表静默为空**：`loadAccounts` 吞掉了异常，用户看到的是一个没有账户的空面板而不是错误提示。
- **逐键搜索没有竞态保护**：`Mail` 与 `Papers` 把 `q` 拼进 `usePaged` 的 path，输入快时后到的响应不一定是最后一次查询，列表会短暂停在旧结果。`Documents` 的搜索框现在也走 `usePaged`（不再自己发请求），所以同类问题一并消失。
- **各页面重复实现「拼 payload → 流式累积 → 插入/替换正文」**：`Documents`/`Papers`/`Research`/`Analytics`/`Mail`/`AgentDrawer` 各写一遍，没有共享 hook。
- **两处跳转绕过 `navigate()`**：`client/pages/Connectors.tsx` 的两个「去配置」按钮直接写 `window.location.hash`，于是不触发 `refreshStats`——统计数字会停在旧值直到下一次刷新（其余跳转都走 `navigate`）。
- **列表统一走 `usePaged`**：`path` 里带查询串（`?q=…`）时 hook 自己追加 `limit`/`offset`；`reload()` 回第一页替换，`loadMore()` 追加。文档/文献/邮件/数据集四个列表底部都是「加载更多（已加载/总数）」按钮。**新增列表接口时也应返回 `{ items, total, limit, offset }`**，否则 hook 用不了。
- **间距与字号仍没有全量阶梯**：`:root` 只补了间距令牌（`--space-1..4`），且只在首页与侧栏用上，其余页面的尺寸与间距仍是字面量；字号完全没有令牌。
- **没有测试框架也没有 eslint**：自动验证是 `npm run typecheck`（含 `tsconfig.client.json`）、`npm test`（`node:test` 的回归断言，目前不覆盖客户端）与需先启服务的手工冲烟 `npm run smoke`；`lib/hooks.ts` 等文件里还留着 `// eslint-disable-next-line` —— 那些注释现在是空的。
- **登录门只在启动时跑一次**：`App` 只在挂载时调一次 `/api/auth/me`，`setUser(null)` 的唯一路径是手动登出。会话中途失效后，各页面只会弹「登录已失效，请重新登录。」，重试永远失败（`getErrorMessage` 只把 401 映射成文案），直到刷新页面或去设置页登出。
- **错误文案有一层客户端映射**：`getErrorMessage` 对 401/403/404/429 直接短路成固定文案（429 固定是「操作过于频繁，请稍后再试。」，**服务端的 detail 到不了 UI**），只有 422 会把各字段的校验消息拼起来、其余情况才回落到 `ApiError.message`。改服务端 429 的文案在界面上看不到任何变化。
