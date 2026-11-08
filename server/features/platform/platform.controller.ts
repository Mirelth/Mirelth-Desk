import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { runAgent } from './engine.ts';
import { platformService } from './platform.service.ts';
import { defaultWorkspace } from './store.ts';
import { toolManifest } from './tools.ts';

export const platformRouter = Router();

function workspace(req: AuthenticatedRequest): string {
  const query = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
  const body = (req.body ?? {}) as { workspaceId?: string };
  return query || body.workspaceId || defaultWorkspace(currentUserId(req)).id;
}

const nameSchema = z.object({ name: z.string().min(1).max(120) });
const agentSchema = z.object({
  name: z.string().min(1).max(120), description: z.string().max(500).optional(),
  systemPrompt: z.string().max(4000).optional(), tools: z.array(z.string()).max(40).optional(),
  model: z.string().max(80).optional(), maxSteps: z.number().int().min(1).max(8).optional(),
});
const chatSchema = z.object({
  message: z.string().min(1, '请输入内容').max(8000),
  conversationId: z.string().max(60).optional(),
  agentId: z.string().max(60).optional(),
  workspaceId: z.string().max(60).optional(),
});
const knowledgeSchema = z.object({
  title: z.string().min(1).max(200), content: z.string().min(1).max(20_000), sourceType: z.string().max(40).optional(),
});
const shareSchema = z.object({
  documentId: z.string().min(1), targetUserId: z.string().min(1), permission: z.enum(['read', 'comment', 'edit']).optional().default('read'),
});
const commentSchema = z.object({ documentId: z.string().min(1), content: z.string().min(1).max(4000) });
const fileSchema = z.object({ filename: z.string().min(1).max(200), mime: z.string().max(120).optional(), contentBase64: z.string().min(1).max(7_000_000) });
const eventSchema = z.object({ eventKey: z.string().min(1).max(80), payload: z.record(z.string(), z.unknown()).optional() });
const workflowSchema = z.object({
  id: z.string().max(60).optional(), name: z.string().min(1).max(120),
  nodes: z.array(z.object({ id: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional() })).max(30),
  edges: z.array(z.object({ from: z.string(), to: z.string() })).max(60),
  enabled: z.boolean().optional(),
});

platformRouter.get('/status', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.status(currentUserId(req)) });
}));

platformRouter.get('/workspaces', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.workspaces(currentUserId(req)) });
}));
platformRouter.post('/workspaces', validateBody(nameSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: platformService.createWorkspace(currentUserId(req), req.body.name) });
}));
platformRouter.get('/workspaces/:id/members', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.members(currentUserId(req), String(req.params.id)) });
}));
platformRouter.post('/workspaces/:id/members', validateBody(z.object({ username: z.string().min(1), role: z.string().min(1) })),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    res.status(201).json({ data: platformService.addMember(currentUserId(req), String(req.params.id), req.body.username, req.body.role) });
  }));
platformRouter.delete('/workspaces/:id/members/:userId', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  platformService.removeMember(currentUserId(req), String(req.params.id), String(req.params.userId));
  res.json({ data: { ok: true } });
}));

platformRouter.get('/tools', (_req, res) => res.json({ data: toolManifest() }));
platformRouter.post('/tools', validateBody(z.object({ name: z.string().min(1).max(64), description: z.string().min(1).max(300), webhook: z.string().max(400).refine((value) => /^https?:\/\//i.test(value), 'Webhook 需以 http(s):// 开头').optional() })),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    res.status(201).json({ data: platformService.registerCustomTool(currentUserId(req), workspace(req), req.body) });
  }));

platformRouter.get('/agents', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.agents(currentUserId(req), workspace(req)) });
}));
platformRouter.post('/agents', validateBody(agentSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: { id: platformService.createAgent(currentUserId(req), workspace(req), req.body) } });
}));
platformRouter.patch('/agents/:id', validateBody(agentSchema.partial()), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: { id: platformService.updateAgent(currentUserId(req), workspace(req), String(req.params.id), req.body) } });
}));
platformRouter.delete('/agents/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  platformService.deleteAgent(currentUserId(req), workspace(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

platformRouter.get('/conversations', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.conversations(currentUserId(req), workspace(req)) });
}));
platformRouter.get('/conversations/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.conversation(currentUserId(req), workspace(req), String(req.params.id)) });
}));

