import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../shared/http.ts';
import { apiKeyService } from './api-keys.ts';

/**
 * 挂在 `/api/platform` 之上、`authenticate` 之前。
 *
 * 只有 `/webhook/:key` 与 `/mcp` 认 `X-Api-Key`：这两条是给外部系统调的，没有会话。
 * 其余平台路由即使带了 key 也继续走会话——一条入站凭据不该变成全站通行证。
 * 通过后 `req.userId` 与 `req.apiKey` 都已就位，`authenticate` 见 `userId` 已存在就放行。
 */
export function apiKeyMiddleware(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const raw = req.header('x-api-key');
  if (!raw) { next(); return; }
  const inbound = req.path === '/mcp' || req.path.startsWith('/webhook/');
  if (!inbound) { next(); return; }
  try {
    const scope = apiKeyService.resolve(raw);
    req.apiKey = scope;
    req.userId = scope.userId;
    next();
  } catch (error) {
    next(error);
  }
}
