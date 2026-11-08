import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from './errors.ts';
import { logger, runWithRequestId } from './logger.ts';

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  runWithRequestId(requestId, () => next());
}

export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on('finish', () => {
    logger.info('http.request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - started,
    });
  });
  next();
}

export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req as T, res, next).catch(next);
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError && err.isOperational) {
    logger.warn('request.failed', { code: err.code, status: err.status, path: req.path });
    res.status(err.status).json({
      title: err.code,
      status: err.status,
      detail: err.message,
      errors: err.details,
      request_id: res.getHeader('x-request-id'),
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error('unexpected.error', { error: message, stack, path: req.path });
  res.status(500).json({
    title: 'INTERNAL_ERROR',
    status: 500,
    detail: '服务内部错误，请稍后重试',
    request_id: res.getHeader('x-request-id'),
  });
}

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(limit: number, windowMs: number): RequestHandler {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.status(429).json({ title: 'RATE_LIMITED', status: 429, detail: '请求过于频繁，请稍后再试' });
      return;
    }
    next();
  };
}
