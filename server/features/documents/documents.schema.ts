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

export const importDocxSchema = z.object({
  filename: z.string().min(1, '缺少文件名').max(200),
  contentBase64: z.string().min(1, '文件内容不能为空').max(7_000_000),
});

/**
 * 演示文稿生成的可选参数。全部可缺省——不传时行为与旧版一致。
 * 颜色与 Logo 的格式校验在 shared/office 的 normalizeBrand 里做（单一事实来源），
 * 这里只限长度，避免超大 base64 撑爆请求。
 */
export const slidesSchema = z.object({
  theme: z.enum(['ocean', 'forest', 'slate', 'crimson', 'violet', 'sand', 'mono']).optional(),
  brand: z.object({
    organization: z.string().max(60).optional(),
    tagline: z.string().max(120).optional(),
    footer: z.string().max(80).optional(),
    fontFace: z.string().max(60).optional(),
    primaryColor: z.string().max(10).optional(),
    accentColor: z.string().max(10).optional(),
    logoDataUri: z.string().max(2_000_000).optional(),
  }).optional(),
});
