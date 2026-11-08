import { z } from 'zod';

export const nameSchema = z.object({ name: z.string().min(1).max(120) });

export const agentSchema = z.object({
  name: z.string().min(1).max(120), description: z.string().max(500).optional(),
  systemPrompt: z.string().max(4000).optional(), tools: z.array(z.string()).max(40).optional(),
  model: z.string().max(80).optional(), maxSteps: z.number().int().min(1).max(8).optional(),
});

export const chatSchema = z.object({
  message: z.string().min(1, '请输入内容').max(8000),
  conversationId: z.string().max(60).optional(),
  agentId: z.string().max(60).optional(),
  workspaceId: z.string().max(60).optional(),
});

export const knowledgeSchema = z.object({
  title: z.string().min(1).max(200), content: z.string().min(1).max(20_000), sourceType: z.string().max(40).optional(),
});

export const shareSchema = z.object({
  documentId: z.string().min(1), targetUserId: z.string().min(1), permission: z.enum(['read', 'comment', 'edit']).optional().default('read'),
});

export const commentSchema = z.object({ documentId: z.string().min(1), content: z.string().min(1).max(4000) });

export const fileSchema = z.object({
  filename: z.string().min(1).max(200),
  mime: z.string().max(120).optional(),
  contentBase64: z.string().min(1).max(7_000_000),
});

export const eventSchema = z.object({
  eventKey: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const workflowSchema = z.object({
  id: z.string().max(60).optional(), name: z.string().min(1).max(120),
  nodes: z.array(z.object({ id: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional() })).max(30),
  edges: z.array(z.object({ from: z.string(), to: z.string() })).max(60),
  enabled: z.boolean().optional(),
});
