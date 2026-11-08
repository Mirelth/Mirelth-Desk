import { all, get, run } from '../../shared/database.ts';
import { newId, now } from '../../shared/crypto.ts';

export interface MailAccountRow {
  id: string;
  user_id: string;
  email: string;
  username: string;
  password_encrypted: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  created_at: string;
}

export interface MessageRow {
  id: string;
  user_id: string;
  account_id: string | null;
  folder: string;
  remote_id: string | null;
  subject: string;
  from_addr: string;
  to_addr: string;
  body_text: string;
  sent_at: string;
  is_read: number;
  ai_summary: string;
  created_at: string;
}

export interface IncomingMessage {
  accountId: string;
  remoteId: string;
  subject: string;
  from: string;
  to: string;
  body: string;
  sentAt: string;
  isRead: boolean;
}

export const mailRepository = {
  accounts(userId: string): MailAccountRow[] {
    return all<MailAccountRow>('SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY created_at DESC', userId);
  },

  account(userId: string, id: string): MailAccountRow | undefined {
    return get<MailAccountRow>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', id, userId);
  },

  firstAccount(userId: string): MailAccountRow | undefined {
    return get<MailAccountRow>('SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', userId);
  },

  createAccount(input: {
    id: string; userId: string; email: string; username: string; passwordEncrypted: string;
    imapHost: string; imapPort: number; imapSecure: boolean;
    smtpHost: string; smtpPort: number; smtpSecure: boolean;
  }): void {
    run(
      `INSERT INTO mail_accounts (id, user_id, email, username, password_encrypted, imap_host, imap_port, imap_secure,
       smtp_host, smtp_port, smtp_secure, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, input.userId, input.email, input.username, input.passwordEncrypted,
      input.imapHost, input.imapPort, input.imapSecure ? 1 : 0,
      input.smtpHost, input.smtpPort, input.smtpSecure ? 1 : 0, now(),
    );
  },

  deleteAccount(userId: string, id: string): void {
    run('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', id, userId);
  },

  messages(userId: string, filters: { folder?: string; q?: string; limit?: number } = {}): MessageRow[] {
    const conditions = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (filters.folder) { conditions.push('folder = ?'); params.push(filters.folder); }
    if (filters.q) {
      conditions.push('(subject LIKE ? OR body_text LIKE ? OR from_addr LIKE ? OR to_addr LIKE ?)');
      const pattern = `%${filters.q}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 200);
    return all<MessageRow>(
      `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY sent_at DESC, rowid DESC LIMIT ${limit}`,
      ...params,
    );
  },

  message(userId: string, id: string): MessageRow | undefined {
    return get<MessageRow>('SELECT * FROM messages WHERE id = ? AND user_id = ?', id, userId);
  },

  upsertIncoming(userId: string, message: IncomingMessage): boolean {
    const existing = get<{ id: string }>(
      'SELECT id FROM messages WHERE account_id = ? AND folder = ? AND remote_id = ?',
      message.accountId, 'inbox', message.remoteId,
    );
    if (existing) {
      run('UPDATE messages SET is_read = ? WHERE id = ?', message.isRead ? 1 : 0, existing.id);
      return false;
    }
    run(
      `INSERT INTO messages (id, user_id, account_id, folder, remote_id, subject, from_addr, to_addr, body_text,
       sent_at, is_read, ai_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('msg'), userId, message.accountId, 'inbox', message.remoteId,
      message.subject, message.from, message.to, message.body.slice(0, 100_000), message.sentAt,
      message.isRead ? 1 : 0, '', now(),
    );
    return true;
  },

  insertSent(userId: string, input: { accountId: string | null; to: string; subject: string; body: string; remoteId: string }): string {
    const id = newId('msg');
    run(
      `INSERT INTO messages (id, user_id, account_id, folder, remote_id, subject, from_addr, to_addr, body_text,
       sent_at, is_read, ai_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, userId, input.accountId, 'sent', input.remoteId, input.subject,
      input.accountId ? '我 <local>' : '我 <演示账户>', input.to, input.body, now(), 1, '', now(),
    );
    return id;
  },

  markRead(userId: string, id: string, isRead = true): void {
    run('UPDATE messages SET is_read = ? WHERE id = ? AND user_id = ?', isRead ? 1 : 0, id, userId);
  },

  setSummary(userId: string, id: string, summary: string): void {
    run('UPDATE messages SET ai_summary = ? WHERE id = ? AND user_id = ?', summary, id, userId);
  },
};
