import type { NextFunction, Response } from 'express';
import { config } from '../../shared/config.ts';
import type { AuthenticatedRequest } from '../../shared/http.ts';
import { authService, SESSION_COOKIE } from './auth.service.ts';

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // 已经有人认证过（`platform.auth.ts` 的入站 API Key）：不要再要求会话。
  if (req.userId) {
    next();
    return;
  }
  try {
    const user = authService.resolve(req.cookies?.[SESSION_COOKIE]);
    req.userId = user.id;
    res.locals.username = user.username;
    next();
  } catch (error) {
    next(error);
  }
}

export function currentUserId(req: AuthenticatedRequest): string {
  if (!req.userId) throw new Error('authenticate middleware missing');
  return req.userId;
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.isProduction,
  path: '/',
};
