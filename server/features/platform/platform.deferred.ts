import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { platformService } from './platform.service.ts';
import { resolveWorkspace } from './platform.request.ts';
import {
  agentSchema, commentSchema, eventSchema, fileSchema, nameSchema,
  shareSchema, workflowSchema,
} from './platform.schema.ts';

/**
 * **未挂载**。这 31 条路由已实现且通过类型检查，但 `server/app.ts` 没有引用本文件。
 *
 * 不挂载的三条理由：
 * 1. **成员管理**（`/workspaces/:id/members`）与 `goal` 的非目标「多用户与协作」直接冲突；
 *    一次安装只有一个账号，挂上等于开一个永远只有 owner 的多用户入口。
 * 2. **`/webhook/:key` 与 `/mcp`** 靠 `currentUserId` 定位调用者，外部系统没有会话，
 *    未登录时 `currentUserId` 会抛错变 500。要让它们可用，需要先设计入站 key（绑定工作区与权限）。
 * 3. **工作流 / 文件 / 分享 / 评论 / 版本 / 事件 / 审计** 在单用户单机场景下价值低，
 *    且会把未验证的写路径一次性放上台面。
 *
 * 要挂其中任何一组：确认产品边界 → 移进 `platform.controller.ts` → 在 `app.ts` 里没有额外动作
 * （同一个 router 前缀）→ 补 `scripts/platform.test.ts` 的断言。
 */
export const platformDeferredRouter = Router();

function workspace(req: AuthenticatedRequest): string {
  return resolveWorkspace(req);
}

platformDeferredRouter.get('/workspaces', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.workspaces(currentUserId(req)) });
}));
platformDeferredRouter.post('/workspaces', validateBody(nameSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: platformService.createWorkspace(currentUserId(req), req.body.name) });
}));
platformDeferredRouter.get('/workspaces/:id/members', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.members(currentUserId(req), String(req.params.id)) });
}));
platformDeferredRouter.post('/workspaces/:id/members',
  validateBody(z.object({ username: z.string().min(1), role: z.string().min(1) })),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    res.status(201).json({ data: platformService.addMember(currentUserId(req), String(req.params.id), req.body.username, req.body.role) });
  }));
platformDeferredRouter.delete('/workspaces/:id/members/:userId', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  platformService.removeMember(currentUserId(req), String(req.params.id), String(req.params.userId));
  res.json({ data: { ok: true } });
}));

platformDeferredRouter.post('/tools',
  validateBody(z.object({
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(300),
    webhook: z.string().max(400).refine((value) => /^https?:\/\//i.test(value), 'Webhook 需以 http(s):// 开头').optional(),
  })),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    res.status(201).json({ data: platformService.registerCustomTool(currentUserId(req), workspace(req), req.body) });
  }));

platformDeferredRouter.get('/agents', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.agents(currentUserId(req), workspace(req)) });
}));
platformDeferredRouter.post('/agents', validateBody(agentSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: { id: platformService.createAgent(currentUserId(req), workspace(req), req.body) } });
}));
platformDeferredRouter.patch('/agents/:id', validateBody(agentSchema.partial()), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: { id: platformService.updateAgent(currentUserId(req), workspace(req), String(req.params.id), req.body) } });
}));
platformDeferredRouter.delete('/agents/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  platformService.deleteAgent(currentUserId(req), workspace(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

platformDeferredRouter.get('/shares', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.shares(currentUserId(req), workspace(req), typeof req.query.documentId === 'string' ? req.query.documentId : undefined) });
}));
platformDeferredRouter.post('/shares', validateBody(shareSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: { id: platformService.share(currentUserId(req), workspace(req), req.body.documentId, req.body.targetUserId, req.body.permission) } });
}));

platformDeferredRouter.get('/comments', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.comments(currentUserId(req), workspace(req), String(req.query.documentId ?? '')) });
}));
platformDeferredRouter.post('/comments', validateBody(commentSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: { id: platformService.addComment(currentUserId(req), workspace(req), req.body.documentId, req.body.content) } });
}));

platformDeferredRouter.get('/versions', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.versions(currentUserId(req), workspace(req), String(req.query.documentId ?? '')) });
}));
platformDeferredRouter.post('/versions',
  validateBody(z.object({ documentId: z.string().min(1), note: z.string().max(200).optional() })),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    res.status(201).json({ data: { id: platformService.snapshot(currentUserId(req), workspace(req), req.body.documentId, req.body.note ?? '') } });
  }));
platformDeferredRouter.post('/versions/:id/restore', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: { documentId: platformService.restoreVersion(currentUserId(req), workspace(req), String(req.params.id)) } });
}));

platformDeferredRouter.get('/files', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.files(currentUserId(req), workspace(req)) });
}));
platformDeferredRouter.post('/files', rateLimit(20, 60_000), validateBody(fileSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: platformService.uploadFile(currentUserId(req), workspace(req), { ...req.body, mime: req.body.mime ?? '' }) });
}));
platformDeferredRouter.get('/files/:id/download', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const file = platformService.readFile(currentUserId(req), workspace(req), String(req.params.id));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.type(file.mime).send(file.content);
}));
platformDeferredRouter.delete('/files/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  platformService.deleteFile(currentUserId(req), workspace(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

platformDeferredRouter.post('/events/emit', validateBody(eventSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await platformService.emitEvent(currentUserId(req), workspace(req), req.body.eventKey, req.body.payload ?? {}) });
}));
platformDeferredRouter.post('/webhook/:key', rateLimit(30, 60_000), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await platformService.emitEvent(currentUserId(req), workspace(req), String(req.params.key), req.body as Record<string, unknown> ?? {}) });
}));
platformDeferredRouter.get('/events', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.events(currentUserId(req), workspace(req)) });
}));

platformDeferredRouter.get('/workflows', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.workflows(currentUserId(req), workspace(req)) });
}));
platformDeferredRouter.post('/workflows', validateBody(workflowSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: { id: platformService.saveWorkflow(currentUserId(req), workspace(req), req.body) } });
}));
platformDeferredRouter.post('/workflows/:id/run', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await platformService.runWorkflow(currentUserId(req), workspace(req), String(req.params.id)) });
}));

platformDeferredRouter.get('/audit', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.auditLogs(currentUserId(req), workspace(req)) });
}));
platformDeferredRouter.get('/usage', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.usage(currentUserId(req), workspace(req)) });
}));

platformDeferredRouter.post('/mcp', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json(await platformService.mcp(currentUserId(req), workspace(req), req.body));
}));
