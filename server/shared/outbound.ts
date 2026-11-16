import { config } from './config.ts';
import { BadRequestError, ForbiddenError } from './errors.ts';

/**
 * 插件出站的**唯一闸门**。
 *
 * 为什么需要它：插件的目标地址与请求体都可能被模型影响，而模型读到的知识库内容
 * 是外部数据。没有闸门时，一个「工具调用」就能把本机数据发到任意地址，或探测内网。
 *
 * 口径刻意与 `features/browser` 一致而非与连接器一致：
 * **白名单为空即拒绝全部**，要用户显式授权域名；连接器只校验协议，强度不够。
 *
 * 边界：本模块只管插件出站。LLM 请求仍走 `ai/provider.ts`，CDP 仍走 browser 自己的
 * 回环校验——那两条各有既有约束，不在此处改动。
 */

/** 私网与保留地址：默认拒绝，避免把插件变成内网探测与元数据窃取通道。 */
function isPrivateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return true;
  // IPv6 回环、链路本地、唯一本地地址
  if (name === '::1' || name.startsWith('fe80:') || name.startsWith('fc') || name.startsWith('fd')) return true;
  const parts = name.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((value) => value > 255)) return false;
  const [a, b] = octets;
  if (a === 127 || a === 10 || a === 0) return true;
  // 链路本地 169.254/16 —— 云环境元数据端点在此段，必须默认拒绝。
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // CGNAT 100.64/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export interface OutboundTarget { url: URL; host: string }

/**
 * 校验目标地址：协议 → 私网 → 白名单。任一不过即抛可读错误。
 * `allowPrivate` 由调用方按配置传入，开启后**仍要求命中白名单**，不是无条件放行。
 */
export function assertOutboundAllowed(target: string, options?: { allowPrivate?: boolean }): OutboundTarget {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new BadRequestError('插件地址不是合法 URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BadRequestError('插件地址只支持 http 与 https');
  }
  const host = url.hostname.toLowerCase();
  const allowPrivate = options?.allowPrivate ?? config.plugins.allowPrivateNetworks;
  if (isPrivateHost(host) && !allowPrivate) {
    throw new ForbiddenError(
      `出于安全考虑，默认拒绝本机与内网地址（${host}）。确需连接本机服务请设置 PLUGINS_ALLOW_PRIVATE_NETWORKS=true 并把该地址加入 PLUGINS_ALLOWED_HOSTS`,
    );
  }
  const allowed = config.plugins.allowedHosts;
  if (!allowed.length) {
    throw new ForbiddenError('插件出站白名单为空，已拒绝全部地址。请在 PLUGINS_ALLOWED_HOSTS 中显式授权域名');
  }
  if (!allowed.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    throw new ForbiddenError(`地址 ${host} 不在插件白名单内。已授权：${allowed.join('、')}`);
  }
  return { url, host };
}

export interface OutboundResult { ok: boolean; status: number; text: string; headers: Record<string, string> }

/**
 * 发起插件请求。响应体积与超时都有上限，避免一个恶意/失控端点拖死进程。
 * 凭据由调用方注入 header，**不进入返回文本**，也不写审计。
 *
 * 重定向策略：默认 `error`（不跟随）。调用方可传 `manual` 自行处理，
 * 但**必须对每一跳重新过闸门**——否则白名单内的地址能用 302 把请求带到白名单外。
 * MCP 传输需要 manual（协议允许 3xx），故提供该选项；见 plugins.mcpPost。
 */
export async function outboundRequest(
  target: string,
  init: {
    method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; timeoutMs?: number;
    redirect?: 'error' | 'manual'; accept?: string;
  },
): Promise<OutboundResult> {
  const { url } = assertOutboundAllowed(target);
  const timeoutMs = Math.min(Math.max(init.timeoutMs ?? config.plugins.timeoutMs, 1000), 60_000);
  const response = await fetch(url, {
    method: init.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: init.accept ?? 'application/json',
      ...(init.headers ?? {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: init.redirect ?? 'error',
  });
  const limit = config.plugins.maxResponseBytes;
  const raw = await response.text();
  const text = raw.length > limit ? `${raw.slice(0, limit)}\n…（响应超过 ${limit} 字节已截断）` : raw;
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return { ok: response.ok, status: response.status, text, headers };
}