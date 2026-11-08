import { AsyncLocalStorage } from 'node:async_hooks';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Meta = Record<string, unknown>;

const context = new AsyncLocalStorage<{ requestId: string }>();
const isProduction = process.env.NODE_ENV === 'production';

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
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, meta?: Meta) => write('debug', message, meta),
  info: (message: string, meta?: Meta) => write('info', message, meta),
  warn: (message: string, meta?: Meta) => write('warn', message, meta),
  error: (message: string, meta?: Meta) => write('error', message, meta),
};
