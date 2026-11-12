import crypto from 'node:crypto';
import { all, get, run } from '../../shared/database.ts';
import { newId, now } from '../../shared/crypto.ts';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../shared/errors.ts';
import type { ApiKeyScope } from '../../shared/http.ts';
import { ROLE_LEVEL, requireRole } from './store.ts';

/**
 * 工作区的入站凭据：`/webhook/:key` 与 `/mcp` 没有会话，靠 `X-Api-Key` 定位调用者。
 *
 * 三条约束：
 * - 明文只在创建时返回一次，库里只有 `sha256` 摘要与给人看的 `prefix`；
 * - 角色上限是 `admin`——`owner` 意味着能管理 key 本身，不该由一条长期凭据持有；
 * - 解析时把 `last_used_at` 写回，便于界面上分辨「还在用的」与「该撤销的」。
 */
interface KeyRow {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  role: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const KEY_PATTERN = /^mdk_[0-9a-f]{8}_[A-Za-z0-9_-]{24,}$/;

function digest(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const apiKeyService = {
  list(userId: string, workspaceId: string): ApiKeyView[] {
    requireRole(workspaceId, userId, 'admin');
    return all<KeyRow>(
      'SELECT * FROM workspace_api_keys WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC',
      workspaceId,
    ).map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      role: row.role,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  },

  create(userId: string, workspaceId: string, name: string, role: string) {
    requireRole(workspaceId, userId, 'admin');
    if (!ROLE_LEVEL[role] || role === 'owner') {
      throw new BadRequestError('Key 角色只能是 viewer / member / admin');
    }
    const prefix = crypto.randomBytes(4).toString('hex');
    const key = `mdk_${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
    const id = newId('key');
    const createdAt = now();
    run(
      `INSERT INTO workspace_api_keys (id, workspace_id, user_id, name, prefix, key_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, workspaceId, userId, name.trim() || '未命名 Key', prefix, digest(key), role, createdAt,
    );
    return { id, name: name.trim() || '未命名 Key', prefix, role, createdAt, key };
  },

  revoke(userId: string, workspaceId: string, id: string): void {
    requireRole(workspaceId, userId, 'admin');
    const existing = get<KeyRow>('SELECT * FROM workspace_api_keys WHERE id = ? AND workspace_id = ?', id, workspaceId);
    if (!existing) throw new NotFoundError('API Key', id);
    if (existing.revoked_at) return;
    run('UPDATE workspace_api_keys SET revoked_at = ? WHERE id = ?', now(), id);
  },

  resolve(raw: string): ApiKeyScope {
    if (!KEY_PATTERN.test(raw)) throw new UnauthorizedError('API Key 格式不正确');
    const row = get<KeyRow>('SELECT * FROM workspace_api_keys WHERE key_hash = ?', digest(raw));
    if (!row || row.revoked_at) throw new UnauthorizedError('API Key 无效或已撤销');
    run('UPDATE workspace_api_keys SET last_used_at = ? WHERE id = ?', now(), row.id);
    return { keyId: row.id, workspaceId: row.workspace_id, userId: row.user_id, role: row.role };
  },
};
