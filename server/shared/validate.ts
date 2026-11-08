import type { Request, RequestHandler } from 'express';
import { z, type ZodType } from 'zod';
import { ValidationError, type FieldError } from './errors.ts';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const details: FieldError[] = result.error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || 'body',
    message: issue.message,
  }));
  throw new ValidationError(details);
}

/**
 * PATCH 专用：先把每个字段的 `.default()` 剥掉再整体可选，使「没传」保持缺席。
 * 不要换成 `createSchema.partial()`——它保留默认值，会把未传字段写成默认值。
 * 背景见 `shared-kernel` 的入站校验约束。
 */
export function partialOf<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => {
      const candidate = field as ZodType & { removeDefault?: () => ZodType };
      const withoutDefault = typeof candidate.removeDefault === 'function'
        ? candidate.removeDefault()
        : candidate;
      return [key, withoutDefault.optional()];
    }),
  ) as z.ZodRawShape;
  return z.object(shape);
}

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, _res, next) => {
    try {
      req.body = parse(schema, req.body);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function validateQuery<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, _res, next) => {
    try {
      req.query = parse(schema, req.query) as typeof req.query;
      next();
    } catch (error) {
      next(error);
    }
  };
}
