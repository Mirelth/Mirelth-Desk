import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, pageQuery, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { papersService } from './papers.service.ts';
import { aiSchema, createSchema, updateSchema } from './papers.schema.ts';

export const papersRouter = Router();

papersRouter.get('/', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({
    data: papersService.page(currentUserId(req), {
      q: typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined,
      tag: typeof req.query.tag === 'string' ? req.query.tag.slice(0, 40) : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
    }, pageQuery(req)),
  });
}));

papersRouter.get('/stats', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: papersService.stats(currentUserId(req)) });
}));

papersRouter.post('/', validateBody(createSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: papersService.create(currentUserId(req), req.body) });
}));

papersRouter.post('/import', validateBody(z.object({ bibtex: z.string().min(1).max(500_000) })), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: papersService.importBibtex(currentUserId(req), req.body.bibtex) });
}));

papersRouter.post('/ai', validateBody(aiSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { kind, tag, status } = req.body as z.infer<typeof aiSchema>;
  res.json({ data: await papersService.ai(currentUserId(req), kind, { tag, status }) });
}));

papersRouter.get('/export', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const format = (['bibtex', 'ris', 'apa'] as const).includes(req.query.format as 'bibtex') ? (req.query.format as 'bibtex' | 'ris' | 'apa') : 'bibtex';
  const result = papersService.export(currentUserId(req), format);
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.type(result.mime).send(result.content);
}));

papersRouter.get('/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: papersService.get(currentUserId(req), String(req.params.id)) });
}));

papersRouter.patch('/:id', validateBody(updateSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: papersService.update(currentUserId(req), String(req.params.id), req.body) });
}));

papersRouter.delete('/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  papersService.remove(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));
