/**
 * 活动流水覆盖测试：确认真实 HTTP 路径会把变更写进 `/api/dashboard/activity`。
 * 起因是 9 条写路径曾经完全不记流水，首页「最近动态」因此看不到它们。
 */
process.env.DATABASE_PATH = '.data/regression-activity.db';
process.env.APP_SECRET = 'regression-activity-secret-0123456789';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const { seedDemoData } = await import('../server/shared/seed.ts');

migrate();
authService.ensureAdmin();
seedDemoData(); // 需要演示邮件来验证「打开未读邮件」这条路径

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
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-activity.db${suffix}`, { force: true });
});

const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json() as { data: T };
  return payload.data;
};

test('9 条漏记路径现在都会进流水', async () => {
  // 文献：创建 → 编辑
  const paper = await call<{ id: string }>('POST', '/api/papers', { title: '流水测试文献' });
  await call('PATCH', `/api/papers/${paper.id}`, { notes: '一条笔记' });

  // 科研：项目 → 编辑；任务 → 创建 → 编辑 → 删除；实验 → 创建 → 删除
  const project = await call<{ id: string }>('POST', '/api/research/projects', { name: '流水测试项目' });
  await call('PATCH', `/api/research/projects/${project.id}`, { status: 'paused' });
  const task = await call<{ id: string }>('POST', '/api/research/tasks', { title: '流水测试任务', projectId: project.id });
  await call('PATCH', `/api/research/tasks/${task.id}`, { status: 'doing' });
  await call('DELETE', `/api/research/tasks/${task.id}`);
  const experiment = await call<{ id: string }>('POST', '/api/research/experiments', { title: '流水测试实验', projectId: project.id });
  await call('DELETE', `/api/research/experiments/${experiment.id}`);

  // 自动化：任务编辑；连接器编辑与连通性测试
  const task2 = await call<{ id: string }>('POST', '/api/automation', { name: '流水测试自动化', action: 'mail.summary' });
  await call('PATCH', `/api/automation/${task2.id}`, { description: '改个描述' });
  const connector = await call<{ id: string }>('POST', '/api/connectors', { name: '流水测试连接器', baseUrl: `${base}/health` });
  await call('PATCH', `/api/connectors/${connector.id}`, { description: '改个描述' });
  await call('POST', `/api/connectors/${connector.id}/test`);

  // 邮件：标记未读 → 打开（隐式已读）
  const messages = await call<{ items: Array<{ id: string }> }>('GET', '/api/mail/messages?folder=inbox');
  assert.ok(messages.items.length > 0, '演示数据里应有收件箱邮件');
  await call('PATCH', `/api/mail/messages/${messages.items[0].id}`, { isRead: false });
  await call('GET', `/api/mail/messages/${messages.items[0].id}`);

  const activity = await call<Array<{ module: string; action: string; description: string }>>('GET', '/api/dashboard/activity?limit=100');
  const actions = activity.map((entry) => entry.action);
  const has = (needle: string) => activity.some((entry) => entry.action === needle || entry.description.includes(needle));

  for (const expected of ['update', 'delete', 'automation_update', 'connector_update', 'connector_test', 'read']) {
    assert.ok(actions.includes(expected), `流水应包含 action=${expected}`);
  }
  assert.ok(has('更新文献'), '文献编辑应留痕');
  assert.ok(has('更新研究项目'), '项目编辑应留痕');
  assert.ok(has('更新任务'), '任务编辑应留痕');
  assert.ok(has('删除任务'), '任务删除应留痕');
  assert.ok(has('删除实验'), '实验删除应留痕');
  assert.ok(has('更新自动化任务'), '自动化任务编辑应留痕');
  assert.ok(has('更新连接器'), '连接器编辑应留痕');
  assert.ok(has('测试连接器'), '连通性测试应留痕');
  assert.ok(has('标记邮件'), '已读/未读切换应留痕');
  assert.ok(has('阅读邮件'), '打开未读邮件应留痕');
});
