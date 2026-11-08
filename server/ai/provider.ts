import { config } from '../shared/config.ts';
import { UpstreamError } from '../shared/errors.ts';
import { logger } from '../shared/logger.ts';
import { offlineGenerate } from './offline.ts';
import { buildMessages, type AiInput, type TaskKind, TASK_LABELS } from './prompts.ts';

export type AiMode = 'live' | 'offline';

export interface AiStatus {
  mode: AiMode;
  model: string;
  baseUrl: string;
  label: string;
}

export function aiStatus(): AiStatus {
  return config.llm.enabled
    ? { mode: 'live', model: config.llm.model, baseUrl: config.llm.baseUrl, label: config.llm.model }
    : { mode: 'offline', model: 'offline-rules', baseUrl: '', label: '离线规则引擎' };
}

async function* liveStream(kind: TaskKind, input: AiInput): AsyncGenerator<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({ model: config.llm.model, stream: true, temperature: 0.5, messages: buildMessages(kind, input) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new UpstreamError(`模型服务返回 ${response.status}：${detail}`);
    }
    if (!response.body) throw new UpstreamError('模型服务未返回响应体');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
            };
            const chunk = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
            if (chunk) yield chunk;
          } catch {
            logger.warn('ai.stream_frame_invalid', { task: kind });
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger.error('ai.upstream_failed', { task: kind, error: message });
    throw new UpstreamError(`调用模型服务失败：${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function* offlineStream(kind: TaskKind, input: AiInput): AsyncGenerator<string> {
  const content = offlineGenerate(kind, input);
  const chunks = content.match(/[\s\S]{1,24}/g) ?? [content];
  for (const chunk of chunks) {
    yield chunk;
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
}

export function streamTask(kind: TaskKind, input: AiInput): AsyncGenerator<string> {
  return config.llm.enabled ? liveStream(kind, input) : offlineStream(kind, input);
}

export async function generate(kind: TaskKind, input: AiInput): Promise<{ text: string; mode: AiMode }> {
  let text = '';
  for await (const chunk of streamTask(kind, input)) text += chunk;
  logger.info('ai.generate', { task: TASK_LABELS[kind], mode: aiStatus().mode, chars: text.length });
  return { text, mode: aiStatus().mode };
}

export interface PlatformMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown[];
}

export interface ModelToolCall { id: string; name: string; arguments: Record<string, unknown> }

export async function chatWithTools(
  messages: PlatformMessage[],
  tools: unknown[],
): Promise<{ content: string; toolCalls: ModelToolCall[]; usageChars: number }> {
  if (!config.llm.enabled) throw new UpstreamError('未配置 LLM_API_KEY，无法使用模型工具调用');
  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify({
      model: config.llm.model, messages, tools, tool_choice: 'auto', temperature: 0.3, stream: false,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new UpstreamError(`模型服务返回 ${response.status}：${detail}`);
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string; tool_calls?: Array<{
      id?: string; function?: { name?: string; arguments?: string };
    }> } }>;
  };
  const message = payload.choices?.[0]?.message;
  const toolCalls: ModelToolCall[] = (message?.tool_calls ?? []).map((call, index) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>; } catch { /* 保留空参数 */ }
    return { id: call.id ?? `call_${index}`, name: call.function?.name ?? '', arguments: args };
  }).filter((call) => Boolean(call.name));
  const content = message?.content ?? '';
  return { content, toolCalls, usageChars: JSON.stringify(messages).length + content.length };
}
