import type { AuthenticatedRequest } from '../../shared/http.ts';
import { ForbiddenError } from '../../shared/errors.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { defaultWorkspace, ROLE_LEVEL } from './store.ts';

/**
 * 解析当前请求作用于哪个工作区：入站 API Key 自带的优先，其次 query / body 显式指定的，
 * 最后回落到用户的默认工作区（`defaultWorkspace` 会在首次访问时懒建）。
 */
export function resolveWorkspace(req: AuthenticatedRequest): string {
  if (req.apiKey) return req.apiKey.workspaceId;
  const query = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
  const body = (req.body ?? {}) as { workspaceId?: string };
  return query || body.workspaceId || defaultWorkspace(currentUserId(req)).id;
}

/**
 * 入站 API Key 是「成员角色 + 工作区」的封顶：请求带 key 时，它自己的 role 才是上限，
 * 不能因为 key 属于工作区 owner 就获得 owner 权限。
 */
export function assertKeyRole(req: AuthenticatedRequest, minimum: string): void {
  if (!req.apiKey) return;
  if ((ROLE_LEVEL[req.apiKey.role] ?? 0) < (ROLE_LEVEL[minimum] ?? 99)) {
    throw new ForbiddenError('该 API Key 的权限不足');
  }
}
