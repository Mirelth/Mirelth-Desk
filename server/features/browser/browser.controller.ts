import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { defaultWorkspace } from '../platform/store.ts';
import { browserService } from './browser.service.ts';

const runSchema = z.object({
  action: z.enum(['open', 'read', 'click', 'fill', 'screenshot']),
  url: z.string().min(1, '缺少目标地址').max(2000),
  selector: z.string().max(300).optional(),
  value: z.string().max(4000).optional(),
  /** 敏感动作的人工确认：前端必须让用户显式点确认后才置 true。 */
  confirmed: z.boolean().optional().default(false),
});

export const browserRouter = Router();

browserRouter.get('/status', (_req, res) => {
  res.json({ data: browserService.status() });
});

browserRouter.get('/runs', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const userId = currentUserId(req);
  res.json({ data: browserService.runs(userId, defaultWorkspace(userId).id) });
}));

browserRouter.post('/run', rateLimit(20, 60_000), validateBody(runSchema),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const userId = currentUserId(req);
    const result = await browserService.run(userId, defaultWorkspace(userId).id, req.body as z.infer<typeof runSchema>);
    res.json({ data: result });
  }));