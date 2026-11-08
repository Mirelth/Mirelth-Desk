---
id: auth
type: module-design
status: draft
title: 鉴权 · 单管理员账号与会话
parent: architecture
depends-on:
  - shared-kernel
---

## 职责

一次安装一个管理员账号的登录、会话与身份解析。提供三样东西：一个用 `scrypt` 存的密码、一个「HMAC 签名 Cookie + 服务端 `sessions` 表」双检的会话、以及让其他所有模块取到「当前用户 id」的中间件。

## 边界

- **对外暴露的东西，按调用方分三类**：①`authenticate`（挂在 `/api` 前缀上）、`currentUserId(req)`、`cookieOptions` 与 `SESSION_COOKIE`——业务控制器与中间件用；②`authRouter`——`app.ts` 在受保护前缀之外挂载它；③`authService.ensureAdmin()` 与 `authService.cleanup()`——启动序（`index.ts`）与演示数据（`shared/seed.ts`）用。最后这条就是图谱里唯一一处 `shared → features` 的反向边。
- **允许**：`shared/*`（config、crypto、errors、logger）。
- **禁止**：任何业务概念（域知识）。它不知道「文档」「邮件」，也不做权限——没有角色、没有资源级授权，`user_id` 是唯一的隔离维度。**但有一处 AI 概念泄漏**：`POST /login` 与 `GET /me` 的响应体是 `{ data: { user, aiMode } }`，`aiMode` 由 `config.llm.enabled` 现算——它也是前端顶栏与登录后状态的主要来源（`client/App.tsx` 启动时只调 `/api/auth/me`），但**不是唯一**：`client/pages/Settings.tsx` 另外直接查 `/api/agent/status` 渲染模型与模式，`activity.stats().ai` 又自带一份。改模式判定时要一并同步三处（见 `ai-layer` 的「运行模式被重算」条目）。
- 依赖方向是别的模块指向它：`features/*` 的控制器都 `import { currentUserId } from '../auth/auth.middleware.ts'`。

## 关键决定

- **密码**：`scryptSync(password, salt, 64)`，每用户 16 字节随机盐；校验用 `timingSafeEqual` 且先比长度。
- **会话是双检而非纯无状态**：Cookie 里只有 `{ sid, exp }`（base64url）+ `HMAC-SHA256`，**密钥是 `SHA-256(config.secret)`**，其中 `config.secret` 就是 `APP_SECRET`，而未配置时开发环境用自动生成的 `.data/secret.key`（所以删掉该文件会让所有会话失效，无需改环境变量），有效期 7 天；每次请求还要查 `sessions` 表里是否有未过期的 `sid` 行。因此「登出」和「踢掉会话」是删行，不必等 Cookie 过期或轮换密钥。
- **Cookie**：`httpOnly` + `sameSite=lax` + `path=/`，`secure` 只在生产打开——开发下走 http 也能登录。
- **管理员只在库空时创建**：`ensureAdmin()` 的判断是 `users` 表是否为空。**改 `.env` 里的 `ADMIN_PASSWORD` 不会改掉已存在账号的密码**，想重置得删库或删 `users` 行。
- **登录接口限流 20 次/分钟**，键是 `ip:path`（限流器本身的局限见 `shared-kernel`）。

## 已知问题

- **过期会话行只在一个地方被清理**：`cleanup()`（删 `expires_at <= now` 的会话）只有 `shared/seed.ts` 在灌演示数据时调用一次，没有定时任务。库里 `sessions` 行会随登录次数单调增长。
- **`/api/auth/context` 与 `/api/auth/me` 重叠**：两者都在返回当前用户；`context` 多套了一层 `rateLimit`，并且绕过 `authService` 直接调 `authRepository.findById`。前端目前只用 `me`。
- **`me` 重复解析两次会话**：`authenticate` 中间件已经解析过一次，路由处理器又调 `authService.resolve(...)` 一次（两次都会查库）。
- **没有改密码、没有「登出全部设备」的接口**；`ADMIN_USERNAME` 也只在建号时生效。
- **没有自动化测试**：登录成功/失败、会话过期、撤销后立刻失效这几条现在只有 `scripts/smoke.ts` 里的一条 200 与一条未登录 401。
