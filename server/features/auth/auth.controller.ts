import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { config } from '../../shared/config.ts';
import { authService, SESSION_COOKIE } from './auth.service.ts';
import { authenticate, cookieOptions, currentUserId } from './auth.middleware.ts';
import { authRepository } from './auth.repository.ts';

const loginSchema = z.object({
  username: z.string().min(1, '请输入账号').max(64),
  password: z.string().min(1, '请输入密码').max(256),
});

export const authRouter = Router();

authRouter.post(
  '/login',
  rateLimit(20, 60_000),
  validateBody(loginSchema),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const { token, user, expiresAt } = authService.login(req.body.username, req.body.password);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, expires: new Date(expiresAt) });
    res.json({ data: { user, aiMode: config.llm.enabled ? 'live' : 'offline' } });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    authService.logout(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ data: { ok: true } });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const user = authService.resolve(req.cookies?.[SESSION_COOKIE]);
    res.json({ data: { user, aiMode: config.llm.enabled ? 'live' : 'offline' } });
  }),
);

authRouter.get(
  '/context',
  authenticate,
  rateLimit(60, 60_000),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const userId = currentUserId(req);
    const user = authRepository.findById(userId);
    res.json({ data: { user: { id: user?.id, username: user?.username } } });
  }),
);
