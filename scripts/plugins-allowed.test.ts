/**
 * 插件在**已授权配置**下的真实调用验证。
 *
 * 为什么单独一个文件：`config` 是模块级快照，同一进程里无法既测「白名单为空即拒全部」
 * 又测「授权后能调通」。`plugins.test.ts` 跑严格默认，本文件跑显式授权。
 *
 * 授权范围仅为本测试自己起的回环假端点，不出网。
 */
process.env.DATABASE_PATH = '.data/regression-plugins-allowed.db';
process.env.APP_SECRET = 'regression-plugins-allowed-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.BROWSER_ENABLED = 'false';
// 显式授权回环 + 开启私网开关：模拟用户连接本机自建服务的场景。
process.env.PLUGINS_ALLOWED_HOSTS = '127.0.0.1';
process.env.PLUGINS_ALLOW_PRIVATE_NETWORKS = 'true';
process.env.PLUGINS_MAX_RESPONSE_BYTES = '200';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const received: Array<{ body: string; headers: Record<string, unknown> }> = [];
let mode: 'ok' | 'redirect' | 'huge' | 'error' = 'ok';
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    received.push({ body: raw, headers: req.headers as Record<string, unknown> });
    if (mode === 'redirect') {
      // 白名单内地址试图把请求带到白名单外——必须被拦住。
      res.writeHead(302, { Location: 'http://evil.invalid/steal' });
      res.end();
      return;
    }
    if (mode === 'huge') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('X'.repeat(5000));
      return;
    }
    if (mode === 'error') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('upstream exploded');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echo: raw }));
  });
});
stub.listen(0, '127.0.0.1');
await new Promise((resolve) => stub.once('listening', resolve));
const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api`;

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const { config } = await import('../server/shared/config.ts');
const { assertOutboundAllowed } = await import('../server/shared/outbound.ts');
const { executeTool, getTool } = await import('../server/features/platform/tools.ts');
const { isFailure } = await import('../server/features/platform/planner.ts');

migrate();
authService.ensureAdmin();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let cookie = '';
let userId = '';
let workspaceId = '';
before(async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  const status = await (await get('/api/platform/status')).json() as { data: { workspace: { id: string } } };
  workspaceId = status.data.workspace.id;
  userId = (await (await get('/api/auth/me')).json() as { data: { user: { id: string } } }).data.user.id;
  assert.ok(userId, '应取到当前用户 id');
});

after(() => {
  server.close();
  stub.close();
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-plugins-allowed.db${suffix}`, { force: true });
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
});

test('授权后：私网地址命中白名单即放行', () => {
  assert.deepEqual(config.plugins.allowedHosts, ['127.0.0.1']);
  assert.equal(config.plugins.allowPrivateNetworks, true);
  const target = assertOutboundAllowed(stubUrl);
  assert.equal(target.host, '127.0.0.1');
  // 白名单外的公网地址仍被拒——授权是逐域名的，不是全局放开。
  assert.throws(() => assertOutboundAllowed('https://api.example.com/x'), /不在插件白名单内/);
});

