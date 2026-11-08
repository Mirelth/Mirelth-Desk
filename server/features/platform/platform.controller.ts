import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { runAgent } from './engine.ts';
import { platformService } from './platform.service.ts';
import { resolveWorkspace } from './platform.request.ts';
import { chatSchema, knowledgeSchema } from './platform.schema.ts';
import { toolManifest } from './tools.ts';

/**
 * 已挂载的 `platform` 路由：只含单用户场景真正用得上的四组——状态、工具清单、
 * 知识库（检索/添加/重建）、会话与运行记录。
 *
 * 其余能力（工作区成员、工作流、文件、分享/评论/版本、事件、审计、MCP）在
 * `platform.deferred.ts`，没有任何文件导入它们；原因见该文件头部与 `platform-subsystem`。
 */
export const platformRouter = Router();

platformRouter.get('/status', asyncHandler<AuthenticatedRequest>(async (req, res) => {
  res.json({ data: platformService.status(currentUserId(req)) });
}));

platformRouter.get('/tools', (_req, res) => res.json({ data: toolManifest() }));

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
