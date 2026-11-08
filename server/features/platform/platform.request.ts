import type { AuthenticatedRequest } from '../../shared/http.ts';
import { currentUserId } from '../auth/auth.middleware.ts';
import { defaultWorkspace } from './store.ts';

/**
 * 解析当前请求作用于哪个工作区：query / body 显式指定的优先，否则回落到用户的默认工作区
 * （`defaultWorkspace` 会在首次访问时懒建）。
 */
export function resolveWorkspace(req: AuthenticatedRequest): string {
  const query = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
  const body = (req.body ?? {}) as { workspaceId?: string };
  return query || body.workspaceId || defaultWorkspace(currentUserId(req)).id;
}
