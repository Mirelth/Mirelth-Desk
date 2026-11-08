import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { analyticsService } from './analytics.service.ts';

const uploadSchema = z.object({
  name: z.string().max(120).optional(),
  filename: z.string().min(1, '缺少文件名').max(200),
  csv: z.string().min(1, 'CSV 内容不能为空').max(8_000_000),
});

const insightsSchema = z.object({
  kind: z.enum(['insights', 'report']).optional().default('insights'),
});

export const analyticsRouter = Router();

analyticsRouter.get('/datasets', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: analyticsService.list(currentUserId(req)) });
}));

analyticsRouter.post('/datasets', validateBody(uploadSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: analyticsService.create(currentUserId(req), req.body) });
}));

analyticsRouter.get('/datasets/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: analyticsService.get(currentUserId(req), String(req.params.id)) });
}));

analyticsRouter.delete('/datasets/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  analyticsService.remove(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

analyticsRouter.post('/datasets/:id/insights', validateBody(insightsSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { kind } = req.body as z.infer<typeof insightsSchema>;
  res.json({ data: await analyticsService.insights(currentUserId(req), String(req.params.id), kind) });
}));

analyticsRouter.get('/datasets/:id/export', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const result = analyticsService.exportCsv(currentUserId(req), String(req.params.id));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.type('text/csv; charset=utf-8').send(result.content);
}));
