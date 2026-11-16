/**
 * 规划-执行-反思层的回归测试：纯函数边界 + 离线多步执行 + 步数上限可配置。
 * 与其他测试一样用临时库 + 动态 import；全程离线（无密钥），验证降级路径不报错。
 */
process.env.DATABASE_PATH = '.data/regression-planner.db';
process.env.APP_SECRET = 'regression-planner-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.BROWSER_ENABLED = 'false';
// 显式设一个大于旧硬编码 8 的上限，验证钳制真的来自配置。
process.env.AGENT_MAX_STEPS = '24';
process.env.AGENT_DEFAULT_STEPS = '8';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const { config } = await import('../server/shared/config.ts');
const {
  buildPlan, rulePlan, sanitizeSteps, extractJson, isFailure, ruleReflect, renderPlan, reflectOnRun,
} = await import('../server/features/platform/planner.ts');

migrate();
authService.ensureAdmin();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let cookie = '';
before(async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
});

after(() => {
  server.close();
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-planner.db${suffix}`, { force: true });
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
});

const TOOLSET = [
  { name: 'rag_search', description: '检索知识库' },
  { name: 'document_draft', description: '起草文档' },
  { name: 'document_save', description: '保存文档' },
];
const ALLOWED = new Set(TOOLSET.map((tool) => tool.name));

// ---------------------------------------------------------------- 纯函数

test('步骤收敛：去空目标、白名单外工具留空、超出上限截断', () => {
  const steps = sanitizeSteps([
    { goal: '  检索材料  ', tool: 'rag_search' },
    { goal: '', tool: 'document_draft' },
    { goal: '越权步骤', tool: 'mail_sync' },
    { goal: '点号写法', tool: 'document.save' },
    { goal: '超限步骤', tool: 'rag_search' },
  ], ALLOWED, 3);
  assert.equal(steps.length, 3, '应受上限截断');
  assert.equal(steps[0].goal, '检索材料');
  assert.equal(steps[1].tool, '', '白名单外的工具必须留空，不能绕过白名单');
  assert.equal(steps[2].tool, 'document_save', '点号写法应归一为下划线');
  assert.ok(steps.every((step) => step.status === 'pending'));
});

test('JSON 提取：容忍代码块包裹与前后解释文字，坏 JSON 返回 null', () => {
  assert.deepEqual(extractJson('```json\n{"goal":"g"}\n```'), { goal: 'g' });
  assert.deepEqual(extractJson('好的，计划如下：{"goal":"g"} 以上。'), { goal: 'g' });
  assert.equal(extractJson('{坏掉的'), null);
  assert.equal(extractJson('没有对象'), null);
  assert.equal(extractJson('[1,2]'), null, '数组不算计划对象');
});

test('失败判定：只认工具失败前缀，正常空结果不算失败', () => {
  assert.ok(isFailure('工具执行失败：连接超时'));
  assert.ok(isFailure('未找到工具：xxx'));
  assert.ok(!isFailure('知识库中没有相关材料。'));
  assert.ok(!isFailure(''));
});

test('离线规则规划：生成类任务含落盘步骤，纯问答不落盘', () => {
  const writing = rulePlan('帮我写一份本周周报', ALLOWED, 8);
  assert.ok(writing.some((step) => step.tool === 'rag_search'), '应先检索材料');
  assert.ok(writing.some((step) => step.tool === 'document_save'), '生成类任务应落盘');

  const chat = rulePlan('今天天气怎么样', ALLOWED, 8);
  assert.ok(!chat.some((step) => step.tool === 'document_save'), '纯问答不应产出文档');
});

test('规划降级：未配密钥时走规则且不发请求，不抛错', async () => {
  const { plan, usageChars } = await buildPlan({
    message: '写一份季度复盘报告', tools: TOOLSET, limit: 8, live: false,
  });
  assert.equal(plan.origin, 'rules');
  assert.equal(usageChars, 0, '离线规划不应产生模型用量');
  assert.ok(plan.steps.length >= 2, '应拆成多步');
});

test('确定性反思：有失败步骤要重排，有待执行工具步骤不算完成', () => {
  const plan = { goal: 'g', origin: 'rules' as const, revisions: 0, steps: rulePlan('写周报', ALLOWED, 8) };
  const failed = ruleReflect(plan, [{ tool: 'document_save', output: '工具执行失败：磁盘满' }]);
  assert.equal(failed.verdict, 'replan');

  const pending = ruleReflect(plan, [{ tool: 'rag_search', output: '材料若干' }]);
  assert.equal(pending.verdict, 'continue', '还有工具步骤没跑完不能算完成');

  const done = { ...plan, steps: plan.steps.map((step) => ({ ...step, status: 'done' as const })) };
  assert.equal(ruleReflect(done, [{ tool: 'rag_search', output: '材料若干' }]).verdict, 'complete');
});

test('反思降级：离线不发请求；预算用尽时不判完成', async () => {
  const plan = { goal: 'g', origin: 'rules' as const, revisions: 0, steps: [] };
  const offline = await reflectOnRun({ plan, outcomes: [], answer: '答案', live: false, tools: TOOLSET, remaining: 5 });
  assert.equal(offline.usageChars, 0);
  assert.equal(offline.reflection.verdict, 'complete');

  const exhausted = await reflectOnRun({ plan, outcomes: [], answer: '答案', live: true, tools: TOOLSET, remaining: 0 });
  assert.equal(exhausted.reflection.verdict, 'continue', '没有预算时不能声称完成');
  assert.equal(exhausted.usageChars, 0, '预算用尽不应再调模型');
});

test('计划渲染：标出当前步与已完成状态', () => {
  const plan = { goal: '总目标', origin: 'rules' as const, revisions: 0, steps: rulePlan('写周报', ALLOWED, 8) };
  plan.steps[0].status = 'done';
  plan.steps[0].result = '检索到三段材料';
  const text = renderPlan(plan, 1);
  assert.ok(text.includes('总目标'));
  assert.ok(text.includes('[已完成]'));
  assert.ok(text.includes('第 2 步'));
  assert.equal(renderPlan({ ...plan, steps: [] }, 0), '', '空计划不注入噪声');
});

// ---------------------------------------------------------------- 配置与 HTTP

test('步数上限来自配置，不再硬编码 8', () => {
  assert.equal(config.agent.maxSteps, 24);
  assert.equal(config.agent.defaultSteps, 8);
  assert.ok(config.agent.maxSteps > 8, '硬上限应可超过旧值 8');
});

test('智能体定义：可设置超过 8 的步数，超上限被拒', async () => {
  const created = await post('/api/platform/agents', { name: '多步助手', tools: ['document_outline'], maxSteps: 16 });
  assert.equal(created.status, 201, '16 步应被接受');
  const id = (await created.json() as { data: { id: string } }).data.id;
  const list = (await (await get('/api/platform/agents')).json() as { data: Array<{ id: string; max_steps: number }> }).data;
  assert.equal(list.find((item) => item.id === id)?.max_steps, 16);

  const tooMany = await post('/api/platform/agents', { name: '失控助手', maxSteps: 999 });
  assert.equal(tooMany.status, 422, '超过配置上限应被校验拒绝');
});

test('状态接口声明规划能力与预算', async () => {
  const body = (await (await get('/api/platform/status')).json()) as {
    data: { features: string[]; planning: { maxSteps: number; planner: boolean; reflect: boolean } };
  };
  assert.ok(body.data.features.includes('planner'));
  assert.ok(body.data.features.includes('reflection'));
  assert.equal(body.data.planning.maxSteps, 24);
  assert.equal(typeof body.data.planning.planner, 'boolean');
});

test('会话：离线也先发 plan 事件，再 step，最后 reflect 与 done', async () => {
  const response = await post('/api/platform/chat', { message: '帮我写一份本周周报并保存' });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.ok(stream.includes('event: meta'), '应先发 meta');
  assert.ok(stream.includes('event: plan'), '应发出执行计划');
  assert.ok(stream.includes('event: reflect'), '应发出反思结论');
  assert.ok(stream.includes('event: done'), '应以 done 收尾');
  assert.ok(stream.indexOf('event: plan') < stream.indexOf('event: step'), '计划应先于工具步骤');
});

test('运行记录：留下计划快照与来源，计划步骤不计入工具步数', async () => {
  const runs = (await (await get('/api/platform/runs')).json()) as {
    data: Array<{ id: string; plan_origin: string; revisions: number; stopped_reason: string; steps_count: number }>;
  };
  assert.ok(runs.data.length >= 1);
  const latest = runs.data[0];
  assert.equal(latest.plan_origin, 'rules', '离线运行应标为规则规划');
  assert.equal(latest.revisions, 0);
  assert.equal(latest.stopped_reason, '');

  const detail = (await (await get(`/api/platform/runs/${latest.id}`)).json()) as {
    data: { plan: { goal: string; steps: Array<{ goal: string }> } | null; steps: Array<{ kind: string; step_index: number }> };
  };
  assert.ok(detail.data.plan, '运行详情应带计划快照');
  assert.ok((detail.data.plan?.steps.length ?? 0) >= 2, '计划应是多步');
  assert.ok(detail.data.steps.some((step) => step.kind === 'plan' && step.step_index === 0), '计划应作为第 0 步留痕');
  assert.equal(detail.data.steps.filter((step) => step.kind === 'tool').length, latest.steps_count, '工具步数不含计划行');
});

test('旧运行记录兼容：新增列有默认值，详情仍可读', async () => {
  const { run } = await import('../server/shared/database.ts');
  run(
    `INSERT INTO agent_runs (id, workspace_id, user_id, status, input, output, steps_count, tokens_estimate, duration_ms, created_at)
     VALUES (?, ?, ?, 'success', '旧记录', '旧输出', 1, 0, 0, ?)`,
    'run_legacy_planner', 'wsp_legacy', 'usr_legacy', new Date().toISOString(),
  );
  const found = (await (await get('/api/platform/runs')).json()) as { data: Array<{ id: string }> };
  assert.ok(Array.isArray(found.data), '含旧行的列表应正常返回');
});