/**
 * 路线图新能力的回归测试：语义检索降级、分块、记忆显式保存与去重、
 * 浏览器安全边界、PPT 多版式、PDF/图片导入校验。
 * 与其他测试一样用临时库 + 动态 import；全程离线（无嵌入密钥）。
 */
process.env.DATABASE_PATH = '.data/regression-roadmap.db';
process.env.APP_SECRET = 'regression-roadmap-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';
// 显式确保浏览器默认关闭：安全边界测试依赖这一点。
process.env.BROWSER_ENABLED = 'false';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const { splitChunks, tokenize, encodeVector, decodeVector, dotSimilarity, searchHybrid, indexChunk } = await import('../server/features/platform/rag.ts');
const { markdownToDeck, parseDeckJson, deckToPptx } = await import('../server/shared/office.ts');


migrate();
authService.ensureAdmin();

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let cookie = '';
let workspaceId = '';
before(async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  const status = await (await get('/api/platform/status')).json() as { data: { workspace: { id: string } } };
  workspaceId = status.data.workspace.id;
});

after(() => {
  server.close();
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-roadmap.db${suffix}`, { force: true });
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
});
const del = (path: string) => fetch(`${base}${path}`, { method: 'DELETE', headers: { Cookie: cookie } });

// ---------------------------------------------------------------- 检索

test('分块：长文档切成多块且保留重叠，短文档不切', () => {
  const short = splitChunks('很短的一段话');
  assert.equal(short.length, 1, '短文本应只有一块');

  const long = Array.from({ length: 60 }, (_, index) => `## 小节 ${index}\n\n${'内容'.repeat(60)}`).join('\n\n');
  const chunks = splitChunks(long);
  assert.ok(chunks.length > 1, `长文档应切成多块，实际 ${chunks.length}`);
  assert.ok(chunks.length <= 60, '块数应有上限');
  assert.ok(chunks.every((chunk) => chunk.length > 0), '不应产生空块');
});

test('分词：中英混排在交界处切开，混排内容可被检索', () => {
  const tokens = tokenize('ZZZQ增量测试内容');
  assert.ok(tokens.includes('zzzq'), '拉丁段应独立成词');
  assert.ok(tokens.includes('增量'), '中文段应切出双字词');
  assert.ok(tokens.includes('测试'), '中文段应切出双字词');
  assert.ok(!tokens.includes('zzzq增量测试内容'), '不应把整串当成一个词元');
});

test('向量编解码往返一致，相似度计算正确', () => {
  const vector = [0.1, -0.5, 0.25, 1];
  const restored = decodeVector(encodeVector(vector));
  assert.ok(restored, '应能解回向量');
  vector.forEach((value, index) => {
    assert.ok(Math.abs((restored as Float32Array)[index] - value) < 1e-6, '编解码应保精度');
  });
  const same = dotSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]));
  assert.ok(Math.abs(same - 1) < 1e-6, '同向向量相似度应为 1');
  const orthogonal = dotSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]));
  assert.ok(Math.abs(orthogonal) < 1e-6, '正交向量相似度应为 0');
  assert.equal(decodeVector(null), null, '空 BLOB 应返回 null');
});

test('无嵌入密钥时检索降级为词法且仍可用（离线承诺）', async () => {
  indexChunk(workspaceId, 'manual', 'test-source-1', '季度营收复盘', '本季度营收增长明显，华东区贡献最大。');
  const { hits, mode } = await searchHybrid(workspaceId, '营收', 5);
  assert.equal(mode, 'lexical', '未配嵌入模型时应为词法模式');
  assert.ok(hits.length > 0, '词法检索应能命中');
  assert.ok(hits[0].content.includes('营收'), '应命中相关内容');
});

test('状态接口如实报告检索模式', async () => {
  const body = await (await get('/api/platform/status')).json() as {
    data: { retrieval: { mode: string; embeddingModel: string }; features: string[] };
  };
  assert.equal(body.data.retrieval.mode, 'lexical');
  assert.equal(body.data.retrieval.embeddingModel, '', '未配置时应为空');
  assert.ok(body.data.features.includes('rag_hybrid'));
  assert.ok(body.data.features.includes('ocr'));
  assert.ok(body.data.features.includes('browser_automation'));
});

