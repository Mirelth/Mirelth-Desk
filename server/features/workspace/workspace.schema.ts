import { z } from 'zod';
import { partialOf } from '../../shared/validate.ts';

export const taskSchema = z.object({
  name: z.string().min(1, '任务名称不能为空').max(120),
  description: z.string().max(2000).optional().default(''),
  triggerType: z.enum(['manual', 'interval', 'event']).optional().default('manual'),
  intervalMinutes: z.number().int().min(0).max(10080).optional().default(0),
  workspaceId: z.string().max(60).optional(),
  eventKey: z.string().max(80).optional(),
  action: z.string().min(1, '请选择执行动作').max(60),
  enabled: z.boolean().optional().default(true),
});

// PATCH 只应改动请求里出现的字段，因此不能复用上面两个 schema 的默认值。
export const updateTaskSchema = partialOf(taskSchema);

export const connectorSchema = z.object({
  name: z.string().min(1, '连接器名称不能为空').max(120),
  kind: z.enum(['webhook', 'api', 'storage', 'custom']).optional().default('webhook'),
  baseUrl: z.string().min(1, '请填写地址').max(400).refine((value) => /^https?:\/\//i.test(value), '地址必须以 http:// 或 https:// 开头'),
  description: z.string().max(500).optional().default(''),
  token: z.string().max(300).optional(),
  enabled: z.boolean().optional().default(true),
});

export const updateConnectorSchema = partialOf(connectorSchema);
