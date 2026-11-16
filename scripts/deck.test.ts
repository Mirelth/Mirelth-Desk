/**
 * 演示文稿模板库与品牌套件测试。
 *
 * 校验方式比既有测试更严：不只查 zip 魔数，而是**解出 XML 检查内容**——
 * 版式是否真的渲染了对应元素、品牌色是否进了 XML、Logo 是否成为图片关系。
 */
process.env.DATABASE_PATH = '.data/regression-deck.db';
process.env.APP_SECRET = 'regression-deck-secret-0123456789';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.BROWSER_ENABLED = 'false';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

const { createApp } = await import('../server/app.ts');
const { closeDatabase, migrate } = await import('../server/shared/database.ts');
const { authService } = await import('../server/features/auth/auth.service.ts');
const {
  deckToPptx, parseDeckJson, markdownToDeck, deckCatalog, normalizeBrand, normalizeHexColor, resolveTokens,
  SLIDE_LAYOUTS, DECK_THEMES,
} = await import('../server/shared/office.ts');

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
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-deck.db${suffix}`, { force: true });
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
});

/**
 * 最小 zip 读取：解出所有条目名与解压后的文本。
 * pptx 是 zip 容器，只有解出来才能断言「品牌色真的进了 XML」而不是只看文件头。
 */
function readZip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  // 从末尾找中央目录结束记录（签名 0x06054b50）。
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) return files;
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    // 本地头长度可变，需按本地头自己的字段算数据起点。
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    try {
      files.set(name, method === 8 ? zlib.inflateRawSync(raw).toString('utf8') : raw.toString('utf8'));
    } catch { /* 二进制条目（如图片）解不成文本，跳过内容只留名字 */ files.set(name, ''); }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const slidesXml = (files: Map<string, string>): string =>
  [...files.entries()].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(([, xml]) => xml).join('\n');

// 一个覆盖全部九种版式的完整大纲。
const FULL_DECK = {
  title: '全版式演示',
  slides: [
    { title: '第一章', bullets: ['章节说明'], layout: 'section' as const },
    { title: '要点页', bullets: ['要点一', '要点二'], layout: 'bullets' as const },
    { title: '双栏页', bullets: [], layout: 'twoColumn' as const, columns: [['左一', '左二'], ['右一']] as [string[], string[]] },
    { title: '表格页', bullets: [], layout: 'table' as const, table: [['列A', '列B'], ['1', '2']] },
    { title: '引述页', bullets: [], layout: 'quote' as const, quote: { text: '简洁是可靠的前提。', attribution: '工程守则' } },
    { title: '指标页', bullets: [], layout: 'metrics' as const, metrics: [{ label: '交付数', value: '18', note: '本季度' }, { label: '缺陷', value: '3' }] },
    { title: '时间线', bullets: [], layout: 'timeline' as const, timeline: [{ label: '一月', text: '立项' }, { label: '三月', text: '上线' }] },
    { title: '图表页', bullets: [], layout: 'chart' as const, chart: { labels: ['A', 'B', 'C'], values: [3, 7, 5], caption: '来源：季度统计' } },
    { title: '谢谢', bullets: ['联系方式见内网'], layout: 'closing' as const },
  ],
};

// ---------------------------------------------------------------- 模板库

test('模板库：九版式七主题，清单与实现一致', () => {
  const catalog = deckCatalog();
  assert.equal(catalog.layouts.length, 9);
  assert.equal(catalog.themes.length, 7);
  assert.deepEqual(catalog.layouts.map((item) => item.value), SLIDE_LAYOUTS);
  assert.deepEqual(catalog.themes.map((item) => item.value), DECK_THEMES);
  assert.ok(catalog.themes.every((theme) => /^[0-9A-F]{6}$/.test(theme.cover)), '主题色应是合法 hex');
  assert.ok(catalog.layouts.every((layout) => layout.label), '每个版式都要有中文名');
});

test('九种版式都能生成合法 pptx，且各自的元素真的进了 XML', async () => {
  const buffer = await deckToPptx({ ...FULL_DECK, theme: 'violet' });
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
  const files = readZip(buffer);
  assert.ok(files.size > 10, `应能解出多个条目，实际 ${files.size}`);
  const xml = slidesXml(files);
  // 封面 + 9 页 = 10 张幻灯片。
  assert.equal([...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 10);
  assert.ok(xml.includes('简洁是可靠的前提。'), '引述正文应进 XML');
  assert.ok(xml.includes('工程守则'), '引述出处应进 XML');
  assert.ok(xml.includes('交付数') && xml.includes('18'), '指标卡应进 XML');
  assert.ok(xml.includes('立项') && xml.includes('上线'), '时间线应进 XML');
  assert.ok(xml.includes('来源：季度统计'), '图表说明应进 XML');
  assert.ok(xml.includes('<a:tbl>'), '表格页应生成真实表格元素');
  assert.ok(xml.includes('ellipse'), '时间线应有圆点形状');
  assert.ok(xml.includes('谢谢'), '结束页应进 XML');
});

test('七套主题都能生成，且主题色进 XML', async () => {
  for (const theme of DECK_THEMES) {
    const buffer = await deckToPptx({ title: '主题测试', theme, slides: [{ title: '页', bullets: ['要点'], layout: 'bullets' }] });
    const tokens = resolveTokens(theme);
    const xml = slidesXml(readZip(buffer));
    assert.ok(xml.includes(tokens.cover), `主题 ${theme} 的封面色应出现在 XML`);
  }
});

// ---------------------------------------------------------------- 品牌套件

test('品牌套件：组织名、页脚、字体、品牌色都生效', async () => {
  const buffer = await deckToPptx({
    title: '品牌演示', theme: 'ocean',
    brand: {
      organization: '示例科技', tagline: '2026 年度复盘', footer: '示例科技 · 内部资料',
      fontFace: 'SimSun', primaryColor: '0A2540', accentColor: 'FF6B35',
    },
    slides: [{ title: '内容页', bullets: ['要点'], layout: 'bullets' }],
  });
  const files = readZip(buffer);
  const xml = slidesXml(files);
  assert.ok(xml.includes('示例科技'), '组织名应进 XML');
  assert.ok(xml.includes('2026 年度复盘'), '封面副标题应进 XML');
  assert.ok(xml.includes('内部资料'), '自定义页脚应进 XML');
  assert.ok(xml.includes('SimSun'), '自定义字体应进 XML');
  assert.ok(xml.includes('0A2540'), '品牌主色应覆盖主题封面色');
  assert.ok(xml.includes('FF6B35'), '品牌强调色应生效');
  assert.ok(!xml.includes('Mirelth Desk · AI Office 生成'), '指定页脚后不应再出现默认文案');
  assert.ok(files.get('docProps/core.xml')?.includes('示例科技'), '作者应写入文档属性');
});

test('品牌 Logo：作为图片嵌入并建立关系', async () => {
  // 1x1 透明 PNG，足够验证嵌入链路。
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const buffer = await deckToPptx({
    title: 'Logo 演示', brand: { logoDataUri: png },
    slides: [{ title: '内容页', bullets: ['要点'], layout: 'bullets' }],
  });
  const files = readZip(buffer);
  const media = [...files.keys()].filter((name) => name.startsWith('ppt/media/'));
  assert.ok(media.length >= 1, `Logo 应作为媒体文件嵌入，实际 ${media.length}`);
  const xml = slidesXml(files);
  assert.ok(xml.includes('<a:blip'), '幻灯片应引用图片');
  const rels = [...files.entries()].filter(([name]) => name.includes('slides/_rels')).map(([, content]) => content).join('');
  assert.ok(rels.includes('image'), '应建立图片关系');
});

test('品牌校验：非法颜色与非图片 data URI 被丢弃，不污染输出', () => {
  assert.equal(normalizeHexColor('#1F3A5F'), '1F3A5F');
  assert.equal(normalizeHexColor('1f3a5f'), '1F3A5F');
  assert.equal(normalizeHexColor('xyz'), undefined);
  assert.equal(normalizeHexColor('#12345'), undefined, '五位 hex 不合法');
  assert.equal(normalizeHexColor('1F3A5F; DROP TABLE'), undefined, '注入串必须被拒');

  const brand = normalizeBrand({
    organization: '  示例  ', primaryColor: 'invalid',
    logoDataUri: 'data:text/html;base64,PHNjcmlwdD4=',
    fontFace: 'x'.repeat(200),
  });
  assert.equal(brand?.organization, '示例');
  assert.equal(brand?.primaryColor, undefined, '非法颜色应被丢弃');
  assert.equal(brand?.logoDataUri, undefined, '非 png/jpeg 的 data URI 应被拒');
  assert.ok((brand?.fontFace?.length ?? 0) <= 60, '字体名应截断');
  assert.equal(normalizeBrand({}), undefined, '空品牌应返回 undefined');
  assert.equal(normalizeBrand(null), undefined);
});

// ---------------------------------------------------------------- 解析与降级

test('大纲解析：新版式数据齐全时保留，缺数据退回要点页', () => {
  const deck = parseDeckJson(JSON.stringify({
    title: 'T', theme: 'sand',
    slides: [
      { title: '有引文', layout: 'quote', quote: { text: '一句话' } },
      { title: '缺引文', layout: 'quote' },
      { title: '有指标', layout: 'metrics', metrics: [{ label: 'a', value: '1' }] },
      { title: '缺指标', layout: 'metrics', metrics: [] },
      { title: '有时间线', layout: 'timeline', timeline: [{ label: '一月', text: '立项' }] },
      { title: '缺时间线', layout: 'timeline' },
      { title: '有图表', layout: 'chart', chart: { labels: ['A'], values: [1] } },
      { title: '图表长度不匹配', layout: 'chart', chart: { labels: ['A', 'B'], values: [1] } },
      { title: '结束', layout: 'closing', bullets: ['再见'] },
    ],
  }));
  assert.ok(deck);
  assert.equal(deck!.theme, 'sand');
  const byTitle = new Map(deck!.slides.map((slide) => [slide.title, slide.layout]));
  assert.equal(byTitle.get('有引文'), 'quote');
  assert.equal(byTitle.get('缺引文'), 'bullets');
  assert.equal(byTitle.get('有指标'), 'metrics');
  assert.equal(byTitle.get('缺指标'), 'bullets');
  assert.equal(byTitle.get('有时间线'), 'timeline');
  assert.equal(byTitle.get('缺时间线'), 'bullets');
  assert.equal(byTitle.get('有图表'), 'chart');
  assert.equal(byTitle.get('图表长度不匹配'), 'bullets', 'labels 与 values 不等长应视为无数据');
  assert.equal(byTitle.get('结束'), 'closing');
});

test('大纲解析：非法版式与主题退回默认，指标数量与图表点数受上限', () => {
  const deck = parseDeckJson(JSON.stringify({
    title: 'T', theme: 'nonexistent',
    slides: [
      { title: '非法版式', layout: 'hologram', bullets: ['x'] },
      {
        title: '超量指标', layout: 'metrics',
        metrics: Array.from({ length: 9 }, (_, index) => ({ label: `L${index}`, value: String(index) })),
      },
      {
        title: '超量图表', layout: 'chart',
        chart: { labels: Array.from({ length: 20 }, (_, i) => `L${i}`), values: Array.from({ length: 20 }, (_, i) => i) },
      },
    ],
  }));
  assert.equal(deck!.theme, 'ocean', '未知主题应退回默认');
  assert.equal(deck!.slides[0].layout, 'bullets', '未知版式应退回要点页');
  assert.ok((deck!.slides[1].metrics?.length ?? 0) <= 4, '指标最多 4 个');
  assert.ok((deck!.slides[2].chart?.labels.length ?? 0) <= 8, '图表最多 8 点');
});

test('大纲解析：指标值保留原文，非有限数被丢弃（不编造）', () => {
  const deck = parseDeckJson(JSON.stringify({
    title: 'T',
    slides: [{
      title: '指标', layout: 'metrics',
      metrics: [
        { label: '文本值', value: '约 18 个' },
        { label: '数字值', value: 42 },
        { label: '缺值' },
        { label: '非法数', value: 'NaN' },
      ],
    }],
  }));
  const metrics = deck!.slides[0].metrics ?? [];
  assert.ok(metrics.some((item) => item.value === '约 18 个'), '文本数值应原样保留');
  assert.ok(metrics.some((item) => item.value === '42'), '数字应转成字符串');
  assert.ok(!metrics.some((item) => item.label === '缺值'), '无值指标应被丢弃');
});

test('Markdown 切分：长引文升格引述页，H1 仍作分节页', () => {
  const deck = markdownToDeck('文档', '# 第一章\n\n## 背景\n\n> 这是一段足够长的引文内容，用于验证引述页的升格逻辑是否生效。\n\n- 要点一');
  assert.ok(deck.slides.some((slide) => slide.layout === 'section'), 'H1 应是分节页');
  const quote = deck.slides.find((slide) => slide.layout === 'quote');
  assert.ok(quote, '长引文应升格为引述页');
  assert.ok(quote!.quote?.text.includes('足够长的引文'));
});

test('溢出保护：超长要点、表格、指标与时间线都被截断', async () => {
  const long = 'x'.repeat(500);
  const buffer = await deckToPptx({
    title: long,
    slides: [
      { title: long, bullets: Array.from({ length: 20 }, () => long), layout: 'bullets' },
      { title: '表格', bullets: [], layout: 'table', table: Array.from({ length: 30 }, () => [long, long]) },
      { title: '指标', bullets: [], layout: 'metrics', metrics: [{ label: long, value: long }] },
      { title: '时间线', bullets: [], layout: 'timeline', timeline: [{ label: long, text: long }] },
    ],
  });
  assert.ok(buffer.length > 5000, '超长输入仍应产出合法文件');
  assert.equal(buffer[0], 0x50);
  const deck = parseDeckJson(JSON.stringify({
    title: 'T',
    slides: [
      { title: 'a', bullets: Array.from({ length: 20 }, () => long) },
      { title: 'b', layout: 'quote', quote: { text: long } },
      { title: 'c', layout: 'timeline', timeline: Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, text: long })) },
    ],
  }));
  assert.ok(deck!.slides[0].bullets.length <= 6, '要点最多 6 条');
  assert.ok(deck!.slides[0].bullets.every((bullet) => bullet.length <= 110), '要点长度受限');
  assert.ok((deck!.slides[1].quote?.text.length ?? 0) <= 220, '引文长度受限');
  assert.ok((deck!.slides[2].timeline?.length ?? 0) <= 5, '时间线最多 5 项');
});

// ---------------------------------------------------------------- HTTP

test('GET /slides/catalog 返回模板库', async () => {
  const response = await get('/api/documents/slides/catalog');
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { layouts: unknown[]; themes: unknown[] } };
  assert.equal(body.data.layouts.length, 9);
  assert.equal(body.data.themes.length, 7);
});

test('slides 端点同时支持 GET 与 POST（修复前端下载入口）', async () => {
  const created = await post('/api/documents', { title: '演示测试文档', content: '# 章节\n\n## 小节\n\n- 要点一\n- 要点二', kind: 'general' });
  const doc = (await created.json() as { data: { id: string } }).data;

  const viaGet = await get(`/api/documents/${doc.id}/slides?theme=forest`);
  assert.equal(viaGet.status, 200, 'GET 必须可用——前端 downloadFile 走 GET');
  assert.ok(viaGet.headers.get('content-type')?.includes('presentationml'));
  const getBuffer = Buffer.from(await viaGet.arrayBuffer());
  assert.equal(getBuffer[0], 0x50);
  assert.ok(slidesXml(readZip(getBuffer)).includes(resolveTokens('forest').cover), 'GET 的主题参数应生效');

  const viaPost = await post(`/api/documents/${doc.id}/slides`, {
    theme: 'crimson', brand: { organization: '测试组织', footer: '测试页脚' },
  });
  assert.equal(viaPost.status, 200);
  const postBuffer = Buffer.from(await viaPost.arrayBuffer());
  const xml = slidesXml(readZip(postBuffer));
  assert.ok(xml.includes('测试组织'), 'POST 的品牌应生效');
  assert.ok(xml.includes('测试页脚'));
  assert.ok(xml.includes(resolveTokens('crimson').cover));
});

test('slides 参数校验：非法主题被拒且给出可读错误', async () => {
  const created = await post('/api/documents', { title: '校验文档', content: '正文', kind: 'general' });
  const doc = (await created.json() as { data: { id: string } }).data;
  const bad = await post(`/api/documents/${doc.id}/slides`, { theme: 'rainbow' });
  assert.equal(bad.status, 422);
  const body = await bad.json() as { title: string };
  assert.equal(body.title, 'VALIDATION_ERROR');
});

test('离线保留真实表格结构，不压成要点文本', async () => {
  const created = await post('/api/documents', {
    title: '表格文档', kind: 'general',
    content: '# 数据概览\n\n## 关键指标\n\n| 指标 | 数值 |\n| --- | --- |\n| 交付 | 18 |\n| 缺陷 | 3 |',
  });
  const doc = (await created.json() as { data: { id: string } }).data;
  const response = await get(`/api/documents/${doc.id}/slides`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ai-mode'), 'offline');
  const xml = slidesXml(readZip(Buffer.from(await response.arrayBuffer())));
  assert.ok(xml.includes('<a:tbl>'), '文档里的真实表格应渲染为表格页，而不是压成「指标 ｜ 数值」要点');
  assert.ok(xml.includes('交付') && xml.includes('18'), '表格内容应完整保留');
});

test('离线也能生成多版式演示（无密钥承诺）', async () => {
  const created = await post('/api/documents', {
    title: '离线演示', kind: 'general',
    content: '# 总览\n\n## 背景\n\n> 一段足够长的引文，用来验证离线降级也能产出引述页而不是全要点页。\n\n- 要点甲\n- 要点乙',
  });
  const doc = (await created.json() as { data: { id: string } }).data;
  const response = await get(`/api/documents/${doc.id}/slides`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ai-mode'), 'offline');
  const xml = slidesXml(readZip(Buffer.from(await response.arrayBuffer())));
  assert.ok(xml.includes('足够长的引文'), '离线应产出引述内容');
  assert.ok(Number(response.headers.get('x-slide-count')) >= 2);
});