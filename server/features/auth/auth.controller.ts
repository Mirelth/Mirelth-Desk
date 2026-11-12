import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, pageQuery, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { config } from '../../shared/config.ts';
import { authService, SESSION_COOKIE } from './auth.service.ts';
import { authenticate, cookieOptions, currentUserId } from './auth.middleware.ts';
import { authRepository } from './auth.repository.ts';
import { ForbiddenError } from '../../shared/errors.ts';
import { activityService } from '../activity/activity.service.ts';

const loginSchema = z.object({
  username: z.string().min(1, '请输入账号').max(64),
  password: z.string().min(1, '请输入密码').max(256),
});

const createUserSchema = z.object({
  username: z.string().min(2, '账号至少 2 个字符').max(64).regex(/^[\w.@-]+$/, '账号只能包含字母、数字与 _ . @ -'),
  password: z.string().min(8, '密码至少 8 个字符').max(128),
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

/** 账号管理只对安装管理员开放。判定在 `authService.isInstallAdmin`，不认环境变量里的用户名。 */
function requireInstallAdmin(req: AuthenticatedRequest): string {
  const userId = currentUserId(req);
  if (!authService.isInstallAdmin(userId)) throw new ForbiddenError('只有安装管理员可以管理账号');
  return userId;
}

authRouter.get(
  '/users',
  authenticate,
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    requireInstallAdmin(req);
    const page = pageQuery(req, 50, 200);
    const items = authService.listUsers();
    res.json({ data: { items: items.slice(page.offset, page.offset + page.limit), total: items.length, limit: page.limit, offset: page.offset } });
  }),
);

authRouter.post(
  '/users',
  authenticate,
  rateLimit(20, 60_000),
  validateBody(createUserSchema),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const actor = requireInstallAdmin(req);
    const { username, password } = req.body as z.infer<typeof createUserSchema>;
    const user = authService.createUser(username, password);
    activityService.record(actor, 'system', 'user_create', `创建账号 ${user.username}`);
    res.status(201).json({ data: user });
  }),
);

authRouter.delete(
  '/users/:id',
  authenticate,
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const actor = requireInstallAdmin(req);
    const target = authService.deleteUser(actor, String(req.params.id));
    activityService.record(actor, 'system', 'user_delete', `删除账号 ${target.username}`);
    res.json({ data: { ok: true } });
  }),
);