test('文档创建后立即可检索（增量索引）', async () => {
  const created = await post('/api/documents', { title: '增量索引验证', content: '独特标记词汇 ZZZQ增量测试内容', kind: 'general' });
  assert.equal(created.status, 201);
  const doc = (await created.json() as { data: { id: string } }).data;

  const found = await get(`/api/platform/knowledge/search?q=${encodeURIComponent('ZZZQ增量测试')}`);
  const hits = (await found.json() as { data: Array<{ content: string }> }).data;
  assert.ok(hits.some((hit) => hit.content.includes('ZZZQ')), '新建文档应无需手动重建即可检索');

  // 删除后索引应同步清理
  assert.equal((await del(`/api/documents/${doc.id}`)).status, 200);
  const afterDelete = await get(`/api/platform/knowledge/search?q=${encodeURIComponent('ZZZQ增量测试')}`);
  const remaining = (await afterDelete.json() as { data: Array<{ content: string }> }).data;
  assert.ok(!remaining.some((hit) => hit.content.includes('ZZZQ')), '删除文档后不应再检索到');
});

// ---------------------------------------------------------------- 记忆

test('记忆：显式保存、去重、可删除', async () => {
  const created = await post('/api/platform/memories', { content: '周报一律用简体中文', kind: 'preference' });
  assert.equal(created.status, 201);
  const first = (await created.json() as { data: { id: string; deduplicated: boolean } }).data;
  assert.equal(first.deduplicated, false);

  // 同样内容（含多余空白）应去重而不是新增
  const again = await post('/api/platform/memories', { content: '  周报一律用简体中文  ', kind: 'preference' });
  const second = (await again.json() as { data: { id: string; deduplicated: boolean } }).data;
  assert.equal(second.deduplicated, true, '归一化后相同内容应去重');
  assert.equal(second.id, first.id, '去重应复用同一条');

  const list = (await (await get('/api/platform/memories')).json() as { data: Array<{ id: string }> }).data;
  assert.equal(list.filter((item) => item.id === first.id).length, 1, '不应产生重复条目');

  assert.equal((await del(`/api/platform/memories/${first.id}`)).status, 200);
  const afterDelete = (await (await get('/api/platform/memories')).json() as { data: Array<{ id: string }> }).data;
  assert.ok(!afterDelete.some((item) => item.id === first.id), '删除后不应再出现');
});

test('记忆：空内容与超长内容被拒绝', async () => {
  // 纯空白能过 Zod 的长度校验，由 service 层 trim 后拒绝 → 400；超长由 schema 拦 → 422。
  assert.equal((await post('/api/platform/memories', { content: '   ' })).status, 400);
  assert.equal((await post('/api/platform/memories', { content: 'x'.repeat(2001) })).status, 422);
});

test('记忆工具已注册，随口一句话不再自动入库', async () => {
  const tools = (await (await get('/api/platform/tools')).json() as { data: Array<{ name: string }> }).data;
  assert.ok(tools.some((tool) => tool.name === 'memory_save'), '应有显式保存工具');
  assert.ok(tools.some((tool) => tool.name === 'memory_search'), '应有记忆检索工具');

  const before = (await (await get('/api/platform/memories')).json() as { data: unknown[] }).data.length;
  const chat = await post('/api/platform/chat', { message: '记住这件事：以后都用蓝色主题' });
  assert.equal(chat.status, 200);
  await chat.text();
  const afterCount = (await (await get('/api/platform/memories')).json() as { data: unknown[] }).data.length;
  assert.equal(afterCount, before, '含「记住」的消息不应被自动写入记忆');
});

// ---------------------------------------------------------------- 浏览器安全边界

test('浏览器：默认关闭，状态如实报告', async () => {
  const body = await (await get('/api/browser/status')).json() as {
    data: { enabled: boolean; allowedHosts: string[]; sensitiveActions: string[] };
  };
  assert.equal(body.data.enabled, false, '默认必须关闭');
  assert.deepEqual(body.data.allowedHosts, [], '白名单默认应为空');
  assert.ok(body.data.sensitiveActions.includes('click'));
  assert.ok(body.data.sensitiveActions.includes('fill'));
});

test('浏览器：未启用时执行被拒绝（403）', async () => {
  const response = await post('/api/browser/run', { action: 'read', url: 'https://example.com' });
  assert.equal(response.status, 403);
  const body = await response.json() as { title: string };
  assert.equal(body.title, 'FORBIDDEN');
});

test('浏览器：操作留痕接口可用且受会话保护', async () => {
  assert.equal((await get('/api/browser/runs')).status, 200);
  assert.equal((await fetch(`${base}/api/browser/status`)).status, 401, '未登录应被拒绝');
});

// ---------------------------------------------------------------- PPT 多版式

test('PPT：H1 转分节页、表格转表格页，版式可解析', () => {
  const markdown = ['# 第一章', '', '概述文字', '', '## 数据小节', '', '| 月份 | 营收 |', '| --- | --- |', '| 1月 | 128 |'].join('\n');
  const deck = markdownToDeck('版式测试', markdown);
  assert.ok(deck.slides.some((slide) => slide.layout === 'section'), 'H1 应产生分节页');
  assert.ok(deck.slides.some((slide) => slide.layout === 'table' && slide.table?.length), '表格应转表格页');
  assert.equal(deck.theme, 'ocean');
});

