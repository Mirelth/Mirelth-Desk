import { z } from 'zod';
import { partialOf } from '../../shared/validate.ts';

export const createSchema = z.object({
  title: z.string().min(1, '标题不能为空').max(200),
  content: z.string().max(200_000).optional().default(''),
  kind: z.string().max(40).optional(),
  template: z.string().max(40).nullable().optional(),
  tags: z.array(z.string().max(40)).max(12).optional().default([]),
  status: z.enum(['draft', 'review', 'final']).optional().default('draft'),
});

// PATCH 只应改动请求里出现的字段，因此不能复用 createSchema 的默认值。
export const updateSchema = partialOf(createSchema);

export const aiSchema = z.object({
  action: z.enum(['outline', 'draft', 'polish', 'continue', 'summarize']),
  points: z.array(z.string().max(200)).max(20).optional().default([]),
});
