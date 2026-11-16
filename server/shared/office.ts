/**
 * AI Office 共享层：Markdown ↔ DOCX、Markdown → 幻灯片大纲 → PPTX、base64 上传解码。
 * 只依赖第三方库与 shared/errors，不依赖任何 feature；模型调用仍只走 ai/provider。
 */
import {
  AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import mammoth from 'mammoth';
import * as PptxGenJSImport from 'pptxgenjs';

// CJS/ESM 互操作：nodenext 下命名空间导入的构造器可能挂在 default 上。
// 库的命名空间类型在 nodenext 下不可直接引用，这里用结构化最小类型描述用到的 API。
interface PptxSlide {
  background: { color: string };
  addText(text: unknown, options?: Record<string, unknown>): PptxSlide;
  addShape(shapeName: string, options?: Record<string, unknown>): PptxSlide;
  addTable(rows: unknown[], options?: Record<string, unknown>): PptxSlide;
  addImage(options: Record<string, unknown>): PptxSlide;
}
interface PptxInstance {
  layout: string; author: string; title: string;
  addSlide(): PptxSlide;
  write(props: { outputType: string }): Promise<string | ArrayBuffer | Blob | Uint8Array>;
}
const PptxGenJS = ((PptxGenJSImport as unknown as { default?: unknown }).default
  ?? PptxGenJSImport) as unknown as new () => PptxInstance;
import { BadRequestError } from './errors.ts';

export const OFFICE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

/** 与 platform 文件上传同口径：解码后 5MB 上限。 */
export function decodeBase64File(contentBase64: string, label: string): Buffer {
  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length) throw new BadRequestError(`${label}内容为空`);
  if (buffer.length > 5 * 1024 * 1024) throw new BadRequestError(`${label}超过 5MB 上限，请先精简文件`);
  return buffer;
}

/** 去掉内联标记，保留可读文本（DOCX 的 run 与 PPT 的要点都用它）。 */
export function stripInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1（$2）')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

// ---------------------------------------------------------------- Markdown → DOCX

function docxRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) runs.push(new TextRun(text.slice(last, index)));
    const token = match[0];
    if (token.startsWith('**')) runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    else runs.push(new TextRun({ text: token.slice(1, -1), font: 'Consolas' }));
    last = index + token.length;
  }
  if (last < text.length) runs.push(new TextRun(text.slice(last)));
  if (!runs.length) runs.push(new TextRun(''));
  return runs;
}

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
] as const;

function splitTableRow(line: string): string[] {
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
}

function docxTable(rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((cells, rowIndex) => new TableRow({
      children: cells.map((cell) => new TableCell({
        children: [new Paragraph({
          children: rowIndex === 0 ? [new TextRun({ text: stripInline(cell), bold: true })] : docxRuns(stripInline(cell)),
        })],
      })),
    })),
  });
}

/** 把 Markdown 渲染为 DOCX：标题/列表/表格/代码块/引用/段落，与前端渲染器同一套语法。 */
export async function markdownToDocx(title: string, markdown: string): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let codeOpen = false;
  let tableRows: string[][] = [];

  const flushTable = (): void => {
    if (tableRows.length) { children.push(docxTable(tableRows)); tableRows = []; }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushTable();
      codeOpen = !codeOpen;
      continue;
    }
    if (codeOpen) {
      children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas', size: 20 })] }));
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) { flushTable(); continue; }
    if (/^\|.*\|$/.test(trimmed)) {
      const cells = splitTableRow(trimmed);
      if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) tableRows.push(cells);
      continue;
    }
    flushTable();
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      children.push(new Paragraph({ text: stripInline(heading[2]), heading: HEADING_LEVELS[heading[1].length - 1] }));
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      children.push(new Paragraph({ children: docxRuns(stripInline(trimmed.replace(/^[-*]\s+/, ''))), bullet: { level: 0 } }));
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      children.push(new Paragraph({ children: docxRuns(stripInline(trimmed)), numbering: { reference: 'office-numbered', level: 0 } }));
      continue;
    }
    if (trimmed.startsWith('>')) {
      children.push(new Paragraph({ children: [new TextRun({ text: stripInline(trimmed.slice(1)), italics: true, color: '595959' })] }));
      continue;
    }
    children.push(new Paragraph({ children: docxRuns(stripInline(trimmed)) }));
  }
  flushTable();

  const doc = new Document({
    title,
    numbering: {
      config: [{
        reference: 'office-numbered',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }],
      }],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------- DOCX → Markdown

const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  "p[style-name='Heading 5'] => h5:fresh",
  "p[style-name='Heading 6'] => h6:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "r[style-name='Strong'] => strong",
  "r[style-name='Emphasis'] => em",
];

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function inlineHtmlToMarkdown(html: string): string {
  return decodeEntities(html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<img [^>]*alt="([^"]*)"[^>]*\/?>/gi, '$1')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 把 mammoth 输出的受限 HTML 转成 Markdown（标题/列表/表格/引用/代码块）。 */