platformRouter.post('/chat', rateLimit(30, 60_000), validateBody(chatSchema),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const { message, conversationId, agentId } = req.body as z.infer<typeof chatSchema>;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown): void => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      for await (const item of runAgent({ userId: currentUserId(req), workspaceId: workspace(req), conversationId, agentId, message })) {
        send(item.type, item);
      }
    } catch (error) {
      send('error', { detail: error instanceof Error ? error.message : '运行失败' });
    } finally { res.end(); }
  }));

platformRouter.get('/runs', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.runs(currentUserId(req), workspace(req)) });
}));
platformRouter.get('/runs/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.run(currentUserId(req), workspace(req), String(req.params.id)) });
}));

platformRouter.get('/knowledge/search', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.searchKnowledge(currentUserId(req), workspace(req), String(req.query.q ?? '')) });
}));
platformRouter.post('/knowledge', validateBody(knowledgeSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.addKnowledge(currentUserId(req), workspace(req), req.body) });
}));
platformRouter.post('/knowledge/reindex', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.reindex(currentUserId(req), workspace(req)) });
}));

platformRouter.get('/shares', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.shares(currentUserId(req), workspace(req), typeof req.query.documentId === 'string' ? req.query.documentId : undefined) });
}));
platformRouter.post('/shares', validateBody(shareSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: { id: platformService.share(currentUserId(req), workspace(req), req.body.documentId, req.body.targetUserId, req.body.permission) } });
}));
platformRouter.get('/comments', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.comments(currentUserId(req), workspace(req), String(req.query.documentId ?? '')) });
}));
platformRouter.post('/comments', validateBody(commentSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: { id: platformService.addComment(currentUserId(req), workspace(req), req.body.documentId, req.body.content) } });
}));
platformRouter.get('/versions', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.versions(currentUserId(req), workspace(req), String(req.query.documentId ?? '')) });
}));
platformRouter.post('/versions', validateBody(z.object({ documentId: z.string().min(1), note: z.string().max(200).optional() })),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    res.status(201).json({ data: { id: platformService.snapshot(currentUserId(req), workspace(req), req.body.documentId, req.body.note ?? '') } });
  }));
platformRouter.post('/versions/:id/restore', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: { documentId: platformService.restoreVersion(currentUserId(req), workspace(req), String(req.params.id)) } });
}));

platformRouter.get('/files', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.files(currentUserId(req), workspace(req)) });
}));
platformRouter.post('/files', rateLimit(20, 60_000), validateBody(fileSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: platformService.uploadFile(currentUserId(req), workspace(req), { ...req.body, mime: req.body.mime ?? '' }) });
}));
platformRouter.get('/files/:id/download', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const file = platformService.readFile(currentUserId(req), workspace(req), String(req.params.id));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.type(file.mime).send(file.content);
}));
platformRouter.delete('/files/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  platformService.deleteFile(currentUserId(req), workspace(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

platformRouter.post('/events/emit', validateBody(eventSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await platformService.emitEvent(currentUserId(req), workspace(req), req.body.eventKey, req.body.payload ?? {}) });
}));
platformRouter.post('/webhook/:key', rateLimit(30, 60_000), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await platformService.emitEvent(currentUserId(req), workspace(req), String(req.params.key), req.body as Record<string, unknown> ?? {}) });
}));
platformRouter.get('/events', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.events(currentUserId(req), workspace(req)) });
}));

platformRouter.get('/workflows', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.workflows(currentUserId(req), workspace(req)) });
}));
platformRouter.post('/workflows', validateBody(workflowSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: { id: platformService.saveWorkflow(currentUserId(req), workspace(req), req.body) } });
}));
platformRouter.post('/workflows/:id/run', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await platformService.runWorkflow(currentUserId(req), workspace(req), String(req.params.id)) });
}));

platformRouter.get('/audit', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.auditLogs(currentUserId(req), workspace(req)) });
}));
platformRouter.get('/usage', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.usage(currentUserId(req), workspace(req)) });
}));

platformRouter.post('/mcp', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json(await platformService.mcp(currentUserId(req), workspace(req), req.body));
}));
