import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { researchService } from './research.service.ts';

const statusEnum = z.enum(['active', 'paused', 'archived']);
const experimentStatus = z.enum(['planned', 'running', 'completed', 'abandoned']);
const taskStatus = z.enum(['todo', 'doing', 'done']);
const priorityEnum = z.enum(['low', 'medium', 'high']);
const metricSchema = z.object({ name: z.string().max(60), value: z.number().finite() });

const projectSchema = z.object({
  name: z.string().min(1, '项目名称不能为空').max(200),
  description: z.string().max(4000).optional(),
  objective: z.string().max(4000).optional(),
  status: statusEnum.optional(),
});

const experimentSchema = z.object({
  title: z.string().min(1, '实验标题不能为空').max(200),
  projectId: z.string().max(60).nullable().optional(),
  hypothesis: z.string().max(6000).optional(),
  method: z.string().max(10_000).optional(),
  result: z.string().max(10_000).optional(),
  conclusion: z.string().max(10_000).optional(),
  status: experimentStatus.optional(),
  metrics: z.array(metricSchema).max(20).optional(),
});

const taskSchema = z.object({
  title: z.string().min(1, '任务标题不能为空').max(200),
  projectId: z.string().max(60).nullable().optional(),
  status: taskStatus.optional(),
  priority: priorityEnum.optional(),
  dueDate: z.string().max(40).nullable().optional(),
});

export const researchRouter = Router();

researchRouter.get('/overview', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: researchService.overview(currentUserId(req)) });
}));

researchRouter.post('/projects', validateBody(projectSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: researchService.createProject(currentUserId(req), req.body) });
}));
researchRouter.patch('/projects/:id', validateBody(projectSchema.partial()), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: researchService.updateProject(currentUserId(req), String(req.params.id), req.body) });
}));
researchRouter.delete('/projects/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  researchService.deleteProject(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));
researchRouter.post('/projects/:id/plan', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await researchService.plan(currentUserId(req), String(req.params.id)) });
}));

researchRouter.post('/experiments', validateBody(experimentSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: researchService.createExperiment(currentUserId(req), req.body) });
}));
researchRouter.patch('/experiments/:id', validateBody(experimentSchema.partial()), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: researchService.updateExperiment(currentUserId(req), String(req.params.id), req.body) });
}));
researchRouter.delete('/experiments/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  researchService.deleteExperiment(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));
researchRouter.post(
  '/experiments/:id/ai',
  validateBody(z.object({ action: z.enum(['design', 'interpret']) })),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const { action } = req.body as { action: 'design' | 'interpret' };
    res.json({ data: await researchService.ai(currentUserId(req), String(req.params.id), action) });
  }),
);

researchRouter.post('/tasks', validateBody(taskSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: researchService.createTask(currentUserId(req), req.body) });
}));
researchRouter.patch('/tasks/:id', validateBody(taskSchema.partial()), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: researchService.updateTask(currentUserId(req), String(req.params.id), req.body) });
}));
researchRouter.delete('/tasks/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  researchService.deleteTask(currentUserId(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));
