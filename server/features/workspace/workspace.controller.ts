import { Router } from 'express';
import { asyncHandler, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { workspaceService } from './workspace.service.ts';
import { connectorSchema, taskSchema, updateConnectorSchema, updateTaskSchema } from './workspace.schema.ts';

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

automationRouter.patch('/:id', validateBody(updateTaskSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
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

connectorsRouter.patch('/:id', validateBody(updateConnectorSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: workspaceService.updateConnector(currentUserId(req), String(req.params.id), req.body) });
}));

connectorsRouter.delete('/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  workspaceService.deleteConnector(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

connectorsRouter.post('/:id/test', rateLimit(20, 60_000), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await workspaceService.testConnector(currentUserId(req), String(req.params.id)) });
}));