test('PPT：大纲解析支持新版式，缺数据时退回要点页', () => {
  const parsed = parseDeckJson(JSON.stringify({
    title: '测试', theme: 'forest',
    slides: [
      { title: '分节', layout: 'section', bullets: ['要点'] },
      { title: '表格', layout: 'table', table: [['列A', '列B'], ['1', '2']] },
      { title: '双栏', layout: 'twoColumn', columns: [['左'], ['右']] },
      { title: '声明表格但无数据', layout: 'table', bullets: ['退回'] },
    ],
  }));
  assert.ok(parsed, '应能解析');
  assert.equal(parsed?.theme, 'forest');
  assert.equal(parsed?.slides[0].layout, 'section');
  assert.equal(parsed?.slides[1].layout, 'table');
  assert.equal(parsed?.slides[2].layout, 'twoColumn');
  assert.equal(parsed?.slides[3].layout, 'bullets', '声明版式但缺数据应退回要点页');
});

test('PPT：四种版式都能生成合法文件', async () => {
  const buffer = await deckToPptx({
    title: '全版式', theme: 'slate',
    slides: [
      { title: '分节页', bullets: ['副标题'], layout: 'section' },
      { title: '要点页', bullets: ['要点一', '要点二'], layout: 'bullets' },
      { title: '双栏页', bullets: [], layout: 'twoColumn', columns: [['左一', '左二'], ['右一']] },
      { title: '表格页', bullets: [], layout: 'table', table: [['列A', '列B'], ['1', '2'], ['3', '4']] },
    ],
  });
  assert.ok(buffer.length > 5000, 'PPTX 不应是空壳');
  assert.equal(buffer[0], 0x50, '应是 zip 容器');
  assert.equal(buffer[1], 0x4b);
});

test('PPT：超长要点被截断，不会撑破版式', () => {
  const deck = markdownToDeck('超长', `## 标题\n\n- ${'很长'.repeat(200)}`);
  const bullets = deck.slides.flatMap((slide) => slide.bullets);
  assert.ok(bullets.every((bullet) => bullet.length <= 111), '要点长度应受上限约束');
});

// ---------------------------------------------------------------- 导入校验

test('导入：不支持的扩展名被拒绝并给出可读提示', async () => {
  const response = await post('/api/documents/import', {
    filename: 'legacy.doc', contentBase64: Buffer.from('x').toString('base64'),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { detail: string };
  assert.ok(/docx/.test(body.detail), '提示应说明支持的格式');
});

test('导入：坏 PDF 被拒绝而不是静默成功', async () => {
  const response = await post('/api/documents/import', {
    filename: 'broken.pdf', contentBase64: Buffer.from('不是 PDF 内容').toString('base64'),
  });
  assert.equal(response.status, 400);
});

test('视觉识别：未配模型时图片导入给出可操作提示，且不崩服务', async () => {
  const { config } = await import('../server/shared/config.ts');
  if (config.llm.enabled) return; // 已配密钥的环境会真的调模型，跳过

  const started = Date.now();
  const response = await post('/api/documents/import', {
    filename: 'scan.png',
    contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  });
  const elapsed = Date.now() - started;
  assert.ok(response.status >= 400 && response.status < 600, '应返回错误而不是静默成功');
  assert.ok(elapsed < 30_000, `应快速落定，实际 ${elapsed}ms`);
  const body = await response.json() as { detail: string };
  assert.ok(/多模态|LLM_API_KEY|LLM_VISION_MODEL/.test(body.detail), '提示应指向配置多模态模型');
  // 服务仍存活即证明识别失败不会带崩进程。
  assert.equal((await get('/api/platform/status')).status, 200, '识别失败后服务应仍可用');
});

test('视觉识别：PDF 渲染为图片可用（扫描件链路的基础）', async () => {
  const { renderPdfPages } = await import('../server/shared/pdf.ts');
  // 用 office.test 里同样的极简 PDF 构造法：有内容即可验证渲染管线。
  const text = 'Render check';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length + 44} >>\nstream\nBT /F1 18 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  const pages = await renderPdfPages(Buffer.from(pdf, 'latin1'), 2);
  assert.equal(pages.length, 1, '应渲染出 1 页');
  assert.equal(pages[0].mime, 'image/png');
  const png = Buffer.from(pages[0].base64, 'base64');
  assert.equal(png[0], 0x89, '应是合法 PNG');
  assert.ok(png.length > 500, '渲染结果不应是空图');
});

test('视觉识别：页数上限受配置约束', async () => {
  const { config } = await import('../server/shared/config.ts');
  assert.ok(config.vision.maxPages >= 1, '应有页数上限');
  assert.ok(config.vision.scale > 0, '渲染倍率应为正数');
});