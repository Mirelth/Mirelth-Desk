import { aiStatus, chatWithTools, type PlatformMessage } from '../../ai/provider.ts';
import { generate } from '../../ai/provider.ts';
import { now } from '../../shared/crypto.ts';
import { AppError } from '../../shared/errors.ts';
import { logger } from '../../shared/logger.ts';
import { contextFor } from './rag.ts';
import { audit, count, insertRow, row, rows, updateRows, defaultWorkspace } from './store.ts';
import { executeTool, getTool, modelToolSchemas } from './tools.ts';

export interface RunInput {
  userId: string;
  workspaceId?: string;
  conversationId?: string;
  agentId?: string;
  message: string;
}

export type EngineEvent =
  | { type: 'meta'; runId: string; conversationId: string; mode: string; agent: string }
  | { type: 'step'; index: number; tool: string; status: 'start' | 'done'; output?: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; runId: string; conversationId: string; steps: number }
  | { type: 'error'; detail: string };

interface AgentDefinition {
  id: string; name: string; system_prompt: string; tool_whitelist: string;
  model: string; max_steps: number;
}

const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT ?? '200');

function checkQuota(userId: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const used = count('model_usage', 'user_id = ? AND created_at LIKE ?', [userId, `${today}%`]);
  if (used >= DAILY_LIMIT) throw new AppError(`今日模型调用已达上限（${DAILY_LIMIT} 次）`, 'QUOTA_EXCEEDED', 429);
}

function pickOfflineTools(message: string, whitelist: string[]): string[] {
  const rules: Array<[RegExp, string]> = [
    [/周报|文档|写作|大纲|润色|方案|报告|纪要|起草/, 'document_draft'],
    [/数据|csv|表格|统计|分析|趋势|图表|指标/, 'analytics_insights'],
    [/论文|文献|综述|引用|参考|bib|doi/i, 'paper_review'],
    [/实验|研究|假设|课题|科研|计划/, 'research_plan'],
    [/邮件|回复|收件|发信|邮箱|smtp|imap/i, 'mail_reply'],
  ];
  const matched = rules.find(([pattern]) => pattern.test(message))?.[1] ?? 'agent_chat';
  const chosen = ['rag_search', matched];
  return whitelist.length ? chosen.filter((name) => whitelist.includes(name) || whitelist.includes(name.replace('_', '.'))) : chosen;
}

function chunkText(text: string): string[] {
  return text.match(/[\s\S]{1,24}/g) ?? [text];
}

