import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { generate } from '../../ai/provider.ts';
import { decryptSecret, encryptSecret, newId } from '../../shared/crypto.ts';
import { AppError, BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { logger } from '../../shared/logger.ts';
import { activityService } from '../activity/activity.service.ts';
import { mailRepository, type MailAccountRow, type MessageRow } from './mail.repository.ts';

export interface MailAccountInput {
  email: string;
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

function stripHtml(source: string): string {
  return source
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function address(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((item) => {
    const entry = item as { name?: string; address?: string };
    return entry.name ? `${entry.name} <${entry.address ?? ''}>` : (entry.address ?? '');
  }).filter(Boolean).join(', ');
}

function accountDto(row: MailAccountRow) {
  return {
    id: row.id, email: row.email, username: row.username,
    imapHost: row.imap_host, imapPort: row.imap_port, imapSecure: Boolean(row.imap_secure),
    smtpHost: row.smtp_host, smtpPort: row.smtp_port, smtpSecure: Boolean(row.smtp_secure),
    createdAt: row.created_at,
  };
}

function messageDto(row: MessageRow) {
  return {
    id: row.id, folder: row.folder, subject: row.subject, from: row.from_addr, to: row.to_addr,
    body: row.body_text, sentAt: row.sent_at, isRead: Boolean(row.is_read),
    aiSummary: row.ai_summary, excerpt: stripHtml(row.body_text).replace(/\s+/g, ' ').slice(0, 120),
    simulated: row.remote_id?.startsWith('demo-') || row.remote_id?.startsWith('local-'),
  };
}

export const mailService = {
  status(userId: string) {
    const account = mailRepository.firstAccount(userId);
    return {
      configured: Boolean(account),
      account: account ? accountDto(account) : null,
      delivery: account ? 'smtp' : 'demo',
    };
  },

  accounts(userId: string) {
    return mailRepository.accounts(userId).map(accountDto);
  },

  addAccount(userId: string, input: MailAccountInput) {
    if (!input.email.includes('@')) throw new BadRequestError('邮箱地址格式不正确');
    if (!input.imapHost || !input.smtpHost) throw new BadRequestError('请填写 IMAP 与 SMTP 服务器地址');
    if (!input.password) throw new BadRequestError('请填写邮箱授权码 / 密码');
    const id = newId('acc');
    mailRepository.createAccount({
      id, userId, email: input.email, username: input.username || input.email,
      passwordEncrypted: encryptSecret(input.password),
      imapHost: input.imapHost, imapPort: input.imapPort, imapSecure: input.imapSecure,
      smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpSecure: input.smtpSecure,
    });
    activityService.record(userId, 'mail', 'config', `配置邮箱账户 ${input.email}`);
    return accountDto(mailRepository.account(userId, id)!);
  },

  removeAccount(userId: string, id: string): void {
    if (!mailRepository.account(userId, id)) throw new NotFoundError('邮箱账户', id);
    mailRepository.deleteAccount(userId, id);
    activityService.record(userId, 'mail', 'config', `移除邮箱账户 ${id}`);
  },

  async sync(userId: string) {
    const accounts = mailRepository.accounts(userId);
    if (!accounts.length) {
      return { synced: 0, accounts: 0, note: '尚未配置邮箱账户，当前展示内置演示邮件。可在「邮箱设置」中接入 IMAP。' };
    }
    let synced = 0;
    const errors: string[] = [];
    for (const account of accounts) {
      const client = new ImapFlow({
        host: account.imap_host,
        port: account.imap_port,
        secure: Boolean(account.imap_secure),
        auth: { user: account.username, pass: decryptSecret(account.password_encrypted) },
        logger: false,
      });
      try {
        await client.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        const total = mailbox.exists ?? 0;
        if (!total) continue;
        const range = `${Math.max(1, total - 29)}:${total}`;
        for await (const message of client.fetch(range, { uid: true, envelope: true, source: true, flags: true })) {
          const envelope = message.envelope as { subject?: string; from?: unknown; to?: unknown; date?: Date } | undefined;
          const raw = message.source ? Buffer.from(message.source as Uint8Array).toString('utf8') : '';
          const flags = message.flags as Set<string> | undefined;
          const created = mailRepository.upsertIncoming(userId, {
            accountId: account.id,
            remoteId: `${message.uid ?? message.seq ?? ''}`,
            subject: String(envelope?.subject ?? '（无主题）'),
            from: address(envelope?.from) || '未知发件人',
            to: address(envelope?.to) || account.email,
            body: stripHtml(raw).slice(0, 100_000),
            sentAt: (envelope?.date ? new Date(envelope.date) : new Date()).toISOString(),
            isRead: flags?.has('\\Seen') ?? false,
          });
          if (created) synced += 1;
        }
        await client.mailboxClose();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error('mail.imap_sync_failed', { account_id: account.id, error: detail });
        errors.push(`${account.email}：${detail.slice(0, 120)}`);
      } finally {
        try { await client.logout(); } catch { /* connection already closed */ }
      }
    }
    if (errors.length && !synced) throw new AppError(`同步失败：${errors.join('；')}`, 'MAIL_SYNC_FAILED', 502);
    activityService.record(userId, 'mail', 'sync', `同步收件箱，新增 ${synced} 封邮件`);
    return { synced, accounts: accounts.length, errors };
  },

  list(userId: string, filters: { folder?: string; q?: string; limit?: number }) {
    return mailRepository.messages(userId, filters).map(messageDto);
  },

  get(userId: string, id: string) {
    const row = mailRepository.message(userId, id);
    if (!row) throw new NotFoundError('邮件', id);
    if (!row.is_read) mailRepository.markRead(userId, id);
    return messageDto({ ...row, is_read: 1 });
  },

  setRead(userId: string, id: string, isRead: boolean): void {
    if (!mailRepository.message(userId, id)) throw new NotFoundError('邮件', id);
    mailRepository.markRead(userId, id, isRead);
  },

  async send(userId: string, input: { to: string; subject: string; body: string; accountId?: string }) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) throw new BadRequestError('收件人邮箱格式不正确');
    if (!input.subject.trim()) throw new BadRequestError('邮件主题不能为空');
    if (!input.body.trim()) throw new BadRequestError('邮件正文不能为空');
    const account = input.accountId
      ? mailRepository.account(userId, input.accountId)
      : mailRepository.firstAccount(userId);
    let delivered = false;
    let remoteId = `local-${newId('mail')}`;
    let note = '未配置 SMTP 账户，邮件已保存到本地「已发送」，未真实投递。';

    if (account) {
      const transport = nodemailer.createTransport({
        host: account.smtp_host,
        port: account.smtp_port,
        secure: Boolean(account.smtp_secure),
        auth: { user: account.username, pass: decryptSecret(account.password_encrypted) },
        connectionTimeout: 15_000,
        socketTimeout: 20_000,
      });
      try {
        const info = await transport.sendMail({
          from: account.email, to: input.to, subject: input.subject, text: input.body,
        });
        delivered = true;
        remoteId = String(info.messageId ?? remoteId);
        note = `已通过 ${account.smtp_host} 投递`;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error('mail.smtp_failed', { account_id: account.id, error: detail });
        throw new AppError(`SMTP 发送失败：${detail.slice(0, 200)}`, 'MAIL_SEND_FAILED', 502);
      } finally {
        transport.close();
      }
    }
    const id = mailRepository.insertSent(userId, {
      accountId: account?.id ?? null, to: input.to, subject: input.subject,
      body: input.body, remoteId,
    });
    activityService.record(userId, 'mail', 'send', `${delivered ? '发送' : '本地保存'}邮件「${input.subject}」`);
    return { id, delivered, note };
  },

  async ai(userId: string, input: {
    action: 'reply' | 'summary' | 'compose';
    messageId?: string; tone?: string; to?: string; subject?: string; points?: string[];
  }) {
    let payload: Record<string, unknown> = {};
    if (input.action === 'compose') {
      payload = { to: input.to ?? '', subject: input.subject ?? '', points: input.points ?? [] };
    } else {
      if (!input.messageId) throw new BadRequestError('请选择一封邮件');
      const row = mailRepository.message(userId, input.messageId);
      if (!row) throw new NotFoundError('邮件', input.messageId);
      payload = { subject: row.subject, from: row.from_addr, body: stripHtml(row.body_text), tone: input.tone ?? '专业礼貌' };
    }
    const result = await generate(
      input.action === 'reply' ? 'mail.reply' : input.action === 'summary' ? 'mail.summary' : 'mail.compose',
      payload,
    );
    if (input.action === 'summary' && input.messageId) {
      mailRepository.setSummary(userId, input.messageId, result.text.slice(0, 4000));
    }
    activityService.record(userId, 'agent', 'mail_ai', `生成邮件${input.action === 'reply' ? '回复' : input.action === 'summary' ? '摘要' : '正文'}`);
    return result;
  },
};