export function htmlToMarkdown(html: string): string {
  const blocks: string[] = [];
  const pattern = /<(h[1-6]|p|pre|blockquote|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[1].toLowerCase();
    const inner = match[2];
    if (tag.startsWith('h')) {
      const text = inlineHtmlToMarkdown(inner);
      if (text) blocks.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
      continue;
    }
    if (tag === 'pre') {
      blocks.push(`\`\`\`\n${decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()}\n\`\`\``);
      continue;
    }
    if (tag === 'blockquote') {
      const text = inlineHtmlToMarkdown(inner);
      if (text) blocks.push(text.split('\n').map((line) => `> ${line}`).join('\n'));
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items: string[] = [];
      let index = 0;
      for (const item of inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
        index += 1;
        const text = inlineHtmlToMarkdown(item[1]);
        if (text) items.push(`${tag === 'ol' ? `${index}.` : '-'} ${text}`);
      }
      if (items.length) blocks.push(items.join('\n'));
      continue;
    }
    if (tag === 'table') {
      const rows: string[][] = [];
      for (const row of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells: string[] = [];
        for (const cell of row[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)) cells.push(inlineHtmlToMarkdown(cell[2]));
        if (cells.length) rows.push(cells);
      }
      if (rows.length) {
        const width = Math.max(...rows.map((row) => row.length));
        const padded = rows.map((row) => [...row, ...Array<string>(width - row.length).fill('')]);
        blocks.push([
          `| ${padded[0].join(' | ')} |`,
          `| ${Array<string>(width).fill('---').join(' | ')} |`,
          ...padded.slice(1).map((row) => `| ${row.join(' | ')} |`),
        ].join('\n'));
      }
      continue;
    }
    const text = inlineHtmlToMarkdown(inner);
    if (text) blocks.push(text);
  }
  return blocks.join('\n\n').trim();
}

export async function docxToMarkdown(buffer: Buffer): Promise<{ markdown: string; warnings: string[] }> {
  let result: { value: string; messages: Array<{ type: string; message: string }> };
  try {
    result = await mammoth.convertToHtml({ buffer }, { styleMap: DOCX_STYLE_MAP });
  } catch {
    throw new BadRequestError('无法解析该文件，请确认是有效的 .docx 文档');
  }
  const markdown = htmlToMarkdown(result.value);
  if (!markdown) throw new BadRequestError('文档中没有可导入的文本内容');
  return { markdown, warnings: result.messages.filter((item) => item.type === 'warning').map((item) => item.message).slice(0, 10) };
}

// ---------------------------------------------------------------- Markdown → 幻灯片大纲

/**
 * 版式库。前四种是既有版式，保持不变以兼容历史大纲；后五种是本次新增。
 * 缺省或无法识别的版式一律按要点页渲染——宁可退化成朴素页，也不出空白页。
 */
export type SlideLayout =
  | 'bullets' | 'section' | 'twoColumn' | 'table'
  | 'quote' | 'metrics' | 'timeline' | 'chart' | 'closing';

export const SLIDE_LAYOUTS: SlideLayout[] = [
  'bullets', 'section', 'twoColumn', 'table', 'quote', 'metrics', 'timeline', 'chart', 'closing',
];

/** 版式的中文名与适用场景，供界面选择与提示词使用（单一事实来源）。 */
export const LAYOUT_LABELS: Record<SlideLayout, string> = {
  bullets: '要点页',
  section: '分节页',
  twoColumn: '双栏对比',
  table: '表格页',
  quote: '引述页',
  metrics: '指标卡',
  timeline: '时间线',
  chart: '图表页',
  closing: '结束页',
};