test('注册 → 出现在清单 → 真实调通，入参按声明发送', async () => {
  mode = 'ok';
  const created = await post('/api/platform/plugins', {
    name: 'local_api', description: '本机自建接口', endpoint: stubUrl,
    parameters: {
      q: { type: 'string', description: '查询词', required: true },
      topK: { type: 'number', description: '条数' },
      verbose: { type: 'boolean', description: '详细' },
    },
    authToken: 'test-token-abc',
  });
  assert.equal(created.status, 201, `已授权地址应能注册，实际 ${created.status}`);
  const body = await created.json() as { data: { hasToken: boolean; authToken?: string } };
  assert.equal(body.data.hasToken, true);
  assert.equal(body.data.authToken, undefined, '响应不得回明文 token');

  assert.ok(await getTool('local_api', workspaceId), '注册后应出现在工作区工具清单');
  const before = received.length;
  const output = await executeTool('local_api', { userId, workspaceId }, { q: '季度复盘', topK: '3', verbose: 'true', extra: '不该外发' });
  assert.ok(!isFailure(output), `应调用成功，实际：${output}`);
  assert.equal(received.length, before + 1, '应真的发出一次请求');

  const sent = JSON.parse(received[received.length - 1].body) as Record<string, unknown>;
  assert.equal(sent.q, '季度复盘');
  assert.equal(sent.topK, 3, 'number 类型应转成数字');
  assert.equal(sent.verbose, true, 'boolean 类型应转成布尔');
  assert.equal(sent.extra, undefined, '未声明的字段不得外发');
  assert.equal(sent.confirmed, undefined, '确认标记不外发');
  // 凭据由服务端注入 header，不进请求体。
  assert.equal(received[received.length - 1].headers.authorization, 'Bearer test-token-abc');
  assert.ok(!received[received.length - 1].body.includes('test-token-abc'), '凭据不得进请求体');
});

test('重定向不跟随：白名单内地址无法把请求带到白名单外', async () => {
  mode = 'redirect';
  const output = await executeTool('local_api', { userId, workspaceId }, { q: 'x' });
  assert.ok(isFailure(output), '重定向必须被判为失败而不是静默跟随');
});

test('响应体积上限：超长响应被截断并标注', async () => {
  mode = 'huge';
  const output = await executeTool('local_api', { userId, workspaceId }, { q: 'x' });
  assert.ok(!isFailure(output));
  assert.ok(output.length < 1000, `应被截断到上限附近，实际 ${output.length}`);
  assert.match(output, /已截断/);
});

test('上游 5xx：可判定失败并回写插件状态', async () => {
  mode = 'error';
  const output = await executeTool('local_api', { userId, workspaceId }, { q: 'x' });
  assert.ok(isFailure(output), '上游错误必须是可判定失败');
  assert.match(output, /500/);
  const list = (await (await get('/api/platform/plugins')).json()) as { data: Array<{ name: string; status: string; lastError: string }> };
  const item = list.data.find((plugin) => plugin.name === 'local_api');
  assert.equal(item?.status, 'error');
  assert.ok(item?.lastError, '应回写最后错误');
});

test('连通性测试：GET 探活且不发送业务入参', async () => {
  mode = 'ok';
  const list = (await (await get('/api/platform/plugins')).json()) as { data: Array<{ id: string; name: string }> };
  const target = list.data.find((plugin) => plugin.name === 'local_api')!;
  const before = received.length;
  const result = await post(`/api/platform/plugins/${target.id}/test`, {});
  assert.equal(result.status, 200);
  const body = await result.json() as { data: { ok: boolean; detail: string } };
  assert.equal(body.data.ok, true);
  assert.equal(received.length, before + 1);
  assert.equal(received[received.length - 1].body, '', '探活不得发送业务入参');
});

test('调用留痕：记录目标 host 与结果，不含凭据与完整查询串', async () => {
  const runs = await (await get('/api/platform/plugins/runs')).text();
  assert.ok(runs.includes('local_api'));
  assert.ok(!runs.includes('test-token-abc'), '留痕不得含凭据');
  const parsed = JSON.parse(runs) as { data: Array<{ host: string; status: string }> };
  assert.ok(parsed.data.every((item) => item.host === '127.0.0.1' || item.host === ''), '只记 host');
});

test('规划层能看到插件：白名单为空时继承含插件的全部工具', async () => {
  const { modelToolSchemas } = await import('../server/features/platform/tools.ts');
  const names = (await modelToolSchemas([], workspaceId)).map((schema) => schema.function.name);
  assert.ok(names.includes('local_api'), '默认智能体应能看到本工作区插件');
  const scoped = (await modelToolSchemas(['rag_search'], workspaceId)).map((schema) => schema.function.name);
  assert.ok(!scoped.includes('local_api'), '显式白名单仍应生效，插件不例外');
});