import { Router } from 'express';
import { z } from 'zod';
import type { TaskKind } from '../../ai/prompts.ts';
import { aiStatus, generate, streamTask } from '../../ai/provider.ts';
import { asyncHandler, rateLimit, type AuthenticatedRequest } from '../../shared/http.ts';
import { logger } from '../../shared/logger.ts';
import { validateBody } from '../../shared/validate.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { activityService } from '../activity/activity.service.ts';

const taskKinds = [
  'document.outline', 'document.draft', 'document.polish', 'document.continue', 'document.summarize',
  'analytics.insights', 'analytics.report', 'paper.summary', 'paper.review', 'paper.synthesize',
  'research.design', 'research.interpret', 'research.plan', 'mail.reply', 'mail.summary', 'mail.compose',
  'agent.chat',
] as const;

const taskSchema = z.object({
  kind: z.enum(taskKinds),
  input: z.record(z.string(), z.unknown()).default({}),
});

export const agentRouter = Router();

agentRouter.get('/status', (_req, res) => {
  res.json({ data: aiStatus() });
});

agentRouter.post(
  '/generate',
  rateLimit(40, 60_000),
  validateBody(taskSchema),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const { kind, input } = req.body as z.infer<typeof taskSchema>;
    const result = await generate(kind as TaskKind, input);
    activityService.record(currentUserId(req), 'agent', 'generate', `生成内容：${kind}`);
    res.json({ data: result });
  }),
);

agentRouter.post(
  '/run',
  rateLimit(40, 60_000),
  validateBody(taskSchema),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const { kind, input } = req.body as z.infer<typeof taskSchema>;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    send('meta', { ...aiStatus(), task: kind });
    try {
      for await (const chunk of streamTask(kind as TaskKind, input)) {
        send('delta', { text: chunk });
      }
      activityService.record(currentUserId(req), 'agent', 'stream', `流式生成内容：${kind}`);
      send('done', { ok: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '生成失败';
      logger.error('agent.stream_failed', { task: kind, detail });
      send('error', { detail });
    } finally {
      res.end();
    }
  }),
);
