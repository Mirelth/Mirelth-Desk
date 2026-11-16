/**
 * 执行经验层**开启后**的行为验证。
 *
 * 单独一个文件的原因：`config` 是模块级快照，同进程内无法既测「默认关闭」
 * 又测「开启后自动留痕」。`memory-layers.test.ts` 跑默认关闭，本文件跑显式开启。
 *
 * 核心断言：开启后记的是**客观运行事实**（目标/工具/成败），带保留期与来源 run_id，
 * 且**不会因此自动写入偏好或事实**。
 */
process.env.DATABASE_PATH = '.data/regression-memory-episodic.db';
process.env.APP_SECRET = 'regression-memory-episodic-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.BROWSER_ENABLED = 'false';
process.env.MEMORY_EPISODIC_ENABLED = 'true';
process.env.MEMORY_EPISODIC_TTL_DAYS = '7';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate, run } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const { config } = await import('../server/shared/config.ts');
const { memoriesService } = await import('../server/features/platform/memories.ts');

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
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-memory-episodic.db${suffix}`, { force: true });
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

test('开启后：记录客观执行事实，带来源与保留期', () => {
  clearAll();
  assert.equal(config.memory.episodicEnabled, true);
  const result = memoriesService.recordEpisode(workspaceId, userId, {
    runId: 'run-abc', goal: '整理季度复盘', tools: ['rag_search', 'document_draft'], ok: true,
  });
  assert.equal(result.recorded, true);
  const list = memoriesService.list(workspaceId, userId, 'episodic');
  assert.equal(list.length, 1);
  assert.equal(list[0].runId, 'run-abc', '应可回溯到运行记录');
  assert.equal(list[0].source, 'agent_run');
  assert.ok(list[0].content.includes('整理季度复盘'), '应记目标');
  assert.ok(list[0].content.includes('rag_search'), '应记用到的工具');
  assert.ok(list[0].content.includes('完成'), '应记成败');
  assert.ok(list[0].expiresAt, '必须带保留期');
  const days = (new Date(list[0].expiresAt!).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 6 && days <= 7.1, `保留期应约 7 天，实际 ${days.toFixed(2)}`);
});

test('失败运行也记录，且如实标注未完成', () => {
  clearAll();
  memoriesService.recordEpisode(workspaceId, userId, {
    runId: 'run-fail', goal: '同步邮件', tools: ['mail_sync'], ok: false, detail: '因超时提前收尾',
  });
  const list = memoriesService.list(workspaceId, userId, 'episodic');
  assert.ok(list[0].content.includes('未完成'), '失败必须如实标注');
  assert.ok(list[0].content.includes('超时'), '应带收尾原因');
});

test('去重：同一执行结论不重复堆积', () => {
  clearAll();
  const episode = { runId: 'run-1', goal: '写周报', tools: ['document_draft'], ok: true };
  const first = memoriesService.recordEpisode(workspaceId, userId, episode);
  const second = memoriesService.recordEpisode(workspaceId, userId, { ...episode, runId: 'run-2' });
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, false, '相同结论应去重');
  assert.equal(memoriesService.countByLayer(workspaceId, userId).episodic, 1);
});

test('只写经验层：不因此自动产生偏好或事实', () => {
  clearAll();
  memoriesService.recordEpisode(workspaceId, userId, {
    runId: 'run-x', goal: '用户说以后都用英文', tools: ['agent_chat'], ok: true,
  });
  const counts = memoriesService.countByLayer(workspaceId, userId);
  assert.equal(counts.episodic, 1);
  assert.equal(counts.preference, 0, '经验层不得连带写入偏好');
  assert.equal(counts.semantic, 0, '经验层不得连带写入事实');
});

test('真实对话后自动留痕，且偏好层仍为空', async () => {
  clearAll();
  const response = await post('/api/platform/chat', { message: '记住我喜欢简洁风格，帮我写一份本周周报' });
  assert.equal(response.status, 200);
  await response.text();
  const counts = memoriesService.countByLayer(workspaceId, userId);
  assert.ok(counts.episodic >= 1, '开启后运行应留下经验');
  assert.equal(counts.preference, 0, '即使消息含「记住」「喜欢」也不得自动写偏好');
  const episodes = memoriesService.list(workspaceId, userId, 'episodic');
  assert.ok(episodes.every((item) => item.runId), '每条经验都应能回溯运行记录');
});

test('经验层配额最小：不挤占偏好与事实', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '必须包含风险章节', 'preference');
  for (let index = 0; index < 10; index += 1) {
    memoriesService.recordEpisode(workspaceId, userId, {
      runId: `run-${index}`, goal: `季度复盘任务 ${index}`, tools: ['rag_search'], ok: true,
    });
  }
  const recall = await memoriesService.recallLayered(workspaceId, userId, '季度复盘');
  assert.ok(recall.byLayer.preference.length >= 1, '偏好不应被经验挤掉');
  assert.ok(recall.byLayer.episodic.length <= 2, '经验层配额应最小');
  assert.ok(recall.items.length <= config.memory.recallTotal);
});

test('经验层可单独清空，长期记忆不受影响', async () => {
  clearAll();
  memoriesService.save(workspaceId, userId, '要保留的偏好', 'preference');
  memoriesService.recordEpisode(workspaceId, userId, { runId: 'r', goal: '任务', tools: [], ok: true });
  const cleared = await del('/api/platform/memories/layers/episodic');
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { data: { removed: number } }).data.removed, 1);
  const counts = memoriesService.countByLayer(workspaceId, userId);
  assert.equal(counts.episodic, 0);
  assert.equal(counts.preference, 1);
});

test('层状态如实报告已开启与保留期', async () => {
  const layers = (await (await get('/api/platform/memories/layers')).json()) as {
    data: { episodicEnabled: boolean; episodicTtlDays: number; note: string };
  };
  assert.equal(layers.data.episodicEnabled, true);
  assert.equal(layers.data.episodicTtlDays, 7);
  assert.match(layers.data.note, /已开启/);
  assert.match(layers.data.note, /偏好与事实仍只由显式保存产生/);
});

test('经验层满时淘汰最旧，不报错', () => {
  clearAll();
  const cap = config.memory.episodicMax;
  for (let index = 0; index < cap + 5; index += 1) {
    memoriesService.recordEpisode(workspaceId, userId, {
      runId: `bulk-${index}`, goal: `批量任务 ${index}`, tools: ['agent_chat'], ok: true,
    });
  }
  const counts = memoriesService.countByLayer(workspaceId, userId);
  assert.ok(counts.episodic <= cap, `经验层不应超上限 ${cap}，实际 ${counts.episodic}`);
  const list = memoriesService.list(workspaceId, userId, 'episodic');
  assert.ok(list.some((item) => item.content.includes(`批量任务 ${cap + 4}`)), '最新的应保留');
});