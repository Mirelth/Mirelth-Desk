import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, pageQuery, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { DOCUMENT_TEMPLATES, documentsService } from './documents.service.ts';
import { aiSchema, createSchema, importDocxSchema, updateSchema } from './documents.schema.ts';

export const documentsRouter = Router();

documentsRouter.get('/templates', (_req, res) => {
  res.json({ data: DOCUMENT_TEMPLATES });
});

documentsRouter.get('/', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
  res.json({ data: documentsService.page(currentUserId(req), search, pageQuery(req)) });
}));

documentsRouter.post('/', validateBody(createSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: documentsService.create(currentUserId(req), req.body) });
}));

documentsRouter.post('/import', rateLimit(10, 60_000), validateBody(importDocxSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: await documentsService.importFile(currentUserId(req), req.body) });
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
  const format = req.query.format === 'html' ? 'html' : req.query.format === 'docx' ? 'docx' : 'md';
  const result = await documentsService.export(currentUserId(req), String(req.params.id), format);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.type(result.mime).send(result.content);
}));

documentsRouter.post('/:id/slides', rateLimit(10, 60_000), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const result = await documentsService.slides(currentUserId(req), String(req.params.id));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.setHeader('X-Slide-Count', String(result.slides));
  res.setHeader('X-Ai-Mode', result.mode);
  res.type(result.mime).send(result.content);
}));