export interface DeckMetric { label: string; value: string; note?: string }
export interface DeckTimelineItem { label: string; text: string }
export interface DeckChart { labels: string[]; values: number[]; caption?: string }

export interface DeckSlide {
  title: string;
  bullets: string[];
  layout?: SlideLayout;
  /** 表格页的数据；首行作表头。 */
  table?: string[][];
  /** 双栏页的左右两列要点。 */
  columns?: [string[], string[]];
  /** 引述页：引文与出处。出处可空，但引文必须有。 */
  quote?: { text: string; attribution?: string };
  /** 指标卡：2–4 个关键数字。**只放材料里真实存在的数字，不得编造。** */
  metrics?: DeckMetric[];
  /** 时间线：按顺序的里程碑。 */
  timeline?: DeckTimelineItem[];
  /** 图表页：柱状图数据，取自真实统计。 */
  chart?: DeckChart;
}

/**
 * 品牌套件：把「谁的演示文稿」与「用什么配色」分开。
 * 主题决定色板，品牌决定字体、Logo、页脚与封面副标题——同一套品牌可配不同主题。
 */
export interface BrandKit {
  /** 组织名，出现在封面与页脚。 */
  organization?: string;
  /** 封面副标题；留空则用默认生成说明。 */
  tagline?: string;
  /** 页脚文案；留空则用组织名，再留空用默认。 */
  footer?: string;
  /** 字体族名。留空用默认中文字体。 */
  fontFace?: string;
  /** 品牌主色（6 位 hex，无 #）：覆盖主题的封面色与强调色。 */
  primaryColor?: string;
  /** 品牌强调色（6 位 hex，无 #）。 */
  accentColor?: string;
  /** Logo 图片的 data URI（`data:image/png;base64,...`）。由调用方读文件后传入。 */
  logoDataUri?: string;
}

export interface SlideDeck {
  title: string;
  slides: DeckSlide[];
  theme?: DeckTheme;
  brand?: BrandKit;
}

export type DeckTheme = 'ocean' | 'forest' | 'slate' | 'crimson' | 'violet' | 'sand' | 'mono';

export const DECK_THEMES: DeckTheme[] = ['ocean', 'forest', 'slate', 'crimson', 'violet', 'sand', 'mono'];

export const THEME_LABELS: Record<DeckTheme, string> = {
  ocean: '深海蓝', forest: '森林绿', slate: '石板灰',
  crimson: '绛红', violet: '紫罗兰', sand: '暖砂', mono: '极简黑白',
};

interface ThemeTokens {
  cover: string; accent: string; heading: string; body: string; muted: string;
  /** 浅底色：卡片/表格隔行用，需与 body 有足够对比。 */
  surface: string;
  /** 深底上的次要文字色（封面副标题、分节页说明）。 */
  onCover: string;
}

const THEMES: Record<DeckTheme, ThemeTokens> = {
  ocean: { cover: '1F3A5F', accent: '3B82F6', heading: '1F3A5F', body: '333333', muted: '999999', surface: 'F5F7FA', onCover: 'D8E2EF' },
  forest: { cover: '14532D', accent: '22C55E', heading: '14532D', body: '2F3A33', muted: '8A9A90', surface: 'F2F7F3', onCover: 'D6E9DC' },
  slate: { cover: '1E293B', accent: '64748B', heading: '1E293B', body: '334155', muted: '94A3B8', surface: 'F4F6F8', onCover: 'DCE3EB' },
  crimson: { cover: '7F1D1D', accent: 'EF4444', heading: '7F1D1D', body: '3A2E2E', muted: 'A08C8C', surface: 'FBF4F4', onCover: 'F0D9D9' },
  violet: { cover: '4C1D95', accent: '8B5CF6', heading: '4C1D95', body: '332F3D', muted: '9A93A8', surface: 'F6F4FB', onCover: 'E2DAF3' },
  sand: { cover: '78350F', accent: 'F59E0B', heading: '78350F', body: '3D3428', muted: 'A2937C', surface: 'FBF7F0', onCover: 'F0E3CE' },
  mono: { cover: '111111', accent: '555555', heading: '111111', body: '222222', muted: '888888', surface: 'F5F5F5', onCover: 'DDDDDD' },
};

