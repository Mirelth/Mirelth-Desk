import type { TaskKind } from '../../ai/prompts.ts';
import { generate } from '../../ai/provider.ts';
import { newId, now } from '../../shared/crypto.ts';
import { NotFoundError } from '../../shared/errors.ts';
import { exportHtml } from '../../shared/markdown.ts';
import { activityService } from '../activity/activity.service.ts';
import { documentsRepository, type DocumentRow } from './documents.repository.ts';

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
  list(userId: string, search?: string) {
    return documentsRepository.list(userId, search).map(toDto);
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
    return this.get(userId, id);
  },

  remove(userId: string, id: string): void {
    this.get(userId, id);
    documentsRepository.remove(userId, id);
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

  export(userId: string, id: string, format: 'md' | 'html') {
    const doc = this.get(userId, id);
    const safeName = doc.title.replace(/[\\/:*?"<>|]/g, '_');
    return format === 'html'
      ? { filename: `${safeName}.html`, content: exportHtml(doc.title, doc.content), mime: 'text/html' }
      : { filename: `${safeName}.md`, content: doc.content, mime: 'text/markdown' };
  },
};
