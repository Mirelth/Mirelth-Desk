/**
 * 列表分页：`{ items, total, limit, offset }` 信封与 `?limit=&offset=`。
 */
process.env.DATABASE_PATH = '.data/regression-paging.db';
process.env.APP_SECRET = 'regression-paging-secret-0123456789';

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
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-paging.db${suffix}`, { force: true });
});

interface Paged<T> { items: T[]; total: number; limit: number; offset: number }

const getPaged = async (path: string): Promise<Paged<{ id: string }>> => {
  const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  const payload = await response.json() as { data: Paged<{ id: string }> };
  return payload.data;
};

test('documents 列表支持 limit/offset 并返回 total', async () => {
  for (const title of ['分页一', '分页二', '分页三']) {
    await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title }),
    });
  }
  const first = await getPaged('/api/documents?limit=2&offset=0');
  assert.equal(first.items.length, 2);
  assert.equal(first.total, 3);
  assert.equal(first.limit, 2);

  const second = await getPaged('/api/documents?limit=2&offset=2');
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].id, first.items[0].id);
});

test('越界 limit 会被夹住，不返回无限量', async () => {
  const page = await getPaged('/api/documents?limit=9999');
  assert.ok(page.limit <= 100, `limit 应被夹到 100 以内，实际 ${page.limit}`);
});

test('papers / mail / datasets 也返回分页信封', async () => {
  for (const path of ['/api/papers?limit=5', '/api/mail/messages?limit=5', '/api/analytics/datasets?limit=5']) {
    const page = await getPaged(path);
    assert.ok(Array.isArray(page.items), `${path} 应返回 items`);
    assert.equal(typeof page.total, 'number', `${path} 应返回 total`);
  }
});
