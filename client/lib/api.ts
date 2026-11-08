import type { TaskKind } from './types.ts';

const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Array<{ field: string; message: string }> | undefined;

  constructor(status: number, body: Record<string, unknown> | null) {
    super(String(body?.detail ?? `请求失败（${status}）`));
    this.name = 'ApiError';
    this.status = status;
    this.code = String(body?.title ?? 'API_ERROR');
    this.details = body?.errors as Array<{ field: string; message: string }> | undefined;
  }
}

interface ApiOptions { method?: string; body?: unknown; signal?: AbortSignal }

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    throw new ApiError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json() as { data: T };
  return payload.data;
}

export const apiClient = {
  get: <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => api<T>(path, { method: 'DELETE' }),
};

export interface StreamHandlers {
  onMeta?: (meta: { mode: string; model: string; label: string }) => void;
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export async function streamTask(kind: TaskKind, input: Record<string, unknown>, handlers: StreamHandlers, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${BASE}/api/agent/run`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, input }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    throw new ApiError(response.status, body);
  }
  if (!response.body) throw new Error('浏览器不支持流式响应');
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
      const lines = frame.split('\n');
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
      const raw = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
      if (!raw) continue;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      if (event === 'meta') handlers.onMeta?.(payload as unknown as { mode: string; model: string; label: string });
      else if (event === 'delta') handlers.onDelta(String(payload.text ?? ''));
      else if (event === 'done') handlers.onDone?.();
      else if (event === 'error') handlers.onError?.(String(payload.detail ?? '生成失败'));
    }
  }
}

export async function downloadFile(path: string, fallback: string): Promise<void> {
  const response = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null) as Record<string, unknown> | null);
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : plain ?? fallback;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '登录已失效，请重新登录。';
    if (error.status === 403) return '没有权限执行该操作。';
    if (error.status === 404) return '请求的内容不存在。';
    if (error.status === 422 && error.details?.length) return error.details.map((item) => item.message).join('；');
    if (error.status === 429) return '操作过于频繁，请稍后再试。';
    return error.message;
  }
  if (error instanceof TypeError && error.message === 'Failed to fetch') return '无法连接到服务，请确认后端已启动。';
  return error instanceof Error ? error.message : '发生未知错误，请稍后重试。';
}
