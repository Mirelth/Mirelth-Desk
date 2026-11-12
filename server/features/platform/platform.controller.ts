import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { runAgent } from './engine.ts';
import { platformService } from './platform.service.ts';
import { assertKeyRole, resolveWorkspace } from './platform.request.ts';
import {
  agentSchema, apiKeySchema, chatSchema, commentSchema, eventSchema, fileSchema,
  knowledgeSchema, memberSchema, nameSchema, shareSchema, toolSchema, versionSchema, workflowSchema,
} from './platform.schema.ts';
import { toolManifest } from './tools.ts';
import { apiKeyService } from './api-keys.ts';

/**
 * `platform` 的全部 HTTP 面：状态与配额、工具（清单 + 自定义注册）、知识库、会话与运行、
 * 工作区与成员、分享/评论/版本、文件、事件与工作流、审计、用量、MCP，以及入站 API Key。
 *
 * 两组入口的鉴权不同：
 * - 其余路由走会话（`app.use('/api', authenticate)`），工作区由 `resolveWorkspace` 决定；
 * - `/webhook/:key` 与 `/mcp` 额外接受 `X-Api-Key`（见 `platform.auth.ts`），供没有会话的外部系统调用，
 *   此时工作区固定在 key 上，角色以 key 自身为上限（`assertKeyRole`）。
 */
export const platformRouter = Router();

platformRouter.get('/status', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.status(currentUserId(req)) });
}));

platformRouter.get('/tools', (_req, res) => res.json({ data: toolManifest() }));
platformRouter.post('/tools', validateBody(toolSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: platformService.registerCustomTool(currentUserId(req), resolveWorkspace(req), req.body) });
}));

platformRouter.get('/knowledge/search', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.searchKnowledge(currentUserId(req), resolveWorkspace(req), String(req.query.q ?? '')) });
}));
platformRouter.post('/knowledge', validateBody(knowledgeSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.addKnowledge(currentUserId(req), resolveWorkspace(req), req.body) });
}));
platformRouter.post('/knowledge/reindex', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.reindex(currentUserId(req), resolveWorkspace(req)) });
}));

platformRouter.get('/conversations', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.conversations(currentUserId(req), resolveWorkspace(req)) });
}));
platformRouter.get('/conversations/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.conversation(currentUserId(req), resolveWorkspace(req), String(req.params.id)) });
}));

platformRouter.post('/chat', rateLimit(30, 60_000), validateBody(chatSchema),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const { message, conversationId, agentId } = req.body as z.infer<typeof chatSchema>;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      for await (const item of runAgent({
        userId: currentUserId(req), workspaceId: resolveWorkspace(req), conversationId, agentId, message,
      })) {
        send(item.type, item);
      }
    } catch (error) {
      send('error', { detail: error instanceof Error ? error.message : '运行失败' });
    } finally { res.end(); }
  }));

platformRouter.get('/runs', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.runs(currentUserId(req), resolveWorkspace(req)) });
}));
platformRouter.get('/runs/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.run(currentUserId(req), resolveWorkspace(req), String(req.params.id)) });
}));

// —— 工作区与成员 ——
platformRouter.get('/workspaces', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.workspaces(currentUserId(req)) });
}));
platformRouter.post('/workspaces', validateBody(nameSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: platformService.createWorkspace(currentUserId(req), req.body.name) });
}));
platformRouter.get('/workspaces/:id/members', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.members(currentUserId(req), String(req.params.id)) });
}));
platformRouter.post('/workspaces/:id/members',
  validateBody(memberSchema),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    res.status(201).json({ data: platformService.addMember(currentUserId(req), String(req.params.id), req.body.username, req.body.role) });
  }));
platformRouter.delete('/workspaces/:id/members/:userId', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  platformService.removeMember(currentUserId(req), String(req.params.id), String(req.params.userId));
  res.json({ data: { ok: true } });
}));

// —— 智能体定义 ——
platformRouter.get('/agents', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.agents(currentUserId(req), resolveWorkspace(req)) });
}));
platformRouter.post('/agents', validateBody(agentSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: { id: platformService.createAgent(currentUserId(req), resolveWorkspace(req), req.body) } });
}));
platformRouter.patch('/agents/:id', validateBody(agentSchema.partial()), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: { id: platformService.updateAgent(currentUserId(req), resolveWorkspace(req), String(req.params.id), req.body) } });
}));
platformRouter.delete('/agents/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  platformService.deleteAgent(currentUserId(req), resolveWorkspace(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

// —— 分享 / 评论 / 版本 ——
platformRouter.get('/shares', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.shares(currentUserId(req), resolveWorkspace(req), typeof req.query.documentId === 'string' ? req.query.documentId : undefined) });
}));
platformRouter.post('/shares', validateBody(shareSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: { id: platformService.share(currentUserId(req), resolveWorkspace(req), req.body.documentId, req.body.targetUserId, req.body.permission) } });
}));

