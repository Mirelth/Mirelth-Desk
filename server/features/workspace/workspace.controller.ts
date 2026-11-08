import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { workspaceService } from './workspace.service.ts';

const taskSchema = z.object({
  name: z.string().min(1, '任务名称不能为空').max(120),
  description: z.string().max(2000).optional().default(''),
  triggerType: z.enum(['manual', 'interval', 'event']).optional().default('manual'),
  intervalMinutes: z.number().int().min(0).max(10080).optional().default(0),
  workspaceId: z.string().max(60).optional(),
  eventKey: z.string().max(80).optional(),
  action: z.string().min(1, '请选择执行动作').max(60),
  enabled: z.boolean().optional().default(true),
});

const connectorSchema = z.object({
  name: z.string().min(1, '连接器名称不能为空').max(120),
  kind: z.enum(['webhook', 'api', 'storage', 'custom']).optional().default('webhook'),
  baseUrl: z.string().min(1, '请填写地址').max(400).refine((value) => /^https?:\/\//i.test(value), '地址必须以 http:// 或 https:// 开头'),
  description: z.string().max(500).optional().default(''),
  token: z.string().max(300).optional(),
  enabled: z.boolean().optional().default(true),
});

export const automationRouter = Router();

automationRouter.get('/actions', (_req, res) => {
  res.json({ data: workspaceService.actions() });
});

automationRouter.get('/', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: workspaceService.listTasks(currentUserId(req)) });
}));

automationRouter.post('/', validateBody(taskSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: workspaceService.createTask(currentUserId(req), req.body) });
}));

automationRouter.patch('/:id', validateBody(taskSchema.partial()), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: workspaceService.updateTask(currentUserId(req), String(req.params.id), req.body) });
}));

automationRouter.delete('/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  workspaceService.deleteTask(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

automationRouter.post('/:id/run', rateLimit(20, 60_000), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await workspaceService.runTask(currentUserId(req), String(req.params.id)) });
}));

export const connectorsRouter = Router();

connectorsRouter.get('/', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: workspaceService.listConnectors(currentUserId(req)) });
}));

connectorsRouter.post('/', validateBody(connectorSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: workspaceService.createConnector(currentUserId(req), req.body) });
}));

connectorsRouter.patch('/:id', validateBody(connectorSchema.partial()), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: workspaceService.updateConnector(currentUserId(req), String(req.params.id), req.body) });
}));

connectorsRouter.delete('/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  workspaceService.deleteConnector(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

connectorsRouter.post('/:id/test', rateLimit(20, 60_000), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await workspaceService.testConnector(currentUserId(req), String(req.params.id)) });
}));
