import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, pageQuery, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { mailService } from './mail.service.ts';

const accountSchema = z.object({
  email: z.string().email('邮箱地址格式不正确').max(200),
  username: z.string().max(200).optional().default(''),
  password: z.string().min(1, '请填写授权码 / 密码').max(300),
  imapHost: z.string().min(1, '请填写 IMAP 服务器').max(200),
  imapPort: z.number().int().min(1).max(65535).optional().default(993),
  imapSecure: z.boolean().optional().default(true),
  smtpHost: z.string().min(1, '请填写 SMTP 服务器').max(200),
  smtpPort: z.number().int().min(1).max(65535).optional().default(465),
  smtpSecure: z.boolean().optional().default(true),
});

const sendSchema = z.object({
  to: z.string().min(1).max(300),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(50_000),
  accountId: z.string().max(60).optional(),
});

const aiSchema = z.object({
  action: z.enum(['reply', 'summary', 'compose']),
  messageId: z.string().max(60).optional(),
  tone: z.enum(['专业礼貌', '简洁', '正式', '友好']).optional(),
  to: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  points: z.array(z.string().max(200)).max(10).optional(),
});

export const mailRouter = Router();

mailRouter.get('/status', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: mailService.status(currentUserId(req)) });
}));

mailRouter.get('/accounts', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: mailService.accounts(currentUserId(req)) });
}));

mailRouter.post('/accounts', validateBody(accountSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: mailService.addAccount(currentUserId(req), req.body) });
}));

mailRouter.delete('/accounts/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  mailService.removeAccount(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

mailRouter.post('/sync', rateLimit(10, 60_000), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await mailService.sync(currentUserId(req)) });
}));

mailRouter.get('/messages', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const folder = typeof req.query.folder === 'string' ? req.query.folder : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
  res.json({ data: mailService.page(currentUserId(req), { folder, q }, pageQuery(req, 50)) });
}));

mailRouter.get('/messages/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: mailService.get(currentUserId(req), String(req.params.id)) });
}));

mailRouter.patch(
  '/messages/:id',
  validateBody(z.object({ isRead: z.boolean() })),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    mailService.setRead(currentUserId(req), String(req.params.id), req.body.isRead);
    res.json({ data: { ok: true } });
  }),
);

mailRouter.post('/send', rateLimit(20, 60_000), validateBody(sendSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await mailService.send(currentUserId(req), req.body) });
}));

mailRouter.post('/ai', validateBody(aiSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await mailService.ai(currentUserId(req), req.body) });
}));
