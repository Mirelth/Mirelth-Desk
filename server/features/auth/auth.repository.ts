import { all, get, run } from '../../shared/database.ts';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
}

export const authRepository = {
  findByUsername(username: string): UserRow | undefined {
    return get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  },

  findById(id: string): UserRow | undefined {
    return get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  },

  createUser(user: UserRow): void {
    run(
      'INSERT INTO users (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)',
      user.id, user.username, user.password_hash, user.salt, user.created_at,
    );
  },

  /** 对外只暴露 id / username / createdAt，password_hash 与 salt 不出这个文件。 */
  listUsers(): Array<{ id: string; username: string; createdAt: string }> {
    return all<{ id: string; username: string; created_at: string }>(
      'SELECT id, username, created_at FROM users ORDER BY created_at, rowid',
    ).map((row) => ({ id: row.id, username: row.username, createdAt: row.created_at }));
  },

  /** 安装管理员 = 表里最早创建的账号（`ensureAdmin` 只建一次）。 */
  firstUserId(): string | undefined {
    return get<{ id: string }>('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1')?.id;
  },

  deleteUser(id: string): void {
    run('DELETE FROM sessions WHERE user_id = ?', id);
    run('DELETE FROM memberships WHERE user_id = ?', id);
    run('DELETE FROM users WHERE id = ?', id);
  },

  countUsers(): number {
    return get<{ count: number }>('SELECT COUNT(*) AS count FROM users')?.count ?? 0;
  },

  createSession(session: SessionRow): void {
    run(
      'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      session.id, session.user_id, session.expires_at, new Date().toISOString(),
    );
  },

  findSession(id: string): SessionRow | undefined {
    return get<SessionRow>('SELECT * FROM sessions WHERE id = ? AND expires_at > ?', id, new Date().toISOString());
  },

  deleteSession(id: string): void {
    run('DELETE FROM sessions WHERE id = ?', id);
  },

  deleteExpiredSessions(): number {
    const stale = all<{ id: string }>('SELECT id FROM sessions WHERE expires_at <= ?', new Date().toISOString());
    run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
    return stale.length;
  },
};
