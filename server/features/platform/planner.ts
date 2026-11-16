import { chatWithTools, type PlatformMessage } from '../../ai/provider.ts';
import { config } from '../../shared/config.ts';

/**
 * 规划-执行-反思的「规划」与「反思」两端。
 *
 * 边界：本模块只做纯函数与模型调用，不碰数据库、不执行工具——
 * 执行与留痕仍在 `engine.ts`，模型请求仍只经 `ai/provider.ts`（architecture 约束 5）。
 *
 * 两条刻意的设计：
 * 1. **无密钥时走确定性规则**，不发请求也不报错，离线开箱即用不受影响；
 * 2. **规划失败即降级**（回退单步计划），不因为「想不出计划」而让整个任务失败。
 */

export interface PlanStep {
  id: string;
  /** 这一步要达成什么，一句话，给模型自己看也给用户看。 */
  goal: string;
  /** 首选工具名；空字符串表示这一步靠推理完成，不调工具。 */
  tool: string;
  status: 'pending' | 'done' | 'failed';
  /** 工具输出摘要，供后续步骤与反思引用。 */
  result: string;
}

export interface AgentPlan {
  goal: string;
  steps: PlanStep[];
  /** live = 模型规划；rules = 离线确定性规划；fallback = 模型规划失败后的兜底。 */
  origin: 'live' | 'rules' | 'fallback';
  /** 反思后重排的次数，用于防止无限重规划。 */
  revisions: number;
}

export interface Reflection {
  /** complete = 已达成目标；continue = 按原计划继续；replan = 需要补充步骤。 */
  verdict: 'complete' | 'continue' | 'replan';
  reason: string;
  /** verdict 为 replan 时给出的追加步骤。 */
  nextSteps: PlanStep[];
}

export interface ToolOutcome { tool: string; output: string }

/** 工具失败的统一前缀，见 tools.ts 的 executeTool。 */
const FAILURE_PREFIXES = ['工具执行失败：', '未找到工具：'];

export function isFailure(output: string): boolean {
  const text = output.trim();
  return FAILURE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** 把模型或规则给出的原始条目收敛成合法步骤：去空、去非法工具、限量。 */
export function sanitizeSteps(
  raw: Array<{ goal?: unknown; tool?: unknown }>,
  allowed: Set<string>,
  limit: number,
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const item of raw) {
    if (steps.length >= limit) break;
    const goal = typeof item.goal === 'string' ? item.goal.trim().slice(0, 200) : '';
    if (!goal) continue;
    const name = typeof item.tool === 'string' ? item.tool.trim().replace(/\./g, '_') : '';
    // 白名单外的工具直接留空：这一步退化为纯推理，而不是让模型绕过白名单。
    const tool = name && allowed.has(name) ? name : '';
    steps.push({ id: `s${steps.length + 1}`, goal, tool, status: 'pending', result: '' });
  }
  return steps;
}

/** 从模型回复里抠出 JSON 对象：容忍 ```json 包裹与前后解释文字。 */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readSteps(value: unknown): Array<{ goal?: unknown; tool?: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({ goal: item.goal ?? item.title ?? item.description, tool: item.tool ?? item.tool_name }));
}

/**
 * 离线规则规划：按关键词把任务拆成「检索材料 → 生成内容 → 落盘」三段。
 * 与 pickOfflineTools 的口径一致，但多了一步落盘，使离线也能完成多步任务。
 */
export function rulePlan(message: string, allowed: Set<string>, limit: number): PlanStep[] {
  const rules: Array<[RegExp, string, string]> = [
    [/周报|文档|写作|大纲|润色|方案|报告|纪要|起草/, 'document_draft', '起草正文'],
    [/数据|csv|表格|统计|分析|趋势|图表|指标/, 'analytics_insights', '分析数据并给出洞察'],
    [/论文|文献|综述|引用|参考|bib|doi/i, 'paper_review', '梳理文献要点'],
    [/实验|研究|假设|课题|科研|计划/, 'research_plan', '拟定研究计划'],
    [/邮件|回复|收件|发信|邮箱|smtp|imap/i, 'mail_reply', '起草邮件回复'],
  ];
  const matched = rules.find(([pattern]) => pattern.test(message));
  const raw: Array<{ goal: string; tool: string }> = [
    { goal: '检索本机知识库中与任务相关的材料', tool: 'rag_search' },
    { goal: matched?.[2] ?? '基于已有材料整理回答', tool: matched?.[1] ?? 'agent_chat' },
  ];
  // 只有生成类任务才追加落盘；纯问答不产出文档，避免污染文档库。
  if (matched) raw.push({ goal: '把成果保存为文档，便于后续查阅', tool: 'document_save' });
  return sanitizeSteps(raw, allowed, limit);
}