const MAX_BULLETS = 6;
const MAX_BULLET_LEN = 110;
const MAX_METRICS = 4;
const MAX_TIMELINE = 5;
const MAX_CHART_POINTS = 8;

/** 只接受 6 位 hex（不带 #）：品牌色来自用户输入，必须校验后再进 XML。 */
export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(cleaned) ? cleaned.toUpperCase() : undefined;
}

/** 品牌套件收敛：颜色校验、文本截断、Logo 只接受 png/jpeg 的 data URI。 */
export function normalizeBrand(input: unknown): BrandKit | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
  };
  const logo = typeof raw.logoDataUri === 'string' && /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(raw.logoDataUri)
    ? raw.logoDataUri : undefined;
  const brand: BrandKit = {
    ...(text(raw.organization, 60) ? { organization: text(raw.organization, 60) } : {}),
    ...(text(raw.tagline, 120) ? { tagline: text(raw.tagline, 120) } : {}),
    ...(text(raw.footer, 80) ? { footer: text(raw.footer, 80) } : {}),
    ...(text(raw.fontFace, 60) ? { fontFace: text(raw.fontFace, 60) } : {}),
    ...(normalizeHexColor(raw.primaryColor) ? { primaryColor: normalizeHexColor(raw.primaryColor) } : {}),
    ...(normalizeHexColor(raw.accentColor) ? { accentColor: normalizeHexColor(raw.accentColor) } : {}),
    ...(logo ? { logoDataUri: logo } : {}),
  };
  return Object.keys(brand).length ? brand : undefined;
}

/** 主题 + 品牌 → 最终令牌。品牌色覆盖主题色，其余沿用主题。 */
export function resolveTokens(theme: DeckTheme | undefined, brand?: BrandKit): ThemeTokens {
  const base = THEMES[theme ?? 'ocean'] ?? THEMES.ocean;
  if (!brand) return base;
  return {
    ...base,
    ...(brand.primaryColor ? { cover: brand.primaryColor, heading: brand.primaryColor } : {}),
    ...(brand.accentColor ? { accent: brand.accentColor } : {}),
  };
}

/** 供界面与提示词使用的模板库清单（单一事实来源，避免前后端各写一份）。 */
export function deckCatalog(): {
  layouts: Array<{ value: SlideLayout; label: string }>;
  themes: Array<{ value: DeckTheme; label: string; cover: string; accent: string }>;
} {
  return {
    layouts: SLIDE_LAYOUTS.map((value) => ({ value, label: LAYOUT_LABELS[value] })),
    themes: DECK_THEMES.map((value) => ({ value, label: THEME_LABELS[value], cover: THEMES[value].cover, accent: THEMES[value].accent })),
  };
}

/** 按 H1/H2 切分幻灯片，H3 并入要点；表格自动转表格页，长文档不丢结构。 */
export function markdownToDeck(title: string, markdown: string): SlideDeck {
  const slides: DeckSlide[] = [];
  let current: DeckSlide | null = null;
  let pendingTable: string[][] = [];

  const pushBullet = (value: string): void => {
    if (!current || !value) return;
    if (current.bullets.length < MAX_BULLETS) {
      current.bullets.push(value.length > MAX_BULLET_LEN ? `${value.slice(0, MAX_BULLET_LEN)}…` : value);
    }
  };
  const flushTable = (): void => {
    if (!current || pendingTable.length < 2) { pendingTable = []; return; }
    current.layout = 'table';
    current.table = pendingTable.slice(0, 9);
    pendingTable = [];
  };
  const startSlide = (heading: string, level: number): void => {
    flushTable();
    current = {
      title: stripInline(heading).slice(0, 60) || '未命名页',
      bullets: [],
      // H1 作为分节页，H2 作为内容页——让层级在成品里可见。
      layout: level === 1 ? 'section' : 'bullets',
    };
    slides.push(current);
  };

  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('```')) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      if (level <= 2) startSlide(heading[2], level);
      else pushBullet(stripInline(heading[2]));
      continue;
    }
    if (!current) startSlide('概述', 2);
    if (/^\|.*\|$/.test(trimmed)) {
      const cells = splitTableRow(trimmed).map(stripInline);
      if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) pendingTable.push(cells);
      continue;
    }
    flushTable();
    if (/^[-*]\s+/.test(trimmed)) { pushBullet(stripInline(trimmed.replace(/^[-*]\s+/, ''))); continue; }
    if (/^\d+\.\s+/.test(trimmed)) { pushBullet(stripInline(trimmed)); continue; }
    if (trimmed.startsWith('>')) {
      // 整页只有一段引文时升格为引述页，比塞进要点更贴合语义。
      // 用数组末元素而非 current：闭包里的赋值会让 TS 对 current 的收窄失效。
      const text = stripInline(trimmed.replace(/^>\s?/, ''));
      const page = slides[slides.length - 1];
      if (page && !page.bullets.length && !page.table?.length && text.length >= 20) {
        page.layout = 'quote';
        page.quote = { text: text.slice(0, 220) };
      } else {
        pushBullet(text);
      }
      continue;
    }
    pushBullet(stripInline(trimmed));
  }
  flushTable();

  const usable = slides.filter((slide) => slide.bullets.length || slide.table?.length || slide.quote || slide.title !== '未命名页').slice(0, 20);
  if (!usable.length) usable.push({ title, bullets: ['（文档暂无正文内容）'], layout: 'bullets' });
  return { title, slides: usable, theme: 'ocean' };
}

