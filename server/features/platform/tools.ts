import { generate } from '../../ai/provider.ts';
import { TASK_LABELS, type TaskKind } from '../../ai/prompts.ts';
import { documentsService } from '../documents/documents.service.ts';
import { mailService } from '../mail/mail.service.ts';
import { workspaceService } from '../workspace/workspace.service.ts';
import { rows } from './store.ts';
import { search } from './rag.ts';

export interface ToolContext { userId: string; workspaceId: string }
export interface ToolArgs { [key: string]: unknown }

export interface Tool {
  name: string;
  description: string;
  category: 'generate' | 'action' | 'custom';
  parameters: { type: 'object'; properties: Record<string, { type: string; description: string }>; required?: string[] };
  run: (ctx: ToolContext, args: ToolArgs) => Promise<string>;
}

const TASK_KINDS: TaskKind[] = [
  'document.outline', 'document.draft', 'document.polish', 'document.continue', 'document.summarize',
  'analytics.insights', 'analytics.report', 'paper.summary', 'paper.review', 'paper.synthesize',
  'research.design', 'research.interpret', 'research.plan', 'mail.reply', 'mail.summary', 'mail.compose',
  'agent.chat',
];

const COMMON_PROPERTIES = {
  title: { type: 'string', description: '文档或任务标题' },
  content: { type: 'string', description: '原文或正文内容' },
  message: { type: 'string', description: '问题描述或邮件正文' },
  subject: { type: 'string', description: '邮件主题' },
  query: { type: 'string', description: '检索或分析问题' },
  points: { type: 'string', description: '需要覆盖的要点，逗号分隔' },
};

function asInput(args: ToolArgs): Record<string, unknown> {
  const input: Record<string, unknown> = { ...args };
  if (typeof args.input === 'string') input.message = args.input;
  if (typeof args.points === 'string') input.points = args.points.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  delete input.input;
  return input;
}

const generateTools: Tool[] = TASK_KINDS.map((kind) => ({
  name: kind.replace('.', '_'),
  description: `生成${TASK_LABELS[kind]}：${kind}。基于提供的材料输出结构化中文 Markdown。`,
  category: 'generate',
  parameters: { type: 'object', properties: COMMON_PROPERTIES },
  run: async (_ctx, args) => (await generate(kind, asInput(args))).text,
}));

const actionTools: Tool[] = [
  {
    name: 'rag_search', description: '检索本机知识库（文档、文献、数据集、邮件、实验记录），返回相关片段',
    category: 'action',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '检索词' } }, required: ['query'] },
    run: async (ctx, args) => {
      const hits = search(ctx.workspaceId, String(args.query ?? ''), 4);
      return hits.length ? hits.map((hit, index) => `[${index + 1}] ${hit.title}\n${hit.content.slice(0, 400)}`).join('\n\n') : '知识库中没有相关材料。';
    },
  },
  {
    name: 'document_save', description: '把生成的文本保存为新文档',
    category: 'action',
    parameters: { type: 'object', properties: { title: { type: 'string', description: '文档标题' }, content: { type: 'string', description: 'Markdown 正文' } }, required: ['title', 'content'] },
    run: async (ctx, args) => {
      const doc = documentsService.create(ctx.userId, { title: String(args.title ?? '智能体文档'), content: String(args.content ?? '') });
      return `已保存文档「${doc.title}」（${doc.id}）`;
    },
  },
  {
    name: 'mail_sync', description: '同步 IMAP 收件箱（未配置账户时返回演示提示）',
    category: 'action',
    parameters: { type: 'object', properties: {} },
    run: async (ctx) => {
      const result = await mailService.sync(ctx.userId);
      return result.note ?? `同步完成，新增 ${result.synced} 封邮件`;
    },
  },
  {
    name: 'mail_latest', description: '列出最近收件箱邮件主题，用于了解待处理事项',
    category: 'action',
    parameters: { type: 'object', properties: {} },
    run: async (ctx) => {
      const list = mailService.list(ctx.userId, { folder: 'inbox', limit: 5 });
      return list.length ? list.map((item) => `- ${item.isRead ? '已读' : '未读'}｜${item.subject}`).join('\n') : '收件箱为空。';
    },
  },
  {
    name: 'automation_run', description: '按 ID 立即执行一个自动化任务',
    category: 'action',
    parameters: { type: 'object', properties: { taskId: { type: 'string', description: '任务 ID' } }, required: ['taskId'] },
    run: async (ctx, args) => {
      const result = await workspaceService.runTask(ctx.userId, String(args.taskId ?? ''));
      return result.ok ? result.text.slice(0, 800) : `执行失败：${result.error ?? ''}`;
    },
  },
  {
    name: 'file_list', description: '列出工作区文件库中的附件',
    category: 'action',
    parameters: { type: 'object', properties: {} },
    run: async (ctx) => {
      const files = rows<{ filename: string; size: number }>('files', 'workspace_id = ?', [ctx.workspaceId], 'created_at DESC', 20);
      return files.length ? files.map((file) => `- ${file.filename}（${file.size} 字节）`).join('\n') : '文件库为空。';
    },
  },
];

const customTools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error('工具名只允许字母、数字、下划线与连字符');
  customTools.set(tool.name, tool);
}

export function allTools(): Tool[] {
  return [...generateTools, ...actionTools, ...customTools.values()];
}

export function getTool(name: string): Tool | undefined {
  return allTools().find((tool) => tool.name === name || tool.name === name.replace('.', '_'));
}

export function toolManifest(): Array<{ name: string; description: string; category: string; parameters: Tool['parameters'] }> {
  return allTools().map(({ name, description, category, parameters }) => ({ name, description, category, parameters }));
}

export function modelToolSchemas(names?: string[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Tool['parameters'] } }> {
  const allowed = names?.length ? new Set(names.map((name) => name.replace('.', '_'))) : null;
  return allTools()
    .filter((tool) => !allowed || allowed.has(tool.name))
    .map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

export async function executeTool(name: string, ctx: ToolContext, args: ToolArgs): Promise<string> {
  const tool = getTool(name);
  if (!tool) return `未找到工具：${name}`;
  try { return await tool.run(ctx, args ?? {}); }
  catch (error) { return `工具执行失败：${error instanceof Error ? error.message : String(error)}`; }
}