function planPrompt(message: string, toolLines: string, limit: number): string {
  return [
    '你是任务规划器。把用户任务拆成可执行步骤，只输出 JSON，不要解释、不要代码块以外的文字。',
    `格式：{"goal":"总目标","steps":[{"goal":"这一步要达成什么","tool":"工具名或留空"}]}`,
    `最多 ${limit} 步；能一步做完就只给一步，不要为凑步数而拆分。`,
    'tool 只能从下列工具中选，纯推理步骤留空字符串：',
    toolLines || '（无可用工具，全部留空）',
    '涉及外部副作用的步骤（发信、执行自动化、浏览器操作）必须放在最后，并在 goal 里写明副作用。',
    `用户任务：${message}`,
  ].join('\n');
}

/**
 * 生成计划。live 模式下向模型要 JSON；任何异常（未配密钥、超时、JSON 不合法、步骤全空）
 * 都退回规则计划，并把 origin 标成 fallback，便于在运行记录里看出降级。
 */
export async function buildPlan(options: {
  message: string;
  tools: Array<{ name: string; description: string }>;
  limit: number;
  live: boolean;
  systemHint?: string;
}): Promise<{ plan: AgentPlan; usageChars: number }> {
  const allowed = new Set(options.tools.map((tool) => tool.name));
  const fallback = (): AgentPlan => ({
    goal: options.message.slice(0, 200),
    steps: rulePlan(options.message, allowed, options.limit),
    origin: 'rules',
    revisions: 0,
  });
  if (!options.live || !config.agent.plannerEnabled) return { plan: fallback(), usageChars: 0 };

  const toolLines = options.tools.map((tool) => `- ${tool.name}：${tool.description.slice(0, 80)}`).join('\n');
  const messages: PlatformMessage[] = [
    { role: 'system', content: options.systemHint || '你是严谨的任务规划器，使用简体中文。' },
    { role: 'user', content: planPrompt(options.message, toolLines, options.limit) },
  ];
  try {
    const response = await chatWithTools(messages, []);
    const parsed = extractJson(response.content);
    const steps = sanitizeSteps(readSteps(parsed?.steps), allowed, options.limit);
    if (!steps.length) return { plan: { ...fallback(), origin: 'fallback' }, usageChars: response.usageChars };
    const goal = typeof parsed?.goal === 'string' && parsed.goal.trim()
      ? parsed.goal.trim().slice(0, 200)
      : options.message.slice(0, 200);
    return { plan: { goal, steps, origin: 'live', revisions: 0 }, usageChars: response.usageChars };
  } catch {
    return { plan: { ...fallback(), origin: 'fallback' }, usageChars: 0 };
  }
}

/** 把计划渲染成注入 system 的文本，让执行阶段的模型知道自己在第几步。 */
export function renderPlan(plan: AgentPlan, cursor: number): string {
  if (!plan.steps.length) return '';
  const lines = plan.steps.map((step, index) => {
    const mark = step.status === 'done' ? '已完成' : step.status === 'failed' ? '失败' : index === cursor ? '进行中' : '待执行';
    const tool = step.tool ? `（工具 ${step.tool}）` : '（推理）';
    const result = step.result ? ` → ${step.result.slice(0, 160)}` : '';
    return `${index + 1}. [${mark}] ${step.goal}${tool}${result}`;
  });
  return `\n执行计划（总目标：${plan.goal}）：\n${lines.join('\n')}\n当前应推进第 ${Math.min(cursor + 1, plan.steps.length)} 步；完成后如实说明结果，不要跳步或重复已完成的步骤。`;
}

