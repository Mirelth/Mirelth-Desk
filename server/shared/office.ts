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

/** 版式：要点页（默认）、分节页、双栏对比、表格页。缺省一律按要点页渲染，向后兼容。 */
export type SlideLayout = 'bullets' | 'section' | 'twoColumn' | 'table';

export interface DeckSlide {
  title: string;
  bullets: string[];
  layout?: SlideLayout;
  /** 表格页的数据；首行作表头。 */
  table?: string[][];
  /** 双栏页的左右两列要点。 */
  columns?: [string[], string[]];
}

export interface SlideDeck { title: string; slides: DeckSlide[]; theme?: DeckTheme }

export type DeckTheme = 'ocean' | 'forest' | 'slate';

interface ThemeTokens { cover: string; accent: string; heading: string; body: string; muted: string }

const THEMES: Record<DeckTheme, ThemeTokens> = {
  ocean: { cover: '1F3A5F', accent: '3B82F6', heading: '1F3A5F', body: '333333', muted: '999999' },
  forest: { cover: '14532D', accent: '22C55E', heading: '14532D', body: '2F3A33', muted: '8A9A90' },
  slate: { cover: '1E293B', accent: '64748B', heading: '1E293B', body: '334155', muted: '94A3B8' },
};

const MAX_BULLETS = 6;
const MAX_BULLET_LEN = 110;

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
    if (trimmed.startsWith('>')) { pushBullet(stripInline(trimmed.slice(1))); continue; }
    pushBullet(stripInline(trimmed));
  }
  flushTable();

  const usable = slides.filter((slide) => slide.bullets.length || slide.table?.length || slide.title !== '未命名页').slice(0, 20);
  if (!usable.length) usable.push({ title, bullets: ['（文档暂无正文内容）'], layout: 'bullets' });
  return { title, slides: usable, theme: 'ocean' };
}

/** 解析模型输出的 JSON 大纲；失败或为空时返回 null，由调用方回退到 Markdown 切分。 */
export function parseDeckJson(text: string): SlideDeck | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { title?: unknown; slides?: unknown };
    if (!Array.isArray(parsed.slides)) return null;
    const layouts: SlideLayout[] = ['bullets', 'section', 'twoColumn', 'table'];
    const slides: DeckSlide[] = parsed.slides
      .filter((item): item is { title: string; bullets?: unknown; layout?: unknown; table?: unknown; columns?: unknown } =>
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
        return {
          title: item.title.slice(0, 60),
          bullets,
          // 声明了表格/双栏但没给数据时退回要点页，避免出空白版式。
          layout: layout === 'table' && !table?.length ? 'bullets'
            : layout === 'twoColumn' && !columns ? 'bullets' : layout,
          table, columns,
        };
      })
      .filter((slide) => slide.title.trim())
      .slice(0, 20);
    if (!slides.length) return null;
    const theme = (['ocean', 'forest', 'slate'] as DeckTheme[]).includes((parsed as { theme?: DeckTheme }).theme as DeckTheme)
      ? (parsed as { theme?: DeckTheme }).theme : 'ocean';
    return { title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.slice(0, 100) : '演示文稿', slides, theme };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 幻灯片大纲 → PPTX

const FONT_FACE = 'Microsoft YaHei';

export async function deckToPptx(deck: SlideDeck): Promise<Buffer> {
  const tokens = THEMES[deck.theme ?? 'ocean'] ?? THEMES.ocean;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Mirelth Desk';
  pptx.title = deck.title;

  const bulletText = (items: string[]): Array<{ text: string; options: Record<string, unknown> }> =>
    items.map((bullet) => ({ text: bullet, options: { bullet: { code: '2022' }, breakLine: true } }));

  const cover = pptx.addSlide();
  cover.background = { color: tokens.cover };
  cover.addText(deck.title, { x: 0.8, y: 2.0, w: 8.4, h: 1.4, fontSize: 36, bold: true, color: 'FFFFFF', fontFace: FONT_FACE });
  cover.addShape('line', { x: 0.82, y: 3.35, w: 2.2, h: 0, line: { color: tokens.accent, width: 3 } });
  cover.addText('Mirelth Desk · AI Office 生成', { x: 0.8, y: 3.6, w: 8.4, h: 0.5, fontSize: 14, color: 'D8E2EF', fontFace: FONT_FACE });

  deck.slides.forEach((slide, index) => {
    const page = pptx.addSlide();
    const layout = slide.layout ?? 'bullets';

    if (layout === 'section') {
      // 分节页：整页底色 + 大标题，用于 H1 层级。
      page.background = { color: tokens.cover };
      page.addText(slide.title, { x: 0.8, y: 2.2, w: 8.4, h: 1.0, fontSize: 30, bold: true, color: 'FFFFFF', fontFace: FONT_FACE });
      page.addShape('line', { x: 0.82, y: 3.3, w: 1.8, h: 0, line: { color: tokens.accent, width: 3 } });
      if (slide.bullets.length) {
        page.addText(slide.bullets[0], { x: 0.8, y: 3.5, w: 8.4, h: 0.6, fontSize: 15, color: 'D8E2EF', fontFace: FONT_FACE });
      }
    } else {
      page.addText(slide.title, { x: 0.6, y: 0.35, w: 8.8, h: 0.7, fontSize: 24, bold: true, color: tokens.heading, fontFace: FONT_FACE });
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
              fill: { color: rowIndex === 0 ? tokens.cover : (rowIndex % 2 ? 'F5F7FA' : 'FFFFFF') },
              fontSize: 12, fontFace: FONT_FACE, valign: 'middle' as const,
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
          page.addShape('rect', { x, y: 1.4, w: 4.3, h: 3.5, fill: { color: 'F5F7FA' }, line: { color: 'E2E8F0', width: 1 } });
          if (column.length) {
            page.addText(bulletText(column), {
              x: x + 0.2, y: 1.6, w: 3.9, h: 3.1, fontSize: 14, color: tokens.body,
              fontFace: FONT_FACE, paraSpaceAfter: 8, valign: 'top',
            });
          }
        });
      } else if (slide.bullets.length) {
        page.addText(bulletText(slide.bullets), {
          x: 0.6, y: 1.4, w: 8.8, h: 3.6, fontSize: 16, color: tokens.body, fontFace: FONT_FACE,
          paraSpaceAfter: 10, valign: 'top',
        });
      }
    }
    page.addText(`${index + 1} / ${deck.slides.length}`, {
      x: 8.9, y: 5.15, w: 0.8, h: 0.35, fontSize: 10,
      color: layout === 'section' ? 'D8E2EF' : tokens.muted, align: 'right', fontFace: FONT_FACE,
    });
  });

  const output = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}