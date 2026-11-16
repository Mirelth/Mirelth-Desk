import { config } from '../shared/config.ts';
import { UpstreamError } from '../shared/errors.ts';
import { logger } from '../shared/logger.ts';
import { offlineGenerate } from './offline.ts';
import { buildMessages, type AiInput, type TaskKind, TASK_LABELS, TASK_PROMPTS } from './prompts.ts';

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

/**
 * 语义嵌入的唯一出口（与 chat 一样只在 provider 发模型请求）。
 * 未配置密钥或嵌入模型时返回 null——调用方据此降级到词法向量，绝不抛错阻塞检索。
 */
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!config.llm.embeddingEnabled || !texts.length) return null;
  try {
    const response = await fetch(`${config.llm.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({ model: config.llm.embeddingModel, input: texts.map((text) => text.slice(0, 8000)) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      logger.warn('ai.embed_upstream_failed', { status: response.status });
      return null;
    }
    const payload = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const items = payload.data ?? [];
    if (!items.length) return null;
    const vectors: number[][] = [];
    for (const item of [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
      if (!Array.isArray(item.embedding) || !item.embedding.length) return null;
      vectors.push(item.embedding);
    }
    return vectors.length === texts.length ? vectors : null;
  } catch (error) {
    // 嵌入失败不是致命错误：检索仍可用词法路径。
    logger.warn('ai.embed_failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export function embeddingModelName(): string {
  return config.llm.embeddingEnabled ? config.llm.embeddingModel : '';
}

/**
 * 视觉识别的唯一出口：把图片交给多模态模型转录为 Markdown。
 * 走 OpenAI 兼容的 content 数组 + image_url（data URL）格式，绝大多数兼容网关都支持。
 *
 * 与 embed 不同，这里**未配置模型时直接抛错**而不是静默降级：
 * 图片识别没有可用的离线替代，静默返回空会让用户以为图片里没字。
 */
export async function visionTranscribe(
  images: Array<{ base64: string; mime: string }>,
  hint = '',
): Promise<{ text: string; model: string }> {
  if (!config.llm.enabled) {
    throw new UpstreamError('图片与扫描件识别需要配置多模态模型：请在 .env 设置 LLM_API_KEY 与 LLM_VISION_MODEL', 400);
  }
  if (!images.length) throw new UpstreamError('没有可识别的图片', 400);

  const model = config.llm.visionModel || config.llm.model;
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: `${TASK_PROMPTS['document.vision']}${hint ? `\n\n补充说明：${hint}` : ''}` },
    ...images.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    })),
  ];

  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: BASE_PROMPT_FOR_VISION },
        { role: 'user', content },
      ],
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    // 模型不支持图片时给出可操作的提示，而不是把网关原文丢给用户。
    if (/image|vision|multimodal|content.*type|invalid/i.test(detail) && response.status >= 400 && response.status < 500) {
      throw new UpstreamError(`模型 ${model} 似乎不支持图片输入（${response.status}）。请把 LLM_VISION_MODEL 换成多模态模型，如 gpt-4o、qwen-vl-max、glm-4v`, 502);
    }
    throw new UpstreamError(`视觉识别失败，模型服务返回 ${response.status}：${detail}`, 502);
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = (payload.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new UpstreamError('模型没有返回识别结果，请重试或更换模型', 502);
  logger.info('ai.vision_transcribed', { model, images: images.length, chars: text.length });
  return { text, model };
}

const BASE_PROMPT_FOR_VISION = '你是文档转录助手。只转录图片中真实存在的文字与表格，用简体中文输出 Markdown。不编造、不补写、不解说；辨认不清的地方明确标注。';

export function visionModelName(): string {
  if (!config.llm.enabled) return '';
  return config.llm.visionModel || config.llm.model;
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
      model: config.llm.model, messages, temperature: 0.3, stream: false,
      // 空数组会被 OpenAI 兼容接口拒绝（tools 至少 1 项）；规划与反思是纯文本往返，必须整字段省略。
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
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
