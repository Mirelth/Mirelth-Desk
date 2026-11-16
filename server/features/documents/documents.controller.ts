import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, pageQuery, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { ValidationError } from '../../shared/errors.ts';
import { deckCatalog, normalizeBrand } from '../../shared/office.ts';
import { DOCUMENT_TEMPLATES, documentsService } from './documents.service.ts';
import { aiSchema, createSchema, importDocxSchema, slidesSchema, updateSchema } from './documents.schema.ts';

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

/**
 * 演示文稿生成。
 *
 * **同时接受 GET 与 POST**：前端 `downloadFile` 走 GET（浏览器直接下载），
 * 而此前只注册了 POST，导致界面上的「生成演示文稿」按钮实际打不通。
 * GET 用查询参数选主题（品牌套件含 Logo，体积大，只能走 POST body）。
 */
const sendSlides = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const themeParam = typeof body.theme === 'string' ? body.theme
    : typeof req.query.theme === 'string' ? req.query.theme : undefined;
  const parsed = slidesSchema.safeParse({
    ...(themeParam ? { theme: themeParam } : {}),
    ...(body.brand ? { brand: body.brand } : {}),
  });
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || 'slides', message: issue.message })),
      '演示文稿参数不合法',
    );
  }
  const result = await documentsService.slides(currentUserId(req), String(req.params.id), {
    ...(parsed.data.theme ? { theme: parsed.data.theme } : {}),
    ...(parsed.data.brand ? { brand: normalizeBrand(parsed.data.brand) } : {}),
  });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.setHeader('X-Slide-Count', String(result.slides));
  res.setHeader('X-Ai-Mode', result.mode);
  res.type(result.mime).send(result.content);
});

documentsRouter.get('/:id/slides', rateLimit(10, 60_000), sendSlides);
documentsRouter.post('/:id/slides', rateLimit(10, 60_000), sendSlides);

/** 模板库：版式与主题清单，供界面渲染选择器（与生成端共用同一份定义）。 */
documentsRouter.get('/slides/catalog', (_req, res) => {
  res.json({ data: deckCatalog() });
});
