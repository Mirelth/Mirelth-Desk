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
