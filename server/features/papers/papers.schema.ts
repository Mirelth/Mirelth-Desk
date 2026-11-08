import { z } from 'zod';
import { partialOf } from '../../shared/validate.ts';

export const statusEnum = z.enum(['unread', 'reading', 'read']);

export const createSchema = z.object({
  title: z.string().min(1, '标题不能为空').max(400),
  authors: z.string().max(400).optional().default(''),
  year: z.number().int().min(1500).max(2200).nullable().optional(),
  venue: z.string().max(200).optional().default(''),
  doi: z.string().max(200).optional().default(''),
  url: z.string().max(400).optional().default(''),
  abstract: z.string().max(8000).optional().default(''),
  tags: z.array(z.string().max(40)).max(12).optional().default([]),
  status: statusEnum.optional().default('unread'),
  rating: z.number().int().min(0).max(5).optional().default(0),
  notes: z.string().max(20_000).optional().default(''),
});

// PATCH 只应改动请求里出现的字段，因此不能复用 createSchema 的默认值。
export const updateSchema = partialOf(createSchema);

export const aiSchema = z.object({
  kind: z.enum(['summary', 'review', 'synthesize']).optional().default('review'),
  tag: z.string().max(40).optional(),
  status: statusEnum.optional(),
});
