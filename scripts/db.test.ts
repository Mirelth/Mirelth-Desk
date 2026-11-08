/**
 * 碰数据库的测试：`scripts/db.test.ts`。
 *
 * 单独成文件、并且用动态 import，是为了让 DATABASE_PATH 在 `server/shared/config.ts`
 * 被加载之前生效——静态 import 会被提升到文件顶部，抢在赋值之前执行。
 */
process.env.DATABASE_PATH = '.data/regression-test.db';
process.env.APP_SECRET = 'regression-test-secret-0123456789';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';

const { db, migrate, run } = await import('../server/shared/database.ts');
const { mailRepository } = await import('../server/features/mail/mail.repository.ts');

migrate();
run(
  'INSERT INTO users (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)',
  'usr_regression', 'regression', 'hash', 'salt', new Date().toISOString(),
);

test('本地「已发送」记录真实账户地址，而不是写死占位', () => {
  const id = mailRepository.insertSent('usr_regression', {
    accountId: 'acc_regression',
    from: '我 <me@example.com>',
    to: 'teammate@example.com',
    subject: '进度同步',
    body: '正文',
    remoteId: 'local-regression-1',
  });
  assert.equal(mailRepository.message('usr_regression', id)?.from_addr, '我 <me@example.com>');
});

after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`.data/regression-test.db${suffix}`, { force: true });
});
