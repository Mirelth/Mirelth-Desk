---
id: mail
type: module-design
status: active
title: 智能邮箱 · IMAP 同步、SMTP 发送与 AI 处理
parent: architecture
depends-on: [shared-kernel, ai-layer, activity, auth]
---

## 职责

本机邮箱：账户配置（IMAP + SMTP，密码加密存储）、收件同步、邮件列表与详情、已读标记、发送、以及三种 AI 处理（摘要、回复、起草）。

## 边界

- **允许**：`shared/*`（含 `encryptSecret`/`decryptSecret`）、`ai/provider`、`activity`；控制器层需要 `currentUserId`。
- **禁止**：`documents`/`papers`/`research`。邮件正文可以被其他模块读（`platform` 的 `mail_latest`/`mail_sync` 工具、`rag.reindex` 直接 `SELECT messages`），但方向是别人来找它。
- **被谁调用**：前端页面；`workspace` 的 `mail.sync`/`mail.summary` 自动化动作（会调 `status`/`sync`/`list`/`ai`——**改 `sync` 的返回形状会打断它们**）；`platform` 的 `mail_sync`/`mail_latest` 工具；以及 `platform/rag.ts` 的 `reindex`（直接 `SELECT messages` 表）。
- **对外协议边界**：`imapflow` 与 `nodemailer` 只在这里出现。

## 关键决定

- **没有账户也不报错**：`sync` 返回 `{ synced: 0, accounts: 0, note: '尚未配置邮箱账户…' }`，界面继续展示内置演示邮件（`shared/seed.ts` 灌入，`remote_id` 以 `demo-` 开头）；`send` 在无 SMTP 时仍写入「已发送」，只是 `delivered: false` 并附 `note` 说明未真实投递。
- **「演示」徽标由服务端判定**：`messageDto` 返回 `simulated`（`remote_id` 以 `demo-` 或 `local-` 开头），前端只渲染这个 flag。所以徽标不等于 seed 数据，只等于「不是真实收发的」——未配置 SMTP 时本地存下的那封「已发送」同样会带徽标。
- **同步是显式触发 + 幂等 upsert**：只拉 `INBOX` 最近 30 封（`total-29:total`），幂等键是 `(account_id, folder='inbox', remote_id=uid)`。命中已有行时**只更新 `is_read`**，不更新主题与正文——远端改过的邮件在本地不会跟着变。返回的 `synced` 只统计新建行。
- **多账户串行、局部失败不中断（但抛错条件很宽）**：一个账户抛错只记 `errors[]` 并继续下一个；**只要本轮有任一账户报错且回写 0 条新行，就抛 `MAIL_SYNC_FAILED`（502）**。注意后半个条件极易满足：第二次同步时所有账户都会 0 条新行，此时只要有一个账户密码错就会 502，已成功那部分的结果与 `errors` 明细一起丢掉（调用方只看 `note ?? synced`）。
- **存下来的是整封原始邮件过一遍 `stripHtml`，不是解码后的正文**：`body_text` 取的是 IMAP 的 `source`（含 `Date`/`Received` 等头部与 multi-part 分隔符、quoted-printable / base64 段），未做 MIME 解码与分段选择，只去掉了标签与 `<style>`/`<script>` 并截断到 100k。真实多部分邮件同步后，详情页与 AI 摘要都会带上头部行与编码残渣。
- **发件账户的选择口径**：`send` 不传 `accountId` 时回落到 `firstAccount`（`ORDER BY created_at DESC LIMIT 1`，即**最新创建的账户**），而撰写表单从不传 `accountId`；`sync` 却遍历全部账户，`status` 只报首个。配两个账户后，UI 发出的邮件会静默从最新那个发出。
- **AI 的三条路径写入不对称**：只有 `summary` 会把结果写回 `messages.ai_summary`（**覆盖上一份摘要，无历史**），`reply` 与 `compose` 不落库；所以 `messageDto.aiSummary` 只反映最近一次摘要。与 `papers`/`documents` 的「AI 输出不落库」正好相反。
- **凭据加密后入库**：`encryptSecret`（AES-256-GCM，密钥派生自 `config.secret`）。解密只在建连接时发生，见 `shared-kernel` 关于轮换密钥会打断同步/发送/连接器测试的条目。
- **附件不存在**：这条不是省略，是当前边界——IMAP fetch 取的是 `envelope + source + flags`，落库只有 `body_text`。

## 已知问题

- **打开邮件会隐式写已读，并留一条流水**：`mailService.get` 发现 `is_read = 0` 就 `markRead` 并记 `mail/read`；`PATCH /messages/:id` 的显式标记同样记。所以读邮件会进「最近动态」。
- **同步没有超时与退避**：`ImapFlow` 只传了 host/port/secure/auth/logger（`logger: false` 关掉了它自带的输出），未设连接超时；每次 `POST /sync` 限流 10 次/分钟，但没有重试或队列。
- **删除远端邮件不会同步删除本地**；账户删除后其邮件仍在（`messages.account_id` 无外键约束，见下）。
- **`messages` 表对 `account_id` 没有外键**（`001_init.sql` 只给 `user_id` 加了级联），所以删账户留下的是「无主邮件」而不是被级联清掉。
- **发件方向 `from_addr` 是 `我 <账户邮箱>`**：`insertSent` 的展示文案由调用方传入，`send` 传 `我 <${account.email}>`（无账户时 `我 <演示账户>`），所以按 `from_addr` 做「发出统计」在有账户时是可用的。收件侧分两种：**IMAP 同步来的行**写信封 `To`（缺头才回落 `account.email`），**seed 的演示收件行**写的是 `我 <me@local>` 这类占位——全新安装、没配账户时按 `to_addr` 聚合仍只会得到一个占位地址。
- **列表分页**：`GET /messages` 回 `{ items, total, limit, offset }`，控制器默认 `limit=50`、`pageQuery` 上限 100；前端「加载更多」递增 offset。仓储另有 `messages()` 的老接口（`limit` 夹在 1..200），自动化与 `platform` 工具仍用它取前 N 封。
- **SMTP 失败会丢已写好的邮件**：`send` 先建 transport 再发送，发送抛错就抛 502，**本地「已发送」里不会留下这封**（只有未配置账户的分支才会存草稿）。
- **没有自动化测试**：`scripts/smoke.ts` 只校验 `/status` 与 `/messages` 返回 200、以及一次 AI 回复草稿非空；IMAP/SMTP 真实路径从未被自动跑过。