function parseQuote(value: unknown): DeckSlide['quote'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { text?: unknown; attribution?: unknown };
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return undefined;
  const attribution = typeof raw.attribution === 'string' ? raw.attribution.trim().slice(0, 60) : '';
  return { text: text.slice(0, 220), ...(attribution ? { attribution } : {}) };
}

/** 指标必须有 label 与 value；value 保留原文字符串，不做数值推断以免编造。 */
function parseMetrics(value: unknown): DeckMetric[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: DeckMetric[] = [];
  for (const entry of value) {
    if (items.length >= MAX_METRICS) break;
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as { label?: unknown; value?: unknown; note?: unknown };
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const metricValue = typeof raw.value === 'string' ? raw.value.trim()
      : typeof raw.value === 'number' && Number.isFinite(raw.value) ? String(raw.value) : '';
    if (!label || !metricValue) continue;
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 40) : '';
    items.push({ label: label.slice(0, 24), value: metricValue.slice(0, 16), ...(note ? { note } : {}) });
  }
  return items.length ? items : undefined;
}

function parseTimeline(value: unknown): DeckTimelineItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: DeckTimelineItem[] = [];
  for (const entry of value) {
    if (items.length >= MAX_TIMELINE) break;
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as { label?: unknown; text?: unknown };
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!label || !text) continue;
    items.push({ label: label.slice(0, 20), text: text.slice(0, 70) });
  }
  return items.length ? items : undefined;
}

/** 图表数据：labels 与 values 必须等长且为有限数，否则视为无数据。 */
function parseChart(value: unknown): DeckChart | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { labels?: unknown; values?: unknown; caption?: unknown };
  if (!Array.isArray(raw.labels) || !Array.isArray(raw.values)) return undefined;
  const labels = raw.labels.filter((item): item is string => typeof item === 'string').slice(0, MAX_CHART_POINTS);
  const values = raw.values
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item))
    .slice(0, MAX_CHART_POINTS);
  if (!labels.length || labels.length !== values.length) return undefined;
  const caption = typeof raw.caption === 'string' ? raw.caption.trim().slice(0, 80) : '';
  return {
    labels: labels.map((label) => label.slice(0, 16)),
    values,
    ...(caption ? { caption } : {}),
  };
}

