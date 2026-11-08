import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { DOCUMENT_TEMPLATES, documentsService } from './documents.service.ts';

const createSchema = z.object({
  title: z.string().min(1, '标题不能为空').max(200),
  content: z.string().max(200_000).optional().default(''),
  kind: z.string().max(40).optional(),
  template: z.string().max(40).nullable().optional(),
  tags: z.array(z.string().max(40)).max(12).optional().default([]),
  status: z.enum(['draft', 'review', 'final']).optional().default('draft'),
});

const updateSchema = createSchema.partial();

const aiSchema = z.object({
  action: z.enum(['outline', 'draft', 'polish', 'continue', 'summarize']),
  points: z.array(z.string().max(200)).max(20).optional().default([]),
});

export const documentsRouter = Router();

documentsRouter.get('/templates', (_req, res) => {
  res.json({ data: DOCUMENT_TEMPLATES });
});

documentsRouter.get('/', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
  res.json({ data: documentsService.list(currentUserId(req), search) });
}));

documentsRouter.post('/', validateBody(createSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: documentsService.create(currentUserId(req), req.body) });
}));

documentsRouter.get('/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: documentsService.get(currentUserId(req), String(req.params.id)) });
}));

documentsRouter.patch('/:id', validateBody(updateSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: documentsService.update(currentUserId(req), String(req.params.id), req.body) });
}));

documentsRouter.delete('/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  documentsService.remove(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

documentsRouter.post('/:id/ai', validateBody(aiSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { action, points } = req.body as z.infer<typeof aiSchema>;
  res.json({ data: await documentsService.ai(currentUserId(req), String(req.params.id), action, points) });
}));

documentsRouter.get('/:id/export', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const format = req.query.format === 'html' ? 'html' : 'md';
  const result = documentsService.export(currentUserId(req), String(req.params.id), format);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.type(result.mime).send(result.content);
}));
