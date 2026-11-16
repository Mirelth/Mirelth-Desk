import { generate } from '../../ai/provider.ts';
import { TASK_LABELS, type TaskKind } from '../../ai/prompts.ts';
import { documentsService } from '../documents/documents.service.ts';
import { mailService } from '../mail/mail.service.ts';
import { workspaceService } from '../workspace/workspace.service.ts';
import { rows } from './store.ts';
import { search } from './rag.ts';
import { memoriesService } from './memories.ts';
import { browserService } from '../browser/browser.service.ts';
import { pluginsService } from './plugins.ts';

export interface ToolContext { userId: string; workspaceId: string; conversationId?: string }
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
  {
    name: 'memory_save',
    description: '保存一条值得长期记住的用户偏好、事实或项目背景。只在用户明确表达「记住」或确认了稳定偏好时调用，不要把随口一句话记下来。',
    category: 'action',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的内容，一句话，不超过 200 字' },
        kind: { type: 'string', description: 'preference（偏好）/ fact（事实）/ project（项目背景）' },
      },
      required: ['content'],
    },
    run: async (ctx, args) => {
      const created = memoriesService.save(ctx.workspaceId, ctx.userId, String(args.content ?? ''), String(args.kind ?? 'preference'), 'agent');
      await memoriesService.embedPending(ctx.workspaceId, ctx.userId);
      return created.deduplicated ? `已更新既有记忆：${created.content}` : `已记住：${created.content}`;
    },
  },
  {
    name: 'memory_note',
    description: '记录只在本次会话内有用的临时信息（如用户本轮临时指定的口径、范围、代号）。带过期时间，不会变成长期偏好。稳定的偏好请用 memory_save。',
    category: 'action',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: '临时信息，一句话，不超过 200 字' } },
      required: ['content'],
    },
    run: async (ctx, args) => {
      if (!ctx.conversationId) return '工具执行失败：当前调用没有会话上下文，无法记录会话短期记忆';
      const created = memoriesService.saveWorking(ctx.workspaceId, ctx.userId, ctx.conversationId, String(args.content ?? ''));
      return created.deduplicated ? `已更新本次会话的临时信息：${created.content}` : `已记下（仅本次会话有效）：${created.content}`;
    },
  },
  {
    name: 'memory_search', description: '按相关性检索已保存的长期记忆',
    category: 'action',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '检索词' } }, required: ['query'] },
    run: async (ctx, args) => {
      const hits = await memoriesService.recall(ctx.workspaceId, ctx.userId, String(args.query ?? ''), 5);
      return hits.length ? hits.map((item) => `- ${item}`).join('\n') : '没有相关记忆。';
    },
  },
  {
    name: 'browser_read',
    description: '用本机浏览器读取白名单内网页的正文（需先在设置中启用浏览器自动化并配置域名白名单）',
    category: 'action',
    parameters: { type: 'object', properties: { url: { type: 'string', description: '目标网页地址' } }, required: ['url'] },
    run: async (ctx, args) => {
      const result = await browserService.run(ctx.userId, ctx.workspaceId, { action: 'read', url: String(args.url ?? '') });
      return result.text.slice(0, 4000);
    },
  },
];

/**
 * 内置工具名清单：插件注册时用它挡重名。
 * 单独导出是为了避免 plugins.ts 为了取名字而反向依赖工具执行链。
 */
export function builtinToolNames(): string[] {
  return [...generateTools, ...actionTools].map((tool) => tool.name);
}

/**
 * 工具清单。
 *
 * **workspaceId 是隔离边界**：不传就只返回内置工具。
 * 旧实现把自定义工具放在模块级 Map 里无条件并入，导致 A 工作区注册的工具
 * B 工作区也能调用——那是跨租户泄漏，现已改为按工作区从库加载（见 plugins.ts）。
 */
export async function allTools(workspaceId?: string): Promise<Tool[]> {
  const builtin = [...generateTools, ...actionTools];
  if (!workspaceId) return builtin;
  // 内置优先：即使库里出现同名插件（历史数据或手工改库），也不让它顶掉内置工具。
  const names = new Set(builtin.map((tool) => tool.name));
  const remote = await pluginsService.toolsFor(workspaceId);
  const seen = new Set(names);
  const plugins: Tool[] = [];
  for (const tool of remote) {
    // 同一批内也要去重：两个 MCP 插件可能映射出同名本地工具。
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    plugins.push(tool);
  }
  return [...builtin, ...plugins];
}

/** 只要内置工具时用这个同步版本，避免为拿名字而触发远端握手。 */
export function builtinTools(): Tool[] {
  return [...generateTools, ...actionTools];
}

export async function getTool(name: string, workspaceId?: string): Promise<Tool | undefined> {
  const normalized = name.replace(/\./g, '_');
  return (await allTools(workspaceId)).find((tool) => tool.name === name || tool.name === normalized);
}

export async function toolManifest(workspaceId?: string): Promise<Array<{ name: string; description: string; category: string; parameters: Tool['parameters'] }>> {
  return (await allTools(workspaceId)).map(({ name, description, category, parameters }) => ({ name, description, category, parameters }));
}

export async function modelToolSchemas(names?: string[], workspaceId?: string): Promise<Array<{ type: 'function'; function: { name: string; description: string; parameters: Tool['parameters'] } }>> {
  const allowed = names?.length ? new Set(names.map((name) => name.replace('.', '_'))) : null;
  return (await allTools(workspaceId))
    .filter((tool) => !allowed || allowed.has(tool.name))
    .map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

export async function executeTool(name: string, ctx: ToolContext, args: ToolArgs): Promise<string> {
  const tool = await getTool(name, ctx.workspaceId);
  if (!tool) return `未找到工具：${name}`;
  try { return await tool.run(ctx, args ?? {}); }
  catch (error) { return `工具执行失败：${error instanceof Error ? error.message : String(error)}`; }
}
