import { AsyncLocalStorage } from 'node:async_hooks';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Meta = Record<string, unknown>;

const context = new AsyncLocalStorage<{ requestId: string }>();
const isProduction = process.env.NODE_ENV === 'production';

/**
 * 内存环形缓冲，只给「日志打包」用：进程重启即清空，不落盘。
 * 控制台输出仍是唯一真相，这里只是最近 500 行的副本。
 */
const HISTORY_LIMIT = 500;
const history: string[] = [];

export function recentLogs(limit = 200): string[] {
  return history.slice(-Math.max(1, Math.min(limit, HISTORY_LIMIT)));
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return context.run({ requestId }, fn);
}

function write(level: Level, message: string, meta: Meta = {}): void {
  if (level === 'debug' && isProduction) return;
  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    request_id: context.getStore()?.requestId ?? 'system',
    ...meta,
  };
  const line = JSON.stringify(entry);
  history.push(line);
  if (history.length > HISTORY_LIMIT) history.shift();
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, meta?: Meta) => write('debug', message, meta),
  info: (message: string, meta?: Meta) => write('info', message, meta),
  warn: (message: string, meta?: Meta) => write('warn', message, meta),
  error: (message: string, meta?: Meta) => write('error', message, meta),
};
