/**
 * 规划层的**在线路径**验证：用本机假模型服务（OpenAI 兼容）替代真实上游，
 * 断言规划 → 执行 → 反思 → 重排续跑真的串起来，且请求体合法。
 *
 * 为什么必须单独测：其余测试全程离线，只覆盖规则降级分支；
 * live 分支的 JSON 解析、工具回填、重排续跑若无测试，等于没验证。
 * 假服务只绑回环，不出网、不花钱。
 */
process.env.DATABASE_PATH = '.data/regression-planner-live.db';
process.env.APP_SECRET = 'regression-planner-live-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.BROWSER_ENABLED = 'false';
process.env.AGENT_MAX_STEPS = '12';
process.env.AGENT_DEFAULT_STEPS = '6';
process.env.LLM_API_KEY = 'fake-key-for-local-stub';
process.env.LLM_EMBEDDING_MODEL = '';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

/** 记录每次上游请求，供断言检查请求体合法性与调用顺序。 */
interface UpstreamCall { hasTools: boolean; toolCount: number; lastUser: string; system: string }
const calls: UpstreamCall[] = [];
/** 按顺序返回的回复；用尽后重复最后一条，避免测试挂死。 */
let scripted: Array<{ content?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }> = [];
let cursor = 0;
/** 置 true 时上游一律回 500，用于验证规划失败降级。 */
let failUpstream = false;

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (failUpstream) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub failure' } }));
      return;
    }
    const body = JSON.parse(raw || '{}') as {
      messages?: Array<{ role: string; content: string }>;
      tools?: unknown[]; tool_choice?: string; stream?: boolean;
    };
    // composeFromSteps 走 streamTask（stream:true）；它不是工具往返，单独回一段流式文本，
    // 否则会错位消耗脚本化回复，让闭环断言测到假象。
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '（汇总）' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const messages = body.messages ?? [];
    calls.push({
      hasTools: Array.isArray(body.tools),
      toolCount: body.tools?.length ?? 0,
      lastUser: [...messages].reverse().find((item) => item.role === 'user')?.content ?? '',
      system: messages.find((item) => item.role === 'system')?.content ?? '',
    });
    const reply = scripted[Math.min(cursor, scripted.length - 1)] ?? { content: '默认回复' };
    cursor += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: reply.content ?? '',
          ...(reply.toolCalls?.length ? {
            tool_calls: reply.toolCalls.map((call, index) => ({
              id: `call_${index}`, type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          } : {}),
        },
      }],
    }));
  });
});
stub.listen(0, '127.0.0.1');
await new Promise((resolve) => stub.once('listening', resolve));
// 必须在导入 config 之前设好，config 是模块级快照。
process.env.LLM_BASE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const { config } = await import('../server/shared/config.ts');
const { buildPlan, reflectOnRun } = await import('../server/features/platform/planner.ts');

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
  stub.close();
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-planner-live.db${suffix}`, { force: true });
});

const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
});
const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });

function reset(replies: typeof scripted): void {
  scripted = replies;
  cursor = 0;
  calls.length = 0;
  failUpstream = false;
}

/** 解析 SSE 文本为事件数组。 */
function parseEvents(stream: string): Array<{ type: string; [key: string]: unknown }> {
  return stream.split('\n\n').map((frame) => {
    const type = /event: (.+)/.exec(frame)?.[1]?.trim() ?? '';
    const data = /data: (.+)/.exec(frame)?.[1]?.trim() ?? '{}';
    try { return { type, ...(JSON.parse(data) as Record<string, unknown>) }; } catch { return { type }; }
  }).filter((item) => item.type);
}

const TOOLS = [{ name: 'rag_search', description: '检索' }, { name: 'document_draft', description: '起草' }];

test('在线规划：解析模型 JSON，且请求体不带空 tools 字段', async () => {
  assert.ok(config.llm.enabled, '本测试应在 live 模式下运行');
  reset([{ content: '```json\n{"goal":"完成周报","steps":[{"goal":"检索材料","tool":"rag_search"},{"goal":"起草正文","tool":"document_draft"}]}\n```' }]);
  const { plan, usageChars } = await buildPlan({ message: '写周报', tools: TOOLS, limit: 6, live: true });
  assert.equal(plan.origin, 'live');
  assert.equal(plan.goal, '完成周报');
  assert.equal(plan.steps.length, 2);
  assert.ok(usageChars > 0, '在线规划应计入用量');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hasTools, false, '纯文本往返不得发送 tools 字段（空数组会被上游拒绝）');
});

test('在线规划降级：上游报错时回退规则计划，不抛错', async () => {
  reset([{ content: 'ignored' }]);
  failUpstream = true;
  const { plan } = await buildPlan({ message: '写一份周报', tools: TOOLS, limit: 6, live: true });
  assert.equal(plan.origin, 'fallback', '上游失败必须降级而非崩溃');
  assert.ok(plan.steps.length >= 1);
});

test('在线规划降级：模型返回非 JSON 时回退规则计划', async () => {
  reset([{ content: '我觉得应该先检索再写，但我不输出 JSON。' }]);
  const { plan } = await buildPlan({ message: '写一份周报', tools: TOOLS, limit: 6, live: true });
  assert.equal(plan.origin, 'fallback');
});

test('在线反思：判定 replan 时给出可执行追加步骤', async () => {
  reset([{ content: '{"verdict":"replan","reason":"缺少数据支撑","nextSteps":[{"goal":"补充检索数据","tool":"rag_search"}]}' }]);
  const plan = { goal: 'g', origin: 'live' as const, revisions: 0, steps: [] };
  const { reflection } = await reflectOnRun({
    plan, outcomes: [{ tool: 'rag_search', output: '材料' }], answer: '草稿', live: true, tools: TOOLS, remaining: 3,
  });
  assert.equal(reflection.verdict, 'replan');
  assert.equal(reflection.nextSteps.length, 1);
  assert.equal(reflection.nextSteps[0].tool, 'rag_search');
});

test('在线反思：说 replan 但没给步骤时退回 continue，不空转', async () => {
  reset([{ content: '{"verdict":"replan","reason":"不满意","nextSteps":[]}' }]);
  const { reflection } = await reflectOnRun({
    plan: { goal: 'g', origin: 'live' as const, revisions: 0, steps: [] },
    outcomes: [], answer: '草稿', live: true, tools: TOOLS, remaining: 3,
  });
  assert.equal(reflection.verdict, 'continue');
});

test('完整在线闭环：plan → 工具执行 → reflect(replan) → 续跑 → done', async () => {
  reset([
    // 1. 规划两步
    { content: '{"goal":"整理季度复盘","steps":[{"goal":"检索材料","tool":"rag_search"},{"goal":"起草复盘","tool":"document_draft"}]}' },
    // 2. 执行第一轮：调检索
    { content: '', toolCalls: [{ name: 'rag_search', args: { query: '季度复盘' } }] },
    // 3. 执行第二轮：调起草 → 计划两步都已完成
    { content: '', toolCalls: [{ name: 'document_draft', args: { message: '季度复盘' } }] },
    // 4. 给出答案草稿（此时确定性反思无硬信号，交模型审查）
    { content: '初版复盘草稿' },
    // 5. 模型审查：要求补做
    { content: '{"verdict":"replan","reason":"未覆盖风险项","nextSteps":[{"goal":"补充风险检索","tool":"rag_search"}]}' },
    // 6. 续跑：再调一次工具
    { content: '', toolCalls: [{ name: 'rag_search', args: { query: '风险项' } }] },
    // 7. 续跑收尾
    { content: '补齐风险项后的最终复盘' },
    // 8. 二次审查：确认完成
    { content: '{"verdict":"complete","reason":"风险项已补齐"}' },
  ]);
  const response = await post('/api/platform/chat', { message: '整理一份季度复盘' });
  assert.equal(response.status, 200);
  const events = parseEvents(await response.text());
  const types = events.map((item) => item.type);

  assert.ok(types.includes('plan'), '应有计划事件');
  assert.ok(types.includes('reflect'), '应有反思事件');
  assert.equal(types[types.length - 1], 'done', '应以 done 收尾');
  const reflects = events.filter((item) => item.type === 'reflect');
  assert.equal(reflects[0]?.verdict, 'replan', '首次审查应要求补做');
  assert.equal(reflects[reflects.length - 1]?.verdict, 'complete', '补齐后应确认完成');

  // 重排后计划应变长，且续跑真的又调了工具。
  const plans = events.filter((item) => item.type === 'plan');
  const lastPlan = plans[plans.length - 1] as { steps?: Array<{ goal: string }> };
  assert.ok((lastPlan.steps?.length ?? 0) >= 3, '重排后计划应包含追加步骤');
  assert.ok(lastPlan.steps?.some((step) => step.goal === '补充风险检索'));
  assert.equal(events.filter((item) => item.type === 'step' && item.status === 'start').length, 3, '两步计划 + 重排一步 = 三次工具执行');

  const deltas = events.filter((item) => item.type === 'delta').map((item) => String(item.text ?? '')).join('');
  assert.ok(deltas.includes('最终复盘'), '续跑后的答案应替换初版草稿');

  // 执行阶段的 system 必须带计划，否则模型不知道自己在第几步。
  const execCalls = calls.filter((item) => item.hasTools);
  assert.ok(execCalls.length >= 3, '执行阶段应有多轮带工具的往返');
  assert.ok(execCalls.every((item) => item.system.includes('执行计划')), '每轮都应注入当前计划');
  assert.ok(execCalls.every((item) => item.toolCount > 0), '带 tools 时不得为空数组');

  const runs = (await (await get('/api/platform/runs')).json()) as {
    data: Array<{ id: string; plan_origin: string; revisions: number }>;
  };
  assert.equal(runs.data[0].plan_origin, 'live');
  assert.equal(runs.data[0].revisions, 1, '重排次数应留痕');
});

test('完整在线闭环：反思判定 complete 时不追加步骤', async () => {
  reset([
    { content: '{"goal":"简单问答","steps":[{"goal":"直接回答","tool":""}]}' },
    { content: '这是答案' },
    { content: '{"verdict":"complete","reason":"已覆盖问题"}' },
  ]);
  const events = parseEvents(await (await post('/api/platform/chat', { message: '你好' })).text());
  const reflect = events.find((item) => item.type === 'reflect');
  assert.equal(reflect?.verdict, 'complete');
  assert.equal(events.filter((item) => item.type === 'plan').length, 1, '完成时不应重发计划');
  assert.equal(events[events.length - 1].type, 'done');
});

test('反思判 continue 时必须真的续跑，不能只说不做', async () => {
  reset([
    // 规划两步，但模型只跑第一步就想收尾 → 确定性反思应判 continue。
    { content: '{"goal":"两步任务","steps":[{"goal":"检索材料","tool":"rag_search"},{"goal":"起草正文","tool":"document_draft"}]}' },
    { content: '', toolCalls: [{ name: 'rag_search', args: { query: '材料' } }] },
    { content: '我先给个初步答案' },
    // 续跑：补做第二步
    { content: '', toolCalls: [{ name: 'document_draft', args: { message: '起草' } }] },
    { content: '补做起草后的完整答案' },
    { content: '{"verdict":"complete","reason":"两步均已完成"}' },
  ]);
  const events = parseEvents(await (await post('/api/platform/chat', { message: '检索材料并起草正文' })).text());
  const firstReflect = events.find((item) => item.type === 'reflect');
  assert.equal(firstReflect?.verdict, 'continue', '还有计划步骤没跑完应判继续');
  const startedTools = events.filter((item) => item.type === 'step' && item.status === 'start').map((item) => item.tool);
  assert.deepEqual(startedTools, ['rag_search', 'document_draft'], '判继续后必须真的执行剩余步骤');
  const deltas = events.filter((item) => item.type === 'delta').map((item) => String(item.text ?? '')).join('');
  assert.ok(deltas.includes('完整答案'), '最终答案应是续跑后的结果');
});

test('预算耗尽：步数用尽时如实标注 stopped，不假装完成', async () => {
  // 规划给 6 步，执行阶段每轮都调工具，永不给最终答案 → 必然打满步数。
  reset([
    { content: '{"goal":"循环任务","steps":[{"goal":"反复检索","tool":"rag_search"}]}' },
    { content: '', toolCalls: [{ name: 'rag_search', args: { query: 'x' } }] },
  ]);
  const events = parseEvents(await (await post('/api/platform/chat', { message: '反复检索直到满意' })).text());
  const done = events[events.length - 1] as { type: string; stopped?: string };
  assert.equal(done.type, 'done');
  assert.equal(done.stopped, 'step_limit', '步数用尽必须如实标注');
  assert.ok(events.filter((item) => item.type === 'step' && item.status === 'start').length <= config.agent.defaultSteps);
});