/** 解析模型输出的 JSON 大纲；失败或为空时返回 null，由调用方回退到 Markdown 切分。 */
export function parseDeckJson(text: string): SlideDeck | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { title?: unknown; slides?: unknown; brand?: unknown };
    if (!Array.isArray(parsed.slides)) return null;
    const layouts: SlideLayout[] = SLIDE_LAYOUTS;
    const slides: DeckSlide[] = parsed.slides
      .filter((item): item is {
        title: string; bullets?: unknown; layout?: unknown; table?: unknown; columns?: unknown;
        quote?: unknown; metrics?: unknown; timeline?: unknown; chart?: unknown;
      } =>
        typeof item === 'object' && item !== null && typeof (item as { title?: unknown }).title === 'string')
      .map((item) => {
        const bullets = Array.isArray(item.bullets)
          ? item.bullets.filter((bullet): bullet is string => typeof bullet === 'string').slice(0, MAX_BULLETS).map((bullet) => bullet.slice(0, MAX_BULLET_LEN))
          : [];
        const layout = layouts.includes(item.layout as SlideLayout) ? item.layout as SlideLayout : 'bullets';
        const table = Array.isArray(item.table)
          ? item.table.filter((row): row is string[] => Array.isArray(row) && row.every((cell) => typeof cell === 'string')).slice(0, 9)
          : undefined;
        const columns = Array.isArray(item.columns) && item.columns.length === 2
          && item.columns.every((col) => Array.isArray(col))
          ? [
            (item.columns[0] as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, MAX_BULLETS),
            (item.columns[1] as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, MAX_BULLETS),
          ] as [string[], string[]]
          : undefined;
        const quote = parseQuote(item.quote);
        const metrics = parseMetrics(item.metrics);
        const timeline = parseTimeline(item.timeline);
        const chart = parseChart(item.chart);
        // 声明了某版式但没给对应数据时退回要点页，避免出空白版式。
        const missing: Partial<Record<SlideLayout, boolean>> = {
          table: !table?.length, twoColumn: !columns, quote: !quote,
          metrics: !metrics?.length, timeline: !timeline?.length, chart: !chart,
        };
        return {
          title: item.title.slice(0, 60),
          bullets,
          layout: missing[layout] ? 'bullets' : layout,
          table, columns, quote, metrics, timeline, chart,
        };
      })
      .filter((slide) => slide.title.trim())
      .slice(0, 20);
    if (!slides.length) return null;
    const theme = DECK_THEMES.includes((parsed as { theme?: DeckTheme }).theme as DeckTheme)
      ? (parsed as { theme?: DeckTheme }).theme : 'ocean';
    const brand = normalizeBrand(parsed.brand);
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.slice(0, 100) : '演示文稿',
      slides, theme, ...(brand ? { brand } : {}),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 幻灯片大纲 → PPTX

const DEFAULT_FONT = 'Microsoft YaHei';
const DEFAULT_FOOTER = 'Mirelth Desk · AI Office 生成';

