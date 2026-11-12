---
id: system-module
type: module-design
status: active
title: 系统模块 · 版本自检与诊断日志打包
parent: architecture
depends-on: [shared-kernel]
---

## 职责

外壳自己需要、但不属于任何业务域的两件事：告诉客户端「我现在是哪个版本、跑在什么环境」，以及把排查问题所需的信息打成一个纯文本包下载下来。它只读，不写库，也不产生业务数据。

## 边界

- 两条路由，都挂在 `/api/system` 下，**在 `app.use('/api', authenticate)` 之后**，所以只有已登录会话能取。日志包里没有账号口令、`APP_SECRET`、模型密钥或邮箱凭据——排查用不到它们。
- 版本号只读一次 `package.json`：读不到时回落到 `0.0.0`，**不让一个读文件失败把整个服务带崩**。
- 日志只来自 `shared/logger` 的进程内环形缓冲（500 行、重启即清空），不落盘、不读历史文件；控制台输出仍是日志的唯一真相。
- 不判断「有没有新版本」——本产品没有更新源，所谓检查更新就是读自己的版本号并明说这是本地构建。

## 关键决定

- **`GET /api/system/info` 回 `{ data }` 信封**：版本、`build: 'local'`、启动时间与运行秒数、Node 版本、平台、`env`、引擎模式与模型名、`updatesUrl`（来自 `UPDATES_URL`，未配置时为 `null`）。客户端用它显示「v1.0.0」并回一句「本地构建，已是最新」。
- **`GET /api/system/logs` 不走信封**：`text/plain; charset=utf-8` + `content-disposition: attachment`，客户端必须用 `downloadFile` 收（`api()` 会把它当 JSON 解开而失败）。文件名带 ISO 时间戳。
- **日志包是「给人贴的」而不是机器格式**：开头一段版本/环境/运行时长/生成时间，随后是最多 500 行 JSON 日志原文。刻意保留 JSON 行而不做二次解析，出问题时能直接和用户贴的 `request_id` 对上。
- 日志缓冲放在 `logger.ts` 而不是这里：只有 logger 自己知道每条写了什么，外部模块拿不到写入口。
