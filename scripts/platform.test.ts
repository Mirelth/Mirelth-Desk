/**
 * `platform` 接线后的 HTTP 层测试：确认真实可调用，且**未挂载的组仍然回 404**。
 * 与 `db.test.ts` / `http-errors.test.ts` 一样用临时库 + 动态 import。
 */
process.env.DATABASE_PATH = '.data/regression-platform.db';
process.env.APP_SECRET = 'regression-platform-secret-0123456789';

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
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-platform.db${suffix}`, { force: true });
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
});

test('GET /api/platform/status 返回配额与能力清单', async () => {
  const response = await get('/api/platform/status');
  const body = await response.json() as { data: Record<string, unknown> };
  assert.equal(response.status, 200);
  assert.ok(['live', 'offline'].includes(String(body.data.mode)));
  assert.ok((body.data.quota as { limit: number }).limit > 0);
  assert.ok(Array.isArray(body.data.features));
});

test('GET /api/platform/tools 列出工具清单', async () => {
  const response = await get('/api/platform/tools');
  const body = await response.json() as { data: Array<{ name: string }> };
  assert.equal(response.status, 200);
  assert.ok(body.data.length >= 17, `至少 17 个工具，实际 ${body.data.length}`);
  assert.ok(body.data.some((tool) => tool.name === 'rag_search'));
});

test('知识库：写入 → 检索 → 重建', async () => {
  const created = await post('/api/platform/knowledge', {
    title: '季度复盘要点',
    content: '本季度交付客户看板，关闭缺陷十八个，完成文献精读。',
  });
  assert.equal(created.status, 200);

  const found = await get(`/api/platform/knowledge/search?q=${encodeURIComponent('客户看板')}`);
  const hits = (await found.json() as { data: Array<{ title: string }> }).data;
  assert.ok(hits.length > 0, '应检索到刚写入的知识');

  const reindexed = await post('/api/platform/knowledge/reindex', {});
  assert.equal(reindexed.status, 200);
});

test('会话：chat 走 SSE 后能查到会话与运行记录', async () => {
  const response = await post('/api/platform/chat', { message: '帮我写一份本周周报大纲' });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.ok(stream.includes('event: meta'), 'SSE 应先发 meta');
  assert.ok(stream.includes('event: done'), 'SSE 应以 done 收尾');

  const conversations = await get('/api/platform/conversations');
  const list = (await conversations.json() as { data: Array<{ id: string; messageCount: number }> }).data;
  assert.ok(list.length >= 1, '应至少有一个会话');

  const detail = await get(`/api/platform/conversations/${list[0].id}`);
  assert.equal(detail.status, 200);

  const runs = await get('/api/platform/runs');
  const runList = (await runs.json() as { data: Array<{ id: string }> }).data;
  assert.ok(runList.length >= 1, '应至少有一条运行记录');
});

test('未挂载的组一律 404', async () => {
  for (const path of ['/api/platform/workspaces', '/api/platform/mcp', '/api/platform/workflows', '/api/platform/audit', '/api/platform/agents']) {
    const response = await get(path);
    assert.equal(response.status, 404, `${path} 不应被挂载`);
  }
});