export async function deckToPptx(deck: SlideDeck): Promise<Buffer> {
  const brand = deck.brand;
  const tokens = resolveTokens(deck.theme, brand);
  const font = brand?.fontFace || DEFAULT_FONT;
  const footer = brand?.footer || brand?.organization || DEFAULT_FOOTER;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = brand?.organization || 'Mirelth Desk';
  pptx.title = deck.title;

  const bulletText = (items: string[]): Array<{ text: string; options: Record<string, unknown> }> =>
    items.map((bullet) => ({ text: bullet, options: { bullet: { code: '2022' }, breakLine: true } }));

  /** Logo 放右上角，尺寸固定以免大图撑破版面；无 Logo 时什么都不画。 */
  const putLogo = (page: PptxSlide): void => {
    if (!brand?.logoDataUri) return;
    page.addImage({ data: brand.logoDataUri, x: 8.85, y: 0.28, w: 0.85, h: 0.45 });
  };

  const cover = pptx.addSlide();
  cover.background = { color: tokens.cover };
  putLogo(cover);
  if (brand?.organization) {
    cover.addText(brand.organization, { x: 0.8, y: 1.35, w: 7.8, h: 0.4, fontSize: 14, color: tokens.onCover, fontFace: font });
  }
  cover.addText(deck.title, { x: 0.8, y: 2.0, w: 8.4, h: 1.4, fontSize: 36, bold: true, color: 'FFFFFF', fontFace: font });
  cover.addShape('line', { x: 0.82, y: 3.35, w: 2.2, h: 0, line: { color: tokens.accent, width: 3 } });
  cover.addText(brand?.tagline || footer, { x: 0.8, y: 3.6, w: 8.4, h: 0.5, fontSize: 14, color: tokens.onCover, fontFace: font });

  deck.slides.forEach((slide, index) => {
    const page = pptx.addSlide();
    const layout = slide.layout ?? 'bullets';
    const dark = layout === 'section' || layout === 'closing';

    if (layout === 'section' || layout === 'closing') {
      // 分节页与结束页：整页底色 + 大标题。
      page.background = { color: tokens.cover };
      putLogo(page);
      page.addText(slide.title, {
        x: 0.8, y: layout === 'closing' ? 2.0 : 2.2, w: 8.4, h: 1.0,
        fontSize: layout === 'closing' ? 34 : 30, bold: true, color: 'FFFFFF', fontFace: font,
      });
      page.addShape('line', { x: 0.82, y: layout === 'closing' ? 3.15 : 3.3, w: 1.8, h: 0, line: { color: tokens.accent, width: 3 } });
      if (slide.bullets.length) {
        page.addText(slide.bullets.slice(0, layout === 'closing' ? 3 : 1).join('\n'), {
          x: 0.8, y: layout === 'closing' ? 3.35 : 3.5, w: 8.4, h: layout === 'closing' ? 1.2 : 0.6,
          fontSize: 15, color: tokens.onCover, fontFace: font, valign: 'top',
        });
      }
    } else {
      putLogo(page);
      // 有 Logo 时标题宽度收窄，避免文字压到图上。
      page.addText(slide.title, {
        x: 0.6, y: 0.35, w: brand?.logoDataUri ? 8.0 : 8.8, h: 0.7,
        fontSize: 24, bold: true, color: tokens.heading, fontFace: font,
      });
      page.addShape('line', { x: 0.62, y: 1.12, w: 1.6, h: 0, line: { color: tokens.accent, width: 2 } });

      if (layout === 'table' && slide.table?.length) {
        const width = Math.max(...slide.table.map((row) => row.length));
        const rows = slide.table.map((row, rowIndex) => {
          const cells = [...row, ...Array<string>(Math.max(width - row.length, 0)).fill('')];
          return cells.map((cell) => ({
            text: cell.slice(0, 60),
            options: {
              bold: rowIndex === 0,
              color: rowIndex === 0 ? 'FFFFFF' : tokens.body,
              fill: { color: rowIndex === 0 ? tokens.cover : (rowIndex % 2 ? tokens.surface : 'FFFFFF') },
              fontSize: 12, fontFace: font, valign: 'middle' as const,
            },
          }));
        });
        page.addTable(rows, {
          x: 0.6, y: 1.4, w: 8.8, colW: Array<number>(width).fill(8.8 / width),
          border: { type: 'solid', color: 'D8DEE6', pt: 0.5 }, autoPage: false,
        });
      } else if (layout === 'twoColumn' && slide.columns) {
        slide.columns.forEach((column, columnIndex) => {
          const x = columnIndex === 0 ? 0.6 : 5.1;
          page.addShape('rect', { x, y: 1.4, w: 4.3, h: 3.5, fill: { color: tokens.surface }, line: { color: 'E2E8F0', width: 1 } });
          if (column.length) {
            page.addText(bulletText(column), {
              x: x + 0.2, y: 1.6, w: 3.9, h: 3.1, fontSize: 14, color: tokens.body,
              fontFace: font, paraSpaceAfter: 8, valign: 'top',
            });
          }
        });
      } else if (layout === 'quote' && slide.quote) {
        page.addShape('rect', { x: 0.6, y: 1.5, w: 0.12, h: 2.6, fill: { color: tokens.accent } });
        page.addText(slide.quote.text, {
          x: 1.0, y: 1.6, w: 8.2, h: 2.2, fontSize: 20, italic: true,
          color: tokens.heading, fontFace: font, valign: 'top',
        });
        if (slide.quote.attribution) {
          page.addText(`— ${slide.quote.attribution}`, {
            x: 1.0, y: 3.9, w: 8.2, h: 0.5, fontSize: 14, color: tokens.muted, fontFace: font,
          });
        }
      } else if (layout === 'metrics' && slide.metrics?.length) {
        const count = slide.metrics.length;
        const gap = 0.25;
        const cardWidth = (8.8 - gap * (count - 1)) / count;
        slide.metrics.forEach((metric, metricIndex) => {
          const x = 0.6 + metricIndex * (cardWidth + gap);
          page.addShape('rect', { x, y: 1.6, w: cardWidth, h: 2.4, fill: { color: tokens.surface }, line: { color: 'E2E8F0', width: 1 } });
          page.addText(metric.value, {
            x: x + 0.1, y: 1.9, w: cardWidth - 0.2, h: 0.9, fontSize: count > 3 ? 26 : 32,
            bold: true, color: tokens.accent, fontFace: font, align: 'center',
          });
          page.addText(metric.label, {
            x: x + 0.1, y: 2.85, w: cardWidth - 0.2, h: 0.5, fontSize: 14,
            color: tokens.heading, fontFace: font, align: 'center',
          });
          if (metric.note) {
            page.addText(metric.note, {
              x: x + 0.1, y: 3.35, w: cardWidth - 0.2, h: 0.5, fontSize: 11,
              color: tokens.muted, fontFace: font, align: 'center',
            });
          }
        });
      } else if (layout === 'timeline' && slide.timeline?.length) {
        const items = slide.timeline;
        const step = 8.8 / items.length;
        // 贯穿的横线 + 每项一个圆点，构成时间轴。
        page.addShape('line', { x: 0.7, y: 2.0, w: 8.6, h: 0, line: { color: tokens.accent, width: 2 } });
        items.forEach((item, itemIndex) => {
          const x = 0.6 + itemIndex * step;
          page.addShape('ellipse', { x: x + step / 2 - 0.08, y: 1.92, w: 0.16, h: 0.16, fill: { color: tokens.accent } });
          page.addText(item.label, {
            x, y: 1.4, w: step - 0.1, h: 0.4, fontSize: 13, bold: true,
            color: tokens.heading, fontFace: font, align: 'center',
          });
          page.addText(item.text, {
            x, y: 2.3, w: step - 0.1, h: 1.6, fontSize: 12,
            color: tokens.body, fontFace: font, align: 'center', valign: 'top',
          });
        });
      } else if (layout === 'chart' && slide.chart) {
        const { labels, values, caption } = slide.chart;
        const max = Math.max(...values.map((value) => Math.abs(value)), 1);
        const step = 8.8 / labels.length;
        const barWidth = Math.min(step * 0.6, 1.1);
        const baseY = 4.3;
        const maxHeight = 2.5;
        page.addShape('line', { x: 0.6, y: baseY, w: 8.8, h: 0, line: { color: 'D8DEE6', width: 1 } });
        values.forEach((value, valueIndex) => {
          const height = Math.max((Math.abs(value) / max) * maxHeight, 0.05);
          const x = 0.6 + valueIndex * step + (step - barWidth) / 2;
          page.addShape('rect', { x, y: baseY - height, w: barWidth, h: height, fill: { color: tokens.accent } });
          page.addText(String(value), {
            x: x - 0.1, y: baseY - height - 0.35, w: barWidth + 0.2, h: 0.3,
            fontSize: 11, color: tokens.heading, fontFace: font, align: 'center',
          });
          page.addText(labels[valueIndex], {
            x: 0.6 + valueIndex * step, y: baseY + 0.1, w: step - 0.05, h: 0.5,
            fontSize: 11, color: tokens.muted, fontFace: font, align: 'center',
          });
        });
        if (caption) {
          page.addText(caption, { x: 0.6, y: 1.25, w: 8.8, h: 0.35, fontSize: 12, color: tokens.muted, fontFace: font });
        }
      } else if (slide.bullets.length) {
        page.addText(bulletText(slide.bullets), {
          x: 0.6, y: 1.4, w: 8.8, h: 3.6, fontSize: 16, color: tokens.body, fontFace: font,
          paraSpaceAfter: 10, valign: 'top',
        });
      }
    }
    // 页脚：左侧品牌文案，右侧页码。深底页用浅色以免看不见。
    page.addText(footer, {
      x: 0.6, y: 5.15, w: 6.0, h: 0.35, fontSize: 9,
      color: dark ? tokens.onCover : tokens.muted, fontFace: font,
    });
    page.addText(`${index + 1} / ${deck.slides.length}`, {
      x: 8.9, y: 5.15, w: 0.8, h: 0.35, fontSize: 10,
      color: dark ? tokens.onCover : tokens.muted, align: 'right', fontFace: font,
    });
  });

  const output = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}