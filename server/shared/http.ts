import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, type FieldError } from './errors.ts';
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

export interface PageQuery { limit: number; offset: number }

/** 列表接口统一的分页参数：`?limit=&offset=`，夹在 1..maxLimit 与 >=0。 */
export function pageQuery(req: Request, defaultLimit = 20, maxLimit = 100): PageQuery {
  const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
  const rawOffset = Number.parseInt(String(req.query.offset ?? ''), 10);
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), maxLimit) : defaultLimit,
    offset: Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0,
  };
}

export interface Paged<T> { items: T[]; total: number; limit: number; offset: number }

/** 错误信封的唯一出口：`{title, status, detail, errors?, request_id}`。404 与 429 也走它，信封形状才不会分叉。 */
export function sendError(
  res: Response,
  status: number,
  title: string,
  detail: string,
  errors?: FieldError[],
): void {
  res.status(status).json({
    title,
    status,
    detail,
    ...(errors ? { errors } : {}),
    request_id: res.getHeader('x-request-id'),
  });
}

/** `express.json` 抛的是 http-errors（带 status/type）；4xx 映射成 AppError，否则会落到 500 分支。 */
function asClientError(err: unknown): AppError | null {
  const candidate = err as { status?: number; statusCode?: number; type?: string };
  const status = candidate?.status ?? candidate?.statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  if (status === 413 || candidate.type === 'entity.too.large') {
    return new AppError('请求体超过 12MB 上限', 'PAYLOAD_TOO_LARGE', 413);
  }
  if (candidate.type === 'entity.parse.failed') {
    return new AppError('请求体不是合法的 JSON', 'BAD_REQUEST', 400);
  }
  return new AppError('请求格式不正确', 'BAD_REQUEST', status);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appError = err instanceof AppError ? err : asClientError(err);
  if (appError && appError.isOperational) {
    logger.warn('request.failed', { code: appError.code, status: appError.status, path: req.path });
    sendError(res, appError.status, appError.code, appError.message, appError.details);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error('unexpected.error', { error: message, stack, path: req.path });
  sendError(res, 500, 'INTERNAL_ERROR', '服务内部错误，请稍后重试');
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
      sendError(res, 429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
      return;
    }
    next();
  };
}