export async function* runAgent(input: RunInput): AsyncGenerator<EngineEvent> {
  const workspace = input.workspaceId ?? defaultWorkspace(input.userId).id;
  checkQuota(input.userId);
  const agent: AgentDefinition | undefined = input.agentId
    ? row<AgentDefinition>('agent_definitions', 'id = ? AND workspace_id = ?', [input.agentId, workspace])
    : undefined;
  const whitelist: string[] = agent ? JSON.parse(agent.tool_whitelist) as string[] : [];
  const maxSteps = Math.min(Math.max(agent?.max_steps ?? 4, 1), 8);

  const conversationId = input.conversationId
    ?? row<{ id: string }>('conversations', 'id = ? AND workspace_id = ?', [input.conversationId ?? '', workspace])?.id
    ?? insertRow('conversations', {
      workspace_id: workspace, user_id: input.userId,
      title: input.message.slice(0, 40) || '新会话', updated_at: now(),
    });
  insertRow('conversation_messages', { conversation_id: conversationId, role: 'user', content: input.message });
  if (/记住|以后|偏好/.test(input.message)) {
    insertRow('memories', { workspace_id: workspace, user_id: input.userId, kind: 'preference', content: input.message });
  }

  const history = rows<{ role: string; content: string }>(
    'conversation_messages', 'conversation_id = ?', [conversationId], 'created_at DESC, rowid DESC', 10,
  ).reverse();
  const memories = rows<{ content: string }>('memories', 'workspace_id = ? AND user_id = ?', [workspace, input.userId], 'created_at DESC', 5);
  const rag = contextFor(workspace, input.message);

  const runId = insertRow('agent_runs', {
    workspace_id: workspace, conversation_id: conversationId, agent_id: agent?.id ?? null,
    user_id: input.userId, status: 'running', input: input.message, output: '', steps_count: 0,
    tokens_estimate: 0, duration_ms: 0,
  });
  const started = Date.now();
  const mode = aiStatus().mode;
  const steps: Array<{ tool: string; output: string }> = [];
  let answer = '';
  let promptChars = input.message.length + rag.length;

  yield { type: 'meta', runId, conversationId, mode, agent: agent?.name ?? '默认智能体' };

  const system = [
    agent?.system_prompt || '你是 Mirelth 企业办公智能体，使用简体中文，基于事实与工具结果回答，不编造数据。',
    rag ? `\n${rag}` : '',
    memories.length ? `\n用户长期记忆：\n${memories.map((item) => `- ${item.content}`).join('\n')}` : '',
  ].join('\n');

  try {
    if (mode === 'live') {
      const messages: PlatformMessage[] = [
        { role: 'system', content: system },
        ...history.slice(-8).map((item) => ({ role: item.role as PlatformMessage['role'], content: item.content })),
      ];
      const schemas = modelToolSchemas(whitelist);
      for (let round = 0; round < maxSteps; round += 1) {
        const response = await chatWithTools(messages, schemas);
        promptChars += response.usageChars;
        if (!response.toolCalls.length) { answer = response.content; break; }
        messages.push({
          role: 'assistant', content: response.content || '',
          tool_calls: response.toolCalls.map((call) => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        });
        for (const call of response.toolCalls) {
          yield { type: 'step', index: steps.length + 1, tool: call.name, status: 'start' };
          const output = await executeTool(call.name, { userId: input.userId, workspaceId: workspace }, call.arguments);
          steps.push({ tool: call.name, output });
          yield { type: 'step', index: steps.length, tool: call.name, status: 'done', output: output.slice(0, 400) };
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: output.slice(0, 3000) });
        }
      }
      if (!answer) answer = await composeFromSteps(input.message, steps);
    } else {
      const chosen = pickOfflineTools(input.message, whitelist);
      for (const name of chosen.slice(0, maxSteps)) {
        const tool = getTool(name);
        if (!tool) continue;
        yield { type: 'step', index: steps.length + 1, tool: name, status: 'start' };
        const args = name === 'rag_search' ? { query: input.message } : { message: input.message, title: input.message.slice(0, 30), content: '' };
        const output = await executeTool(name, { userId: input.userId, workspaceId: workspace }, args);
        steps.push({ tool: name, output });
        yield { type: 'step', index: steps.length, tool: name, status: 'done', output: output.slice(0, 400) };
      }
      answer = await composeFromSteps(input.message, steps);
    }

    for (const piece of chunkText(answer)) {
      yield { type: 'delta', text: piece };
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    insertRow('conversation_messages', { conversation_id: conversationId, role: 'assistant', content: answer });
    updateRows('conversations', { updated_at: now() }, 'id = ?', [conversationId]);
    steps.forEach((step, index) => insertRow('agent_run_steps', {
      run_id: runId, step_index: index + 1, kind: 'tool', tool_name: step.tool,
      input: input.message.slice(0, 500), output: step.output.slice(0, 4000),
    }));
    updateRows('agent_runs', {
      status: 'success', output: answer.slice(0, 8000), steps_count: steps.length,
      tokens_estimate: Math.round((promptChars + answer.length) / 4), duration_ms: Date.now() - started,
    }, 'id = ?', [runId]);
    insertRow('model_usage', {
      workspace_id: workspace, user_id: input.userId, model: mode === 'live' ? aiStatus().model : 'offline-rules',
      prompt_chars: promptChars, completion_chars: answer.length,
      tokens_estimate: Math.round((promptChars + answer.length) / 4),
      duration_ms: Date.now() - started, status: 'success',
    });
    audit(workspace, input.userId, 'agent.run', runId, `${steps.length} 个工具步骤`);
    yield { type: 'done', runId, conversationId, steps: steps.length };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error('platform.run_failed', { run_id: runId, error: detail });
    updateRows('agent_runs', { status: 'failed', output: detail.slice(0, 1000), duration_ms: Date.now() - started }, 'id = ?', [runId]);
    insertRow('model_usage', {
      workspace_id: workspace, user_id: input.userId, model: mode === 'live' ? aiStatus().model : 'offline-rules',
      prompt_chars: promptChars, completion_chars: 0, tokens_estimate: 0,
      duration_ms: Date.now() - started, status: 'failed',
    });
    yield { type: 'error', detail };
  }
}

async function composeFromSteps(message: string, steps: Array<{ tool: string; output: string }>): Promise<string> {
  const generated = steps.filter((step) => step.tool !== 'rag_search');
  const retrieved = steps.find((step) => step.tool === 'rag_search');
  const result = await generate('agent.chat', { message, toolResults: generated.map((step) => step.output.slice(0, 500)) });
  const parts = [
    `## 针对「${message.slice(0, 60)}」的执行结果`, '',
    retrieved && retrieved.output !== '知识库中没有相关材料。' ? `### 检索到的材料\n${retrieved.output.slice(0, 700)}\n` : '',
    ...generated.map((step) => `### ${step.tool}\n${step.output}`),
    '', '### 智能体建议', result.text,
  ].filter(Boolean);
  return parts.join('\n');
}
