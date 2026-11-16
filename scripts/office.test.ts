/**
 * AI Office 的 HTTP 层测试：DOCX 导入/导出往返、XLSX 导入/导出往返、PPTX 生成与坏文件拒绝。
 * 与 platform.test.ts 一样用临时库 + 动态 import，离线引擎下全链路可跑。
 */
process.env.DATABASE_PATH = '.data/regression-office.db';
process.env.APP_SECRET = 'regression-office-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const { markdownToDocx } = await import('../server/shared/office.ts');
const { buildXlsx } = await import('../server/features/analytics/xlsx.ts');

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
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-office.db${suffix}`, { force: true });
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
});

const isZip = (buffer: Buffer): boolean => buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;

const SAMPLE_MD = [
  '# 季度复盘', '', '## 一、关键数据', '', '- 营收增长 **12%**', '- 新客户 24 个', '',
  '| 月份 | 营收 |', '| --- | --- |', '| 1月 | 128 |', '| 2月 | 142 |', '',
  '## 二、下一步', '', '1. 补齐渠道数据', '2. 约定复盘节点',
].join('\n');

test('DOCX：导入 → 导出往返保留标题、列表与表格内容', async () => {
  const source = await markdownToDocx('往返测试', SAMPLE_MD);
  const imported = await post('/api/documents/import', { filename: '往返测试.docx', contentBase64: source.toString('base64') });
  assert.equal(imported.status, 201);
  const doc = (await imported.json() as { data: { id: string; title: string; content: string } }).data;
  assert.equal(doc.title, '往返测试');
  assert.ok(doc.content.includes('季度复盘'), '应保留标题文本');
  assert.ok(doc.content.includes('营收增长'), '应保留列表文本');
  assert.ok(doc.content.includes('|'), '表格应转成 Markdown 表格');

  const exported = await get(`/api/documents/${doc.id}/export?format=docx`);
  assert.equal(exported.status, 200);
  assert.ok(String(exported.headers.get('content-type')).includes('wordprocessingml'));
  assert.ok(isZip(Buffer.from(await exported.arrayBuffer())), 'DOCX 应是合法 zip 容器');
});

test('DOCX：坏文件与非 .docx 文件名都被拒绝', async () => {
  const garbage = await post('/api/documents/import', {
    filename: '坏文件.docx', contentBase64: Buffer.from('这不是一个 docx 文件').toString('base64'),
  });
  assert.equal(garbage.status, 400);

  const wrongExt = await post('/api/documents/import', {
    filename: '旧格式.doc', contentBase64: Buffer.from('anything').toString('base64'),
  });
  assert.equal(wrongExt.status, 400);
});

test('XLSX：导入 → 导出往返保留数值类型与行数', async () => {
  const source = await buildXlsx('销售数据', ['月份', '营收', '成本'], [
    { 月份: '1月', 营收: 128, 成本: 62 },
    { 月份: '2月', 营收: 142, 成本: 65 },
    { 月份: '3月', 营收: null, 成本: 68 },
  ]);
  const imported = await post('/api/analytics/datasets/xlsx', { filename: '销售数据.xlsx', contentBase64: source.toString('base64') });
  assert.equal(imported.status, 201);
  const dataset = (await imported.json() as { data: { id: string; stats: { rowCount: number; columnCount: number }; rows: Array<Record<string, unknown>> } }).data;
  assert.equal(dataset.stats.rowCount, 3);
  assert.equal(dataset.stats.columnCount, 3);
  assert.equal(dataset.rows[0]['营收'], 128, '数值列应保持数值类型');
  assert.equal(dataset.rows[2]['营收'], null, '空单元格应为 null');

  const exported = await get(`/api/analytics/datasets/${dataset.id}/export?format=xlsx`);
  assert.equal(exported.status, 200);
  assert.ok(String(exported.headers.get('content-type')).includes('spreadsheetml'));
  assert.ok(isZip(Buffer.from(await exported.arrayBuffer())), 'XLSX 应是合法 zip 容器');

  const csv = await get(`/api/analytics/datasets/${dataset.id}/export`);
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).includes('128'), '默认导出仍是 CSV');
});

test('XLSX：坏文件被拒绝', async () => {
  const garbage = await post('/api/analytics/datasets/xlsx', {
    filename: '坏表格.xlsx', contentBase64: Buffer.from('不是 xlsx').toString('base64'),
  });
  assert.equal(garbage.status, 400);
});

test('PPTX：离线引擎也能从文档生成演示文稿', async () => {
  const created = await post('/api/documents', { title: '演示测试', content: SAMPLE_MD, kind: 'general' });
  assert.equal(created.status, 201);
  const doc = (await created.json() as { data: { id: string } }).data;

  const slides = await post(`/api/documents/${doc.id}/slides`, {});
  assert.equal(slides.status, 200);
  assert.ok(String(slides.headers.get('content-type')).includes('presentationml'));
  assert.ok(Number(slides.headers.get('x-slide-count')) >= 2, '应至少切出两页');
  const buffer = Buffer.from(await slides.arrayBuffer());
  assert.ok(isZip(buffer), 'PPTX 应是合法 zip 容器');
  assert.ok(buffer.length > 5000, 'PPTX 不应是空壳');

  const activity = await get('/api/dashboard/activity');
  assert.equal(activity.status, 200);
});

test('Office 导出同样受会话保护', async () => {
  const response = await fetch(`${base}/api/documents/doc_any/export?format=docx`);
  assert.equal(response.status, 401);
});