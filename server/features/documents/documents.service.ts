import type { TaskKind } from '../../ai/prompts.ts';
import { generate } from '../../ai/provider.ts';
import { newId, now } from '../../shared/crypto.ts';
import { BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { exportHtml } from '../../shared/markdown.ts';
import {
  OFFICE_MIME, decodeBase64File, deckToPptx, docxToMarkdown, markdownToDeck, markdownToDocx, parseDeckJson,
} from '../../shared/office.ts';
import { pdfToMarkdown } from '../../shared/pdf.ts';
import { recognizeImage } from '../../shared/ocr.ts';
import { activityService } from '../activity/activity.service.ts';
import { indexChunk, removeSource } from '../platform/rag.ts';
import { defaultWorkspace } from '../platform/store.ts';
import { documentsRepository, type DocumentRow } from './documents.repository.ts';

/** 增量索引：文档改动后立即刷新自己的检索块，不必等用户手动重建。失败不影响主流程。 */
function reindexDoc(userId: string, id: string, title: string, content: string): void {
  try {
    indexChunk(defaultWorkspace(userId).id, 'document', id, title, content);
  } catch { /* 索引失败不应让写入失败 */ }
}

export interface DocumentTemplate {
  id: string;
  name: string;
  kind: string;
  description: string;
  sections: string[];
}

export const DOCUMENT_TEMPLATES: DocumentTemplate[] = [
  { id: 'weekly', name: '工作周报', kind: 'weekly', description: '本周完成 / 关键数据 / 风险 / 下周计划', sections: ['本周完成', '关键数据', '问题与风险', '下周计划'] },
  { id: 'proposal', name: '项目方案', kind: 'proposal', description: '背景 / 目标 / 方案 / 里程碑', sections: ['背景', '目标', '方案', '里程碑', '风险'] },
  { id: 'minutes', name: '会议纪要', kind: 'minutes', description: '结论 / 讨论要点 / 待办与责任人', sections: ['会议信息', '讨论要点', '结论', '待办'] },
  { id: 'report', name: '分析报告', kind: 'report', description: '结论先行，数据与建议分层呈现', sections: ['一句话结论', '数据概览', '主要发现', '建议', '局限性'] },
  { id: 'email', name: '正式邮件', kind: 'email', description: '称呼 / 背景 / 请求 / 落款', sections: ['称呼', '背景', '主体', '请求', '落款'] },
  { id: 'general', name: '通用文档', kind: 'general', description: '自由写作，不限结构', sections: ['概述', '主体', '结论'] },
];

export type DocumentAiAction = 'outline' | 'draft' | 'polish' | 'continue' | 'summarize';

const ACTION_TASK: Record<DocumentAiAction, TaskKind> = {
  outline: 'document.outline',
  draft: 'document.draft',
  polish: 'document.polish',
  continue: 'document.continue',
  summarize: 'document.summarize',
};

function toDto(row: DocumentRow) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    kind: row.kind,
    template: row.template,
    tags: JSON.parse(row.tags) as string[],
    wordCount: row.word_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    excerpt: row.content.replace(/[#*|>\-\n]/g, ' ').trim().slice(0, 120),
  };
}

export const documentsService = {
  page(userId: string, search: string | undefined, page: { limit: number; offset: number }) {
    return {
      items: documentsRepository.list(userId, search, page).map(toDto),
      total: documentsRepository.count(userId, search),
      limit: page.limit,
      offset: page.offset,
    };
  },

  get(userId: string, id: string) {
    const row = documentsRepository.find(userId, id);
    if (!row) throw new NotFoundError('文档', id);
    return toDto(row);
  },

  create(userId: string, input: { title: string; content?: string; kind?: string; template?: string | null; tags?: string[]; status?: string }) {
    const id = newId('doc');
    documentsRepository.create({
      id, userId,
      title: input.title,
      content: input.content ?? '',
      kind: input.kind ?? 'general',
      template: input.template ?? null,
      tags: input.tags ?? [],
      status: input.status ?? 'draft',
      createdAt: now(),
    });
    activityService.record(userId, 'document', 'create', `创建文档「${input.title}」`);
    reindexDoc(userId, id, input.title, input.content ?? '');
    return this.get(userId, id);
  },

  update(userId: string, id: string, input: { title?: string; content?: string; kind?: string; tags?: string[]; status?: string }) {
    this.get(userId, id);
    documentsRepository.update(userId, id, {
      title: input.title,
      content: input.content,
      kind: input.kind,
      tags: input.tags === undefined ? undefined : JSON.stringify(input.tags),
      status: input.status,
    });
    activityService.record(userId, 'document', 'update', `更新文档「${input.title ?? id}」`);
    const updated = this.get(userId, id);
    reindexDoc(userId, id, updated.title, updated.content);
    return updated;
  },

  remove(userId: string, id: string): void {
    this.get(userId, id);
    documentsRepository.remove(userId, id);
    try { removeSource(defaultWorkspace(userId).id, 'document', id); } catch { /* 索引清理失败不影响删除 */ }
    activityService.record(userId, 'document', 'delete', `删除文档 ${id}`);
  },

  async ai(userId: string, id: string, action: DocumentAiAction, points: string[] = []) {
    const doc = this.get(userId, id);
    const template = DOCUMENT_TEMPLATES.find((item) => item.id === doc.template);
    const input = {
      title: doc.title,
      template: template?.name ?? doc.kind,
      sections: template?.sections ?? [],
      content: doc.content,
      points,
    };
    const result = await generate(ACTION_TASK[action], input);
    activityService.record(userId, 'agent', 'document_ai', `对「${doc.title}」执行 ${action}`);
    return { ...result, action };
  },

  async export(userId: string, id: string, format: 'md' | 'html' | 'docx') {
    const doc = this.get(userId, id);
    const safeName = doc.title.replace(/[\\/:*?"<>|]/g, '_');
    if (format === 'docx') {
      activityService.record(userId, 'document', 'export', `导出 Word「${doc.title}」`);
      return { filename: `${safeName}.docx`, content: await markdownToDocx(doc.title, doc.content), mime: OFFICE_MIME.docx };
    }
    return format === 'html'
      ? { filename: `${safeName}.html`, content: exportHtml(doc.title, doc.content), mime: 'text/html' }
      : { filename: `${safeName}.md`, content: doc.content, mime: 'text/markdown' };
  },

  /** 统一导入入口：按扩展名分派 Word / PDF / 图片（OCR）。 */
  async importFile(userId: string, input: { filename: string; contentBase64: string }) {
    if (/\.docx$/i.test(input.filename)) return this.importDocx(userId, input);
    if (/\.pdf$/i.test(input.filename)) return this.importPdf(userId, input);
    if (/\.(png|jpe?g|bmp|webp|gif)$/i.test(input.filename)) return this.importImage(userId, input);
    throw new BadRequestError('支持 .docx / .pdf / 图片（png、jpg、bmp、webp）；旧版 .doc 请先另存为 .docx');
  },

  async importDocx(userId: string, input: { filename: string; contentBase64: string }) {
    if (!/\.docx$/i.test(input.filename)) throw new BadRequestError('仅支持 .docx 文件（旧版 .doc 请先另存为 .docx）');
    const buffer = decodeBase64File(input.contentBase64, 'Word 文件');
    const { markdown } = await docxToMarkdown(buffer);
    if (markdown.length > 200_000) throw new BadRequestError('导入内容超过 20 万字符上限，请拆分文档');
    const title = input.filename.replace(/\.docx$/i, '').slice(0, 200) || '导入的文档';
    return this.create(userId, { title, content: markdown, kind: 'general' });
  },

  async importPdf(userId: string, input: { filename: string; contentBase64: string }) {
    const buffer = decodeBase64File(input.contentBase64, 'PDF 文件');
    const { markdown, pages, needsOcr } = await pdfToMarkdown(buffer);
    const title = input.filename.replace(/\.pdf$/i, '').slice(0, 200) || '导入的 PDF';
    if (needsOcr) {
      throw new BadRequestError(
        `该 PDF（${pages} 页）没有可提取的文本层，可能是扫描件。请先转成图片再用图片导入走 OCR 识别`,
      );
    }
    if (markdown.length > 200_000) throw new BadRequestError('导入内容超过 20 万字符上限，请拆分文档');
    const doc = this.create(userId, { title, content: markdown, kind: 'general' });
    return { ...doc, pages };
  },

  /** 图片 → OCR → 文档。识别结果标注来源与置信度，遵守「不编造」原则。 */
  async importImage(userId: string, input: { filename: string; contentBase64: string }) {
    // 语言包缺失时由 ocr 层自动下载并缓存（OCR_AUTO_DOWNLOAD=false 时才报错）。
    const buffer = decodeBase64File(input.contentBase64, '图片文件');
    const { text, confidence } = await recognizeImage(buffer);
    if (!text) throw new BadRequestError('没有识别到文字，请确认图片清晰且包含文本');
    const title = input.filename.replace(/\.[^.]+$/, '').slice(0, 200) || '识别的图片';
    const content = [
      `# ${title}`, '',
      `> 来源：OCR 识别（${input.filename}）｜置信度 ${confidence}%｜机器识别结果，请人工核对后再引用。`, '',
      text,
    ].join('\n');
    return this.create(userId, { title, content, kind: 'general' });
  },

  /** AI Office：文档 → 演示文稿。模型输出 JSON 大纲，解析失败或离线时按文档标题结构切分兜底。 */
  async slides(userId: string, id: string) {
    const doc = this.get(userId, id);
    const result = await generate('document.slides', { title: doc.title, content: doc.content });
    const deck = parseDeckJson(result.text) ?? markdownToDeck(doc.title, doc.content);
    const buffer = await deckToPptx(deck);
    activityService.record(userId, 'agent', 'document_slides', `为「${doc.title}」生成演示文稿（${deck.slides.length} 页）`);
    const safeName = doc.title.replace(/[\\/:*?"<>|]/g, '_');
    return { filename: `${safeName}.pptx`, content: buffer, mime: OFFICE_MIME.pptx, slides: deck.slides.length, mode: result.mode };
  },
};
