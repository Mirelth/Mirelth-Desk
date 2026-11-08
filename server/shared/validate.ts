import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';
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