platformRouter.get('/comments', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.comments(currentUserId(req), resolveWorkspace(req), String(req.query.documentId ?? '')) });
}));
platformRouter.post('/comments', validateBody(commentSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: { id: platformService.addComment(currentUserId(req), resolveWorkspace(req), req.body.documentId, req.body.content) } });
}));

platformRouter.get('/versions', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.versions(currentUserId(req), resolveWorkspace(req), String(req.query.documentId ?? '')) });
}));
platformRouter.post('/versions',
  validateBody(versionSchema),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    res.status(201).json({ data: { id: platformService.snapshot(currentUserId(req), resolveWorkspace(req), req.body.documentId, req.body.note ?? '') } });
  }));
platformRouter.post('/versions/:id/restore', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: { documentId: platformService.restoreVersion(currentUserId(req), resolveWorkspace(req), String(req.params.id)) } });
}));

// —— 文件 ——
platformRouter.get('/files', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.files(currentUserId(req), resolveWorkspace(req)) });
}));
platformRouter.post('/files', rateLimit(20, 60_000), validateBody(fileSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.status(201).json({ data: platformService.uploadFile(currentUserId(req), resolveWorkspace(req), { ...req.body, mime: req.body.mime ?? '' }) });
}));
platformRouter.get('/files/:id/download', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const file = platformService.readFile(currentUserId(req), resolveWorkspace(req), String(req.params.id));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.type(file.mime).send(file.content);
}));
platformRouter.delete('/files/:id', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  platformService.deleteFile(currentUserId(req), resolveWorkspace(req), String(req.params.id));
  res.json({ data: { ok: true } });
}));

// —— 事件：会话内 emit，外部走 /webhook/:key ——
platformRouter.post('/events/emit', validateBody(eventSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await platformService.emitEvent(currentUserId(req), resolveWorkspace(req), req.body.eventKey, req.body.payload ?? {}) });
}));
platformRouter.post('/webhook/:key', rateLimit(30, 60_000), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  assertKeyRole(req, 'member');
  const payload = (req.body ?? {}) as Record<string, unknown>;
  res.json({ data: await platformService.emitEvent(currentUserId(req), resolveWorkspace(req), String(req.params.key), payload) });
}));
platformRouter.get('/events', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.events(currentUserId(req), resolveWorkspace(req)) });
}));

// —— 工作流 ——
platformRouter.get('/workflows', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.workflows(currentUserId(req), resolveWorkspace(req)) });
}));
platformRouter.post('/workflows', validateBody(workflowSchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: { id: platformService.saveWorkflow(currentUserId(req), resolveWorkspace(req), req.body) } });
}));
platformRouter.post('/workflows/:id/run', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: await platformService.runWorkflow(currentUserId(req), resolveWorkspace(req), String(req.params.id)) });
}));

// —— 审计与用量（只读，admin 起）——
platformRouter.get('/audit', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.auditLogs(currentUserId(req), resolveWorkspace(req)) });
}));
platformRouter.get('/usage', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.usage(currentUserId(req), resolveWorkspace(req)) });
}));

// —— MCP：JSON-RPC 2.0 shim，外部可带 X-Api-Key ——
platformRouter.post('/mcp', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  assertKeyRole(req, 'member');
  res.json(await platformService.mcp(currentUserId(req), resolveWorkspace(req), req.body));
}));

// —— 入站凭据管理：只走会话，且要工作区 admin/owner ——
platformRouter.get('/workspaces/:id/keys', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: apiKeyService.list(currentUserId(req), String(req.params.id)) });
}));
platformRouter.post('/workspaces/:id/keys', validateBody(apiKeySchema), asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { name, role } = req.body as z.infer<typeof apiKeySchema>;
  res.status(201).json({ data: apiKeyService.create(currentUserId(req), String(req.params.id), name, role) });
}));
platformRouter.delete('/workspaces/:id/keys/:keyId', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  apiKeyService.revoke(currentUserId(req), String(req.params.id), String(req.params.keyId));
  res.json({ data: { ok: true } });
}));
