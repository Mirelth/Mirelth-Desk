/**
 * `platform` 的 HTTP 层测试：状态、工具、知识库、会话、账号与 API Key、
 * 工作区/成员/智能体/文件/版本/事件/工作流/审计/用量/MCP。
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

test('账号管理：安装管理员建号后新账号能登录，普通账号建不了号', async () => {
  const created = await post('/api/auth/users', { username: 'analyst', password: 'analyst-pass-1' });
  assert.equal(created.status, 201);

  const listed = await get('/api/auth/users');
  const page = (await listed.json() as { data: { items: Array<{ id: string; username: string }>; total: number } }).data;
  assert.ok(page.total >= 2);
  assert.ok(page.items.some((item) => item.username === 'analyst'));
  assert.ok(!JSON.stringify(page).includes('password'), '列表不得包含口令字段');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'analyst', password: 'analyst-pass-1' }),
  });
  assert.equal(login.status, 200, '新账号应能登录');
  const analystCookie = login.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');

  const denied = await fetch(`${base}/api/auth/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: analystCookie },
    body: JSON.stringify({ username: 'intruder', password: 'intruder-pass-1' }),
  });
  assert.equal(denied.status, 403, '非安装管理员不能建号');

  const selfDelete = await fetch(`${base}/api/auth/users/${(page.items.find((item) => item.username === 'admin') ?? { id: '' }).id}`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(selfDelete.status, 409, '不能删除安装管理员');
});

test('工作区 API Key：创建只回一次明文，列表不回，撤销后失效', async () => {
  const status = await get('/api/platform/status');
  const workspaceId = (await status.json() as { data: { workspace: { id: string } } }).data.workspace.id;

  const created = await post(`/api/platform/workspaces/${workspaceId}/keys`, { name: '外部回调', role: 'member' });
  assert.equal(created.status, 201);
  const key = (await created.json() as { data: { id: string; key: string; prefix: string } }).data;
  assert.ok(key.key.startsWith('mdk_'), '明文只在创建响应里');

  const listed = await get(`/api/platform/workspaces/${workspaceId}/keys`);
  const keys = (await listed.json() as { data: Array<{ id: string; key?: string }> }).data;
  assert.ok(keys.some((item) => item.id === key.id));
  assert.ok(keys.every((item) => item.key === undefined), '列表不得回明文');

  const revoked = await fetch(`${base}/api/platform/workspaces/${workspaceId}/keys/${key.id}`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(revoked.status, 200);
  const after = (await (await get(`/api/platform/workspaces/${workspaceId}/keys`)).json() as { data: Array<{ id: string; revokedAt: string | null }> }).data;
  assert.ok(after.find((item) => item.id === key.id)?.revokedAt, '撤销后应带 revokedAt');
});

test('X-Api-Key 不能当全站通行证：非 webhook/mcp 路由仍要会话', async () => {
  const response = await fetch(`${base}/api/platform/status`, { headers: { 'X-Api-Key': 'mdk_deadbeef_' + 'a'.repeat(32) } });
  assert.equal(response.status, 401);
});

test('原先 deferred 的组现在都返回 200', async () => {
  for (const path of [
    '/api/platform/workspaces', '/api/platform/agents', '/api/platform/shares', '/api/platform/comments?documentId=x',
    '/api/platform/versions?documentId=x', '/api/platform/files', '/api/platform/events',
    '/api/platform/workflows', '/api/platform/audit', '/api/platform/usage',
  ]) {
    const response = await get(path);
    assert.equal(response.status, 200, `${path} 应已挂载`);
  }
});

test('工作区与成员：新建工作区、把另一个账号加为成员', async () => {
  const created = await post('/api/platform/workspaces', { name: '联合项目' });
  assert.equal(created.status, 201);
  const workspaceId = (await created.json() as { data: { id: string } }).data.id;

  const added = await post(`/api/platform/workspaces/${workspaceId}/members`, { username: 'analyst', role: 'member' });
  assert.equal(added.status, 201);
  const members = (await (await get(`/api/platform/workspaces/${workspaceId}/members`)).json() as { data: Array<{ username: string; role: string }> }).data;
  assert.ok(members.some((item) => item.username === 'analyst' && item.role === 'member'));
});

test('智能体定义：建、改、删', async () => {
  const created = await post('/api/platform/agents', { name: '周报助手', tools: ['document_outline'], maxSteps: 3 });
  assert.equal(created.status, 201);
  const id = (await created.json() as { data: { id: string } }).data.id;

  const patched = await fetch(`${base}/api/platform/agents/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: '周报助手 v2' }),
  });
  assert.equal(patched.status, 200);
  const list = (await (await get('/api/platform/agents')).json() as { data: Array<{ name: string }> }).data;
  assert.ok(list.some((item) => item.name === '周报助手 v2'));

  const deleted = await fetch(`${base}/api/platform/agents/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(deleted.status, 200);
});

test('文件：上传后下载得到同一份内容', async () => {
  const created = await post('/api/platform/files', {
    filename: 'notes.txt', mime: 'text/plain', contentBase64: Buffer.from('里程碑记录').toString('base64'),
  });
  assert.equal(created.status, 201);
  const id = (await created.json() as { data: { id: string } }).data.id;

  const download = await get(`/api/platform/files/${id}/download`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), '里程碑记录');
});

test('版本：快照后改文档，恢复能回到快照内容', async () => {
  const created = await post('/api/documents', { title: '版本测试文档', content: '第一版正文', kind: 'general' });
  assert.equal(created.status, 201);
  const doc = (await created.json() as { data: { id: string; title: string } }).data;

  const snapshot = await post('/api/platform/versions', { documentId: doc.id, note: '初稿快照' });
  assert.equal(snapshot.status, 201);
  const versionId = (await snapshot.json() as { data: { id: string } }).data.id;

  const patched = await fetch(`${base}/api/documents/${doc.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: '被改过的标题' }),
  });
  assert.equal(patched.status, 200);

  const restored = await post(`/api/platform/versions/${versionId}/restore`, {});
  assert.equal(restored.status, 200);
  const after = (await (await get(`/api/documents/${doc.id}`)).json() as { data: { title: string } }).data;
  assert.equal(after.title, doc.title, '恢复后标题应回到快照时的值');
});

test('事件：webhook 带 API Key 触发后能匹配到事件型任务', async () => {
  const task = await post('/api/automation/', {
    name: '入库通知', action: 'mail.sync', triggerType: 'event', eventKey: 'dataset.ready', enabled: true,
  });
  assert.equal(task.status, 201);

  const status = await get('/api/platform/status');
  const workspaceId = (await status.json() as { data: { workspace: { id: string } } }).data.workspace.id;
  const created = await post(`/api/platform/workspaces/${workspaceId}/keys`, { name: '外部回调', role: 'member' });
  const keyBody = (await created.json() as { data: { id: string; key: string } }).data;
  const key = keyBody.key;

  const hook = await fetch(`${base}/api/platform/webhook/dataset.ready`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify({ source: 'ci' }),
  });
  assert.equal(hook.status, 200, '带正确 Key 应能调到 webhook');
  const result = (await hook.json() as { data: { matched: number; executed: number } }).data;
  assert.ok(result.matched >= 1, `应匹配到刚建的事件任务，实际 ${result.matched}`);
  assert.equal(result.executed, result.matched);

  const revoked = await fetch(`${base}/api/platform/workspaces/${workspaceId}/keys/${keyBody.id}`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(revoked.status, 200);
  const afterRevoke = await fetch(`${base}/api/platform/webhook/dataset.ready`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key }, body: '{}',
  });
  assert.equal(afterRevoke.status, 401, '撤销后的 Key 应被拒绝');
});

test('MCP：JSON-RPC 直接回协议对象，initialize 与 tools/list 可用', async () => {
  const init = await post('/api/platform/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(init.status, 200);
  const initBody = await init.json() as { result?: { serverInfo?: { name?: string } } };
  assert.equal(initBody.result?.serverInfo?.name, 'mirelth-desk', 'MCP 回协议对象而非 {data} 信封');

  const listed = await post('/api/platform/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (await listed.json() as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
  assert.ok(tools.length >= 17);
});
