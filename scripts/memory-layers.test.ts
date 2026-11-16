/**
 * 四层记忆测试。
 *
 * 重点验证三条不变量：
 * 1. **偏好与事实绝不自动写入**（旧版正则自动入库的缺陷不复活）；
 * 2. **会话短期记忆不跨会话泄漏**；
 * 3. **执行经验层默认关闭**，开启后记的是客观运行事实且带保留期。
 * 另测分层预算、跨层去重、按层清空、过期清理。
 */
process.env.DATABASE_PATH = '.data/regression-memory-layers.db';
process.env.APP_SECRET = 'regression-memory-layers-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.BROWSER_ENABLED = 'false';
// 本文件默认关闭 episodic，另用子进程配置验证开启后的行为。
process.env.MEMORY_EPISODIC_ENABLED = 'false';
process.env.MEMORY_RECALL_TOTAL = '8';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate, run } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const { config } = await import('../server/shared/config.ts');
const { memoriesService, MEMORY_LAYERS } = await import('../server/features/platform/memories.ts');

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
});

after(() => {
  server.close();
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-memory-layers.db${suffix}`, { force: true });
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
});
const del = (path: string) => fetch(`${base}${path}`, { method: 'DELETE', headers: { Cookie: cookie } });

function clearAll(): void {
  run('DELETE FROM memories WHERE workspace_id = ?', workspaceId);
}

// ---------------------------------------------------------------- 分层归属

test('四层定义完整，kind 正确归层', () => {
  clearAll();
  assert.deepEqual(MEMORY_LAYERS, ['working', 'preference', 'semantic', 'episodic']);
  const pref = memoriesService.save(workspaceId, userId, '汇报材料一律用简体中文', 'preference');
  assert.equal(pref.layer, 'preference');
  const fact = memoriesService.save(workspaceId, userId, '项目代号是蓝鲸', 'fact');
  assert.equal(fact.layer, 'semantic');
  const project = memoriesService.save(workspaceId, userId, '季度目标是交付看板', 'project');
  assert.equal(project.layer, 'semantic', 'project 归入 semantic 层');

  const counts = memoriesService.countByLayer(workspaceId, userId);
  assert.equal(counts.preference, 1);
  assert.equal(counts.semantic, 2);
  assert.equal(counts.working, 0);
  assert.equal(counts.episodic, 0);
});

test('跨层去重：同一句话不在偏好与事实里各存一份', () => {
  clearAll();
  const first = memoriesService.save(workspaceId, userId, '统一使用国际单位制', 'fact');
  const second = memoriesService.save(workspaceId, userId, '统一使用国际单位制', 'preference');
  assert.equal(second.deduplicated, true, '应识别为重复');
  assert.equal(second.id, first.id, '应更新既有行而非新增');
  assert.equal(second.layer, 'preference', '重复保存可改层');
  assert.equal(memoriesService.count(workspaceId, userId), 1);
});

test('会话短期记忆：带过期时间且绑定会话', () => {
  clearAll();
  const noted = memoriesService.saveWorking(workspaceId, userId, 'con-a', '本轮只统计华东区数据', 30);
  assert.equal(noted.layer, 'working');
  const list = memoriesService.list(workspaceId, userId, 'working');
  assert.equal(list.length, 1);
  assert.equal(list[0].conversationId, 'con-a');
  assert.ok(list[0].expiresAt, '短期记忆必须带过期时间');
  assert.ok(new Date(list[0].expiresAt!).getTime() > Date.now(), '过期时间应在未来');
  assert.ok(new Date(list[0].expiresAt!).getTime() <= Date.now() + 31 * 60_000);
});

test('会话隔离：短期记忆不跨会话泄漏', async () => {
  clearAll();
  memoriesService.saveWorking(workspaceId, userId, 'con-a', '会话A的临时口径：只看华东');
  memoriesService.saveWorking(workspaceId, userId, 'con-b', '会话B的临时口径：只看华南');

  const inA = await memoriesService.recallLayered(workspaceId, userId, '统计口径', { conversationId: 'con-a' });
  assert.ok(inA.byLayer.working.some((item) => item.includes('华东')));
  assert.ok(!inA.byLayer.working.some((item) => item.includes('华南')), 'A 会话不得看到 B 的短期记忆');

  const inB = await memoriesService.recallLayered(workspaceId, userId, '统计口径', { conversationId: 'con-b' });
  assert.ok(inB.byLayer.working.some((item) => item.includes('华南')));
  assert.ok(!inB.byLayer.working.some((item) => item.includes('华东')));

  // 不带会话时，短期层一条都不该出现。
  const noSession = await memoriesService.recallLayered(workspaceId, userId, '统计口径');
  assert.equal(noSession.byLayer.working.length, 0, '无会话上下文时不得召回短期记忆');
});

test('长期记忆跨会话可见，不受会话隔离影响', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '所有金额保留两位小数', 'preference');
  const inA = await memoriesService.recallLayered(workspaceId, userId, '金额格式', { conversationId: 'con-a' });
  const inB = await memoriesService.recallLayered(workspaceId, userId, '金额格式', { conversationId: 'con-b' });
  assert.ok(inA.byLayer.preference.length >= 1, '偏好应跨会话可见');
  assert.ok(inB.byLayer.preference.length >= 1);
});

// ---------------------------------------------------------------- 不自动写入

test('执行经验层默认关闭：运行后不自动写入', async () => {
  clearAll();
  assert.equal(config.memory.episodicEnabled, false);
  const result = memoriesService.recordEpisode(workspaceId, userId, {
    runId: 'run-x', goal: '写周报', tools: ['document_draft'], ok: true,
  });
  assert.equal(result.recorded, false, '默认关闭时不应写入');
  assert.equal(memoriesService.countByLayer(workspaceId, userId).episodic, 0);
});

test('偏好与事实不因对话自动入库（旧缺陷不复活）', async () => {
  clearAll();
  // 这几句都含旧版正则会命中的词，但不该产生任何长期记忆。
  for (const message of ['记住我喜欢简洁的汇报', '以后都用英文写', '我的偏好是深色主题']) {
    const response = await post('/api/platform/chat', { message });
    assert.equal(response.status, 200);
    await response.text();
  }
  const counts = memoriesService.countByLayer(workspaceId, userId);
  assert.equal(counts.preference, 0, '不得因关键词自动写入偏好');
  assert.equal(counts.semantic, 0, '不得因关键词自动写入事实');
});

test('显式保存仍然可用（工具与手动两条路）', async () => {
  clearAll();
  const created = await post('/api/platform/memories', { content: '手动保存的偏好', kind: 'preference' });
  assert.equal(created.status, 201);
  const body = await created.json() as { data: { layer: string } };
  assert.equal(body.data.layer, 'preference');
  assert.equal(memoriesService.countByLayer(workspaceId, userId).preference, 1);
});

// ---------------------------------------------------------------- 分层召回

test('分层预算：偏好有保底配额，不被最新琐事挤掉', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '报告必须包含风险章节', 'preference');
  // 写入大量与查询更相关的事实，验证偏好仍有位置。
  for (let index = 0; index < 12; index += 1) {
    memoriesService.save(workspaceId, userId, `季度复盘数据要点 ${index} 营收与成本`, 'fact');
  }
  const recall = await memoriesService.recallLayered(workspaceId, userId, '季度复盘数据要点');
  assert.ok(recall.byLayer.preference.length >= 1, '偏好层必须有保底配额');
  assert.ok(recall.byLayer.preference.some((item) => item.includes('风险章节')));
  assert.ok(recall.items.length <= config.memory.recallTotal, '总条数受上限约束');
  assert.ok(recall.byLayer.semantic.length >= 1, '事实层应按相关性召回');
});

test('跨层去重：召回结果不含重复内容', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '统一口径为自然月', 'preference');
  // 手工插一条同内容的 semantic 行，模拟历史数据跨层重复。
  const { insertRow } = await import('../server/features/platform/store.ts');
  insertRow('memories', {
    workspace_id: workspaceId, user_id: userId, kind: 'fact', layer: 'semantic',
    content: '统一口径为自然月', normalized_content: '统一口径为自然月', source: 'manual',
  });
  const recall = await memoriesService.recallLayered(workspaceId, userId, '统一口径');
  const occurrences = recall.items.filter((item) => item.includes('统一口径为自然月')).length;
  assert.equal(occurrences, 1, '同一内容只应出现一次');
});

test('命中计数回写：用户能看出哪条记忆真在用', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '图表配色用品牌蓝', 'preference');
  await memoriesService.recallLayered(workspaceId, userId, '图表配色');
  const list = memoriesService.list(workspaceId, userId, 'preference');
  assert.ok(list[0].hitCount >= 1, '命中后计数应递增');
  assert.ok(list[0].lastHitAt, '应记录最近命中时间');
});

test('兼容旧接口：recall 仍返回拍平列表', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '接口兼容性偏好', 'preference');
  const items = await memoriesService.recall(workspaceId, userId, '接口兼容', 3);
  assert.ok(Array.isArray(items));
  assert.ok(items.length <= 3);
  assert.ok(items.some((item) => item.includes('接口兼容性偏好')));
});

// ---------------------------------------------------------------- 生命周期

test('过期记忆不参与召回也不展示', async () => {
  clearAll();
  memoriesService.saveWorking(workspaceId, userId, 'con-a', '马上过期的临时信息', 1);
  // 手工把它改成已过期。
  run('UPDATE memories SET expires_at = ? WHERE workspace_id = ? AND layer = ?',
    new Date(Date.now() - 60_000).toISOString(), workspaceId, 'working');
  const list = memoriesService.list(workspaceId, userId, 'working');
  assert.equal(list.length, 0, '过期记忆不展示');
  const recall = await memoriesService.recallLayered(workspaceId, userId, '临时信息', { conversationId: 'con-a' });
  assert.equal(recall.byLayer.working.length, 0, '过期记忆不召回');
});

test('清理过期：只删过期项，保留有效记忆', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '长期有效的偏好', 'preference');
  memoriesService.saveWorking(workspaceId, userId, 'con-a', '已过期的短期项', 1);
  run('UPDATE memories SET expires_at = ? WHERE layer = ?',
    new Date(Date.now() - 60_000).toISOString(), 'working');
  const removed = memoriesService.purgeExpired(workspaceId, userId);
  assert.equal(removed, 1);
  assert.equal(memoriesService.countByLayer(workspaceId, userId).preference, 1, '长期偏好不受影响');
  assert.equal(memoriesService.count(workspaceId, userId), 1);
});

test('按层清空：可只清经验层而保留偏好', () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '要保留的偏好', 'preference');
  memoriesService.save(workspaceId, userId, '要清掉的事实', 'fact');
  const removed = memoriesService.clearLayer(workspaceId, userId, 'semantic');
  assert.equal(removed, 1);
  const counts = memoriesService.countByLayer(workspaceId, userId);
  assert.equal(counts.semantic, 0);
  assert.equal(counts.preference, 1, '偏好层不应被牵连');
});

test('短期层满时淘汰最旧而非报错', () => {
  clearAll();
  const cap = config.memory.workingMax;
  for (let index = 0; index < cap + 3; index += 1) {
    memoriesService.saveWorking(workspaceId, userId, 'con-a', `临时信息 ${index}`);
  }
  const counts = memoriesService.countByLayer(workspaceId, userId);
  assert.ok(counts.working <= cap, `短期层不应超过上限 ${cap}，实际 ${counts.working}`);
  const list = memoriesService.list(workspaceId, userId, 'working');
  assert.ok(list.some((item) => item.content.includes(`临时信息 ${cap + 2}`)), '最新的应保留');
});

test('分层上限：长期层填满后写入报可读错误，不静默丢弃', async () => {
  clearAll();
  const { insertRow } = await import('../server/features/platform/store.ts');
  const cap = config.memory.preferenceMax;
  // 直接填到上限（走服务层逐条写太慢），再验证服务层的边界行为。
  for (let index = 0; index < cap; index += 1) {
    insertRow('memories', {
      workspace_id: workspaceId, user_id: userId, kind: 'preference', layer: 'preference',
      content: `填充偏好 ${index}`, normalized_content: `填充偏好 ${index}`, source: 'manual',
    });
  }
  assert.equal(memoriesService.countByLayer(workspaceId, userId).preference, cap);
  assert.throws(
    () => memoriesService.save(workspaceId, userId, '超出上限的新偏好', 'preference'),
    /已达上限/,
    '超上限必须报可读错误',
  );
  // 但去重更新仍应可用——已满时更新既有记忆不该被拦。
  const updated = memoriesService.save(workspaceId, userId, '填充偏好 0', 'preference');
  assert.equal(updated.deduplicated, true, '已满时去重更新仍应放行');
  // 其他层不受影响。
  const fact = memoriesService.save(workspaceId, userId, '另一层的事实', 'fact');
  assert.equal(fact.layer, 'semantic');
});

// ---------------------------------------------------------------- HTTP

test('分层接口：列表可按层过滤，层状态含配额', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, 'HTTP 偏好', 'preference');
  memoriesService.save(workspaceId, userId, 'HTTP 事实', 'fact');

  const all = (await (await get('/api/platform/memories')).json()) as { data: Array<{ layer: string }> };
  assert.equal(all.data.length, 2);
  const onlyPref = (await (await get('/api/platform/memories?layer=preference')).json()) as { data: Array<{ layer: string }> };
  assert.equal(onlyPref.data.length, 1);
  assert.equal(onlyPref.data[0].layer, 'preference');

  const layers = (await (await get('/api/platform/memories/layers')).json()) as {
    data: { layers: Array<{ layer: string; count: number; cap: number }>; episodicEnabled: boolean; note: string };
  };
  assert.equal(layers.data.layers.length, 4);
  assert.equal(layers.data.episodicEnabled, false);
  assert.match(layers.data.note, /默认关闭/);
  assert.ok(layers.data.layers.every((layer) => layer.cap > 0));
});

test('按层清空与清理过期接口可用', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '待清事实', 'fact');
  const cleared = await del('/api/platform/memories/layers/semantic');
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { data: { removed: number } }).data.removed, 1);

  const badLayer = await del('/api/platform/memories/layers/nonexistent');
  assert.equal(badLayer.status, 400, '未知层应被拒');

  const purged = await post('/api/platform/memories/purge', {});
  assert.equal(purged.status, 200);
});

test('状态接口声明分层记忆能力', async () => {
  const body = await (await get('/api/platform/status')).json() as {
    data: { features: string[]; memoryLayers: { layers: unknown[] } };
  };
  assert.ok(body.data.features.includes('memory_layers'));
  assert.equal(body.data.memoryLayers.layers.length, 4);
});

test('会话短期记忆工具已注册', async () => {
  const tools = (await (await get('/api/platform/tools')).json()) as { data: Array<{ name: string }> };
  assert.ok(tools.data.some((tool) => tool.name === 'memory_note'), '应有会话短期记忆工具');
  assert.ok(tools.data.some((tool) => tool.name === 'memory_save'), '长期记忆工具仍在');
});