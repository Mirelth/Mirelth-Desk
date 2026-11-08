import crypto from 'node:crypto';
import { config } from '../../shared/config.ts';
import { hashPassword, newId, now, readSession, signSession, verifyPassword } from '../../shared/crypto.ts';
import { UnauthorizedError } from '../../shared/errors.ts';
import { logger } from '../../shared/logger.ts';
import { authRepository } from './auth.repository.ts';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'md_session';

export interface SessionUser {
  id: string;
  username: string;
}

export const authService = {
  ensureAdmin(): void {
    if (authRepository.countUsers() > 0) return;
    const { hash, salt } = hashPassword(config.admin.password);
    authRepository.createUser({
      id: newId('usr'),
      username: config.admin.username,
      password_hash: hash,
      salt,
      created_at: now(),
    });
    logger.info('auth.admin_created', { username: config.admin.username });
  },

  login(username: string, password: string): { token: string; user: SessionUser; expiresAt: number } {
    const user = authRepository.findByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash, user.salt)) {
      logger.warn('auth.login_failed', { username });
      throw new UnauthorizedError('账号或密码不正确');
    }
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const sid = crypto.randomUUID();
    authRepository.createSession({ id: sid, user_id: user.id, expires_at: new Date(expiresAt).toISOString() });
    logger.info('auth.login', { user_id: user.id });
    return { token: signSession({ sid, exp: expiresAt }), user: { id: user.id, username: user.username }, expiresAt };
  },

  resolve(token: string | undefined): SessionUser {
    const payload = readSession(token);
    if (!payload) throw new UnauthorizedError();
    const session = authRepository.findSession(payload.sid);
    if (!session) throw new UnauthorizedError();
    const user = authRepository.findById(session.user_id);
    if (!user) throw new UnauthorizedError();
    return { id: user.id, username: user.username };
  },

  logout(token: string | undefined): void {
    const payload = readSession(token);
    if (payload) authRepository.deleteSession(payload.sid);
  },

  cleanup(): number {
    return authRepository.deleteExpiredSessions();
  },
};
