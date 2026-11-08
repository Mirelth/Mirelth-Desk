/**
 * HTTP 层测试：`scripts/http-errors.test.ts`。
 *
 * 用临时库 + `createApp()` 监听 0 端口，直接打真实路由——错误信封的形状与状态码
 * 只能在 HTTP 边界上验证，单元测试看不到 `errorHandler` 与中间件的顺序。
 *
 * 与 `db.test.ts` 一样：`DATABASE_PATH` / `APP_SECRET` 必须在任何 server 模块被
 * 加载之前生效，所以用动态 import。
 */
process.env.DATABASE_PATH = '.data/regression-http.db';
process.env.APP_SECRET = 'regression-http-secret-0123456789';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');

migrate();
authService.ensureAdmin();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let cookie = '';
before(async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
});

after(() => {
  server.close();
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-http.db${suffix}`, { force: true });
});

test('畸形 JSON 返回 400 并带 request_id', async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad',
  });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 400);
  assert.equal(body.title, 'BAD_REQUEST');
  assert.ok(body.request_id, '信封应包含 request_id');
});

test('未知 /api 路径返回 404 并带 request_id', async () => {
  const response = await fetch(`${base}/api/nope`, { headers: { Cookie: cookie } });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 404);
  assert.equal(body.title, 'NOT_FOUND');
  assert.ok(body.request_id, '信封应包含 request_id');
});

test('拿已删除项目的 id 建任务返回 404 而不是 500', async () => {
  const response = await fetch(`${base}/api/research/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: '孤儿任务', projectId: 'prj_does_not_exist' }),
  });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 404, `期望 404，实际 ${response.status} ${JSON.stringify(body)}`);
});

test('限流 429 带 request_id', async () => {
  let last: Response | undefined;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await fetch(`${base}/api/mail/sync`, { method: 'POST', headers: { Cookie: cookie } });
    if (last.status === 429) break;
  }
  assert.equal(last?.status, 429, '连续同步应触发 10 次/分钟的限流');
  const body = await last!.json() as Record<string, unknown>;
  assert.ok(body.request_id, '429 信封应包含 request_id');
});
