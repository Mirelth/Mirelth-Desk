/**
 * 回归测试：`npm test`（node --test，零新依赖，走 Node 的原生 TS 类型剥离）。
 *
 * 这些断言对应规格里记录过的两处缺陷：
 * 1. PATCH 路由用 `createSchema.partial()` 校验，Zod 的 `.partial()` 保留 `.default()`，
 *    于是「没传的字段」会被填成默认值并被 service 写库（数据静默丢失）。
 * 2. `decryptSecret` 裸抛普通 Error，绕过 AppError，于是错误信封里没有可操作的 code/detail。
 *
 * 注意：导入 `shared/crypto.ts` 会连带执行 `shared/config.ts` 的模块级副作用
 * （开发环境缺 APP_SECRET 时生成 `.data/secret.key`），与启动服务时一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateSchema as documentUpdateSchema } from '../server/features/documents/documents.schema.ts';
import { updateSchema as paperUpdateSchema } from '../server/features/papers/papers.schema.ts';
import {
  updateConnectorSchema as connectorUpdateSchema,
  updateTaskSchema as taskUpdateSchema,
} from '../server/features/workspace/workspace.schema.ts';
import { BadRequestError, AppError } from '../server/shared/errors.ts';
import { decryptSecret } from '../server/shared/crypto.ts';
import { parseCsv } from '../server/features/analytics/csv.ts';
import { computeStats, type ColumnInfo } from '../server/features/analytics/analytics.stats.ts';
import { offlineGenerate } from '../server/ai/offline.ts';

test('文档 PATCH 只产出传入的字段', () => {
  assert.deepEqual(documentUpdateSchema.parse({ title: '改个标题' }), { title: '改个标题' });
});

test('文献 PATCH 不会把状态/评分/摘要重置成默认值', () => {
  assert.deepEqual(paperUpdateSchema.parse({ notes: '一条笔记' }), { notes: '一条笔记' });
});

test('自动化任务 PATCH 不会把定时任务降级成手动', () => {
  assert.deepEqual(taskUpdateSchema.parse({ enabled: false }), { enabled: false });
});

test('连接器 PATCH 不会改掉 kind 或抹掉描述', () => {
  assert.deepEqual(connectorUpdateSchema.parse({ enabled: false }), { enabled: false });
});

test('decryptSecret 对损坏的密文抛 AppError', () => {
  for (const payload of ['broken', 'a.b.c', 'abc.zz.qq']) {
    assert.throws(
      () => decryptSecret(payload),
      (error: unknown) => error instanceof AppError,
      `payload ${payload} 应抛 AppError`,
    );
  }
});

// ── CSV 导入不能静默丢数据 ────────────────────────────────────────────────
test('多余的非空单元格要报错，行尾空逗号放行', () => {
  assert.throws(
    () => parseCsv('a,b\n1,2,3\n4,5'),
    (error: unknown) => error instanceof BadRequestError && /第 2 行/.test((error as Error).message),
    '第 2 行多出一个非空单元格，应报 400',
  );
  assert.doesNotThrow(() => parseCsv('a,b\n1,2,\n4,5,'), '行尾空逗号不应报错');
});

test('未闭合的引号要报错，不能吞掉半个文件', () => {
  assert.throws(
    () => parseCsv('a,b\n1,"hello\n2,3'),
    (error: unknown) => error instanceof BadRequestError,
    '引号未闭合应报 400',
  );
});

// ── 空单元格不能当 0 参与统计 ─────────────────────────────────────────────
const statsColumns: ColumnInfo[] = [
  { name: '月份', type: 'categorical', missing: 0, unique: 2 },
  { name: '营收', type: 'numeric', missing: 1 },
];

test('空单元格不参与分组均值，也不虚增 count', () => {
  const stats = computeStats(statsColumns, [
    { 月份: '1月', 营收: 10 },
    { 月份: '1月', 营收: null },
    { 月份: '2月', 营收: 20 },
  ]);
  assert.deepEqual(stats.groups[0], { label: '1月', value: 10, count: 1 });
});

test('相关性按行取交集，不会把两列的缺失错位配对', () => {
  const columns: ColumnInfo[] = [
    { name: 'a', type: 'numeric', missing: 1 },
    { name: 'b', type: 'numeric', missing: 1 },
  ];
  // 对齐后只有第 1/4/5 行成对：a=[1,5,7]、b=[2,10,14]，完全线性 → 1
  const stats = computeStats(columns, [
    { a: 1, b: 2 },
    { a: null, b: 4 },
    { a: 3, b: null },
    { a: 5, b: 10 },
    { a: 7, b: 14 },
  ]);
  assert.equal(stats.correlations[0]?.value, 1);
});

// ── 离线引擎不能把要点截成「…」 ───────────────────────────────────────────
test('离线大纲保留要点原文', () => {
  const output = offlineGenerate('document.outline', {
    title: '季度复盘',
    points: ['梳理需求与范围', '明确时间节点', '确认责任人'],
  });
  for (const point of ['梳理需求与范围', '明确时间节点', '确认责任人']) {
    assert.ok(output.includes(point), `要点「${point}」应完整出现在输出里`);
  }
  assert.ok(!output.includes('- …'), '不应出现被截成省略号的列表项');
});

// ── 文档摘要不能串用邮件摘要 ─────────────────────────────────────────────
test('文档摘要不出现邮件摘要的标题与字段', () => {
  const output = offlineGenerate('document.summarize', {
    title: '季度复盘',
    content: '本季度完成了三件事。第一，交付客户看板。第二，关闭 18 个缺陷。第三，完成文献精读。',
  });
  assert.ok(!output.includes('邮件摘要'), '不应出现「邮件摘要」标题');
  assert.ok(!output.includes('发件人'), '不应出现「发件人」字段');
  assert.ok(/后续|待办/.test(output), '应包含后续事项小节');
});
