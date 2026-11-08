---
id: analytics
type: module-design
status: draft
title: 数据分析 · CSV 导入、统计与洞察
parent: architecture
depends-on:
  - shared-kernel
  - ai-layer
  - activity
  - auth
---

## 职责

把一份 CSV 变成本机能查、能算、能画、能让 AI 讲的数据集：解析与列类型推断、描述统计、分组均值、趋势、两两相关性、AI 洞察/报告，以及导出 CSV（**按解析后的行重新序列化**，不是字节级原样回写）。

## 边界

- **允许**：`shared/*`、`ai/provider`、`activity`；控制器层另需 `auth` 的 `currentUserId`（只限控制器，service 不碰会话）。
- **禁止**：`documents`（分析报告不落文档库）、`research`（实验指标与数据集是两套东西）。
- **被谁调用**：前端页面、`workspace` 的 `analytics.insights` 自动化动作。
- **目录内的两个纯函数模块**：`csv.ts`（解析与序列化）与 `analytics.stats.ts`（`describe` / `computeStats` / `pearson`）——**零 IO、零依赖**，因此可以直接单元测试，不必经过 `analytics.service.ts`（它会连带打开 SQLite）。

## CSV 契约（`csv.ts`）

这些是硬边界，写在这里比写在代码里更容易被找到：

- 最少表头 + 1 行数据；**最多 60 列**；**最多 5000 行**（超出直接 400「请先抽样」）。
- 处理 BOM、`\r\n`、`\r`；支持双引号包裹字段与 `""` 转义；全空行被丢弃。
- 空表头补成 `列N`；**重复列名直接报错**。
- 单元格转数字的条件：去逗号后 `Number.isFinite` **且** 形如 `^-?[\d,]+(\.\d+)?$`（所以 `1e5`、`0x10` 仍是字符串）；空串变 `null`。
- **列数不符与残缺引号一律报 400**（不静默丢数据）：某数据行的单元格多于表头时，**多出的部分只要有内容就报错**并指出行号（`a,b` + `1,2,3` → 「第 2 行有 1 个多余的单元格」）；行尾逗号产生的空单元格放行。引号到文件末尾仍未闭合时也报错（以前会把剩余全文并成一个字段并返回 200）。

## 类型推断与统计口径

- 列判为 `numeric` 的条件是**非空值里 ≥70% 是数字**；否则 `categorical`（并给出 `unique`）。混合列因此会被当分类列，均值不予计算。
- 分组与趋势都取**第一个分类列**作标签、**第一个数值列**作取值，没有让用户选列的口子。分组输出均值 + 计数，趋势输出求和；趋势拿不到分类列时退化成「前 24 行按行号」。
- 相关性是 Pearson，**且只在两列的有效数值个数相等且都 ≥3 时**才计算（`a.length === b.length && a.length >= 3`）；两列有效值分别 4 个与 5 个时这对直接被跳过。输出前 6 对。
- 分组最多 12 项、趋势最多 24 点、相关性最多 6 对——都在 `computeStats` 里截断。

## 关键决定

- **数据行按 JSON 存在 `datasets.rows` 里**，不建宽表、不做索引。换来「任意 CSV 都能存」，代价是每次统计都在 Node 里全表扫一遍。
- **统计覆盖全部行，预览只回 200 行**：`GET /datasets/:id` 返回的 `rows` 是 `rows.slice(0, 200)`，而 `stats` 是在全表上算的；列表接口另受 `LIMIT 100` 约束，导入内容另受 8MB 上限约束。调用方别把 `rows` 当成数据集全集。
- **AI 只拿统计结果，不拿原始行，但产品路径在前端**（与 `documents`/`papers`/`research` 同类）：`analyticsService.insights` 传的是 `datasetName/rowCount/columns/groups/trend/correlations`，没有原始行——这是「不编造数字」原则的实现方式，模型看不到它算不出来的东西。但**前端不调 `POST /datasets/:id/insights`**：`client/pages/Analytics.tsx` 自己拼了同一套 6 字段 payload 打 `/api/agent/run`。改 payload 要同时改两处，否则 UI 与 `analytics.insights` 自动化动作（走 service）会静默分歧。

## 已知问题

- **缺失值在分组/趋势/相关性里一律跳过**：`numericAt` 只认 `typeof value === 'number'`，空单元格与非数字字符串都返回 `undefined`，与列信息里的 `missing` 口径一致。（曾经用 `Number(row[col])`，而 `Number(null) === 0`，于是一个空值会把分组均值拉低。）
- **相关性按行取交集**：任一列在该行缺失或非数字，整对跳过——不再出现「两列各自过滤、序列错位」的静默错误。代价是可用样本数会变少，`>= 3` 对才计算。
- **列表分页**：`GET /datasets` 回 `{ items, total, limit, offset }`（默认 20、上限 100）。
- **没有更新/重命名接口**：只有导入、查看、删除、导出；改名要重新导入。
- **导出不能原样回写**：`exportCsv` 用的是导入时已强制转数字的行，所以 `007` 会导出成 `7`、`1,234` 变成 `1234`。带前导零的编码列（学号、订单号）通过一次导入导出就会被改。想保留原字面值需要额外存一份原始文本。
- **列名重复检测只在导入时做**，导出的 CSV 不再校验。
- **`describe` 的 `sum/mean/min/max/std` 用 `present` 里的所有值转数字**，与「非空且是数字」的判定不完全一致（例如一个 70% 数字的列里，非数字字符串会被 `Number()` 变成 `NaN` 后被 `filter(Number.isFinite)` 丢掉，但 `missing` 已经把它们算作「有值」）。