/**
 * 确定性反思：不花模型钱，先看硬信号——
 * 有失败步骤、或还有工具步骤没执行完，就一律不算完成。
 */
export function ruleReflect(plan: AgentPlan, outcomes: ToolOutcome[]): Reflection {
  const failed = outcomes.filter((item) => isFailure(item.output));
  if (failed.length) {
    return {
      verdict: 'replan',
      reason: `有 ${failed.length} 个步骤失败：${failed.map((item) => item.tool).join('、')}`,
      nextSteps: [],
    };
  }
  const pending = plan.steps.filter((step) => step.status === 'pending' && step.tool);
  if (pending.length) {
    return { verdict: 'continue', reason: `还有 ${pending.length} 个计划步骤未执行`, nextSteps: [] };
  }
  return { verdict: 'complete', reason: '计划步骤已全部执行且无失败', nextSteps: [] };
}

/**
 * 模型反思：判断目标是否真的达成（工具跑完 ≠ 任务完成）。
 * 失败或 JSON 不合法时退回确定性反思，绝不把「反思挂了」当成「任务完成」。
 */
export async function reflectOnRun(options: {
  plan: AgentPlan;
  outcomes: ToolOutcome[];
  answer: string;
  live: boolean;
  tools: Array<{ name: string; description: string }>;
  remaining: number;
}): Promise<{ reflection: Reflection; usageChars: number }> {
  const baseline = ruleReflect(options.plan, options.outcomes);
  if (!options.live || !config.agent.reflectEnabled) return { reflection: baseline, usageChars: 0 };
  // 硬信号已经判定要继续或重排时，不必再问模型，省钱也更稳。
  if (baseline.verdict !== 'complete') return { reflection: baseline, usageChars: 0 };
  if (options.remaining <= 0) {
    return { reflection: { verdict: 'continue', reason: '步数预算已用尽，先交付现有结果', nextSteps: [] }, usageChars: 0 };
  }

  const allowed = new Set(options.tools.map((tool) => tool.name));
  const messages: PlatformMessage[] = [
    { role: 'system', content: '你是执行结果审查员，只输出 JSON，使用简体中文。判断是否真的达成了用户目标，不要客气。' },
    {
      role: 'user',
      content: [
        `总目标：${options.plan.goal}`,
        `已执行步骤：\n${options.outcomes.map((item, index) => `${index + 1}. ${item.tool} → ${item.output.slice(0, 300)}`).join('\n') || '（无工具步骤）'}`,
        `当前答案草稿：\n${options.answer.slice(0, 1500) || '（空）'}`,
        `还可以追加最多 ${options.remaining} 步。`,
        '输出格式：{"verdict":"complete|continue|replan","reason":"一句话理由","nextSteps":[{"goal":"要做什么","tool":"工具名或留空"}]}',
        '只有目标确实达成才给 complete；材料不足或答案没覆盖目标就给 replan 并列出补充步骤。',
      ].join('\n'),
    },
  ];
  try {
    const response = await chatWithTools(messages, []);
    const parsed = extractJson(response.content);
    const verdict = parsed?.verdict;
    if (verdict !== 'complete' && verdict !== 'continue' && verdict !== 'replan') {
      return { reflection: baseline, usageChars: response.usageChars };
    }
    const reason = typeof parsed?.reason === 'string' ? parsed.reason.trim().slice(0, 300) : '';
    const nextSteps = verdict === 'replan'
      ? sanitizeSteps(readSteps(parsed?.nextSteps), allowed, options.remaining)
      : [];
    // 说要重排却没给出可执行步骤，等于没重排：退回继续，避免空转。
    if (verdict === 'replan' && !nextSteps.length) {
      return { reflection: { verdict: 'continue', reason: reason || '需要补充但未给出可执行步骤', nextSteps: [] }, usageChars: response.usageChars };
    }
    return { reflection: { verdict, reason, nextSteps }, usageChars: response.usageChars };
  } catch {
    return { reflection: baseline, usageChars: 0 };
  }
}