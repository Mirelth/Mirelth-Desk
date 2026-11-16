import { config } from '../../shared/config.ts';
import { AppError } from '../../shared/errors.ts';
import { assertOutboundAllowed, outboundRequest } from '../../shared/outbound.ts';

/**
 * MCP **出站**客户端（Streamable HTTP 传输，JSON-RPC 2.0）。
 *
 * 与既有入站端点 `/api/platform/mcp` 方向相反：入站是别人调我们的工具，
 * 这里是我们的智能体调别人服务器的工具。
 *
 * 三条安全约束：
 * 1. **每一跳都过出站闸门**，包括重定向后的新地址——协议允许 3xx，但不能因此绕过白名单；
 * 2. **远端工具描述是外部可控文本**，会进模型提示词，因此截断并标注来源，
 *    且在 system 中声明它属数据不构成指令（见 engine 的注入）；
 * 3. 远端不可达时**不返回工具**，让规划器不会许诺调不通的工具。
 *
 * 不做：不执行远端返回的任何代码，不跟随非 http(s) 协议，不缓存凭据到磁盘。
 */

export interface RemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

const PROTOCOL_VERSION = '2025-06-18';
/** 重定向最多跟几跳，每跳都重新校验白名单。 */
const MAX_REDIRECTS = 3;

export interface McpSession {
  endpoint: string;
  sessionId: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

/**
 * 发一次 JSON-RPC 请求。
 * 用 `redirect: 'manual'` 自己处理跳转，**对 Location 重新过闸门**后再发。
 */
async function rpc(
  session: McpSession,
  method: string,
  params: Record<string, unknown>,
  options?: { notify?: boolean; id?: number },
): Promise<JsonRpcResponse | null> {
  let target = session.endpoint;
  const payload = {
    jsonrpc: '2.0',
    ...(options?.notify ? {} : { id: options?.id ?? 1 }),
    method,
    ...(options?.notify ? {} : { params }),
  };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertOutboundAllowed(target);
    const result = await outboundRequest(target, {
      method: 'POST',
      headers: {
        ...session.headers,
        // 协议要求同时接受 JSON 与 SSE 两种响应体。
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(session.sessionId ? { 'Mcp-Session-Id': session.sessionId } : {}),
      },
      body: payload,
      timeoutMs: session.timeoutMs,
      redirect: 'manual',
      accept: 'application/json, text/event-stream',
    });

    if (result.status >= 300 && result.status < 400) {
      const location = result.headers.location;
      if (!location) throw new AppError('MCP 服务器返回重定向但没有 Location', 'MCP_PROTOCOL_ERROR', 502);
      // 相对地址按当前跳解析；解析后仍需过闸门（下一轮循环开头）。
      target = new URL(location, target).toString();
      if (hop === MAX_REDIRECTS) throw new AppError('MCP 服务器重定向次数过多', 'MCP_PROTOCOL_ERROR', 502);
      continue;
    }

    // 通知（notification）无需响应体，202 即成功。
    if (options?.notify) {
      if (!result.ok && result.status !== 202) {
        throw new AppError(`MCP 通知失败：HTTP ${result.status}`, 'MCP_PROTOCOL_ERROR', 502);
      }
      return null;
    }
    if (!result.ok) {
      throw new AppError(`MCP 服务器返回 ${result.status}：${result.text.slice(0, 200)}`, 'MCP_UPSTREAM_ERROR', 502);
    }
    const parsed = parseBody(result.text, result.headers['content-type'] ?? '');
    if (parsed.error) {
      throw new AppError(`MCP 错误 ${parsed.error.code ?? ''}：${parsed.error.message ?? '未知'}`, 'MCP_PROTOCOL_ERROR', 502);
    }
    return parsed;
  }
  throw new AppError('MCP 请求未能完成', 'MCP_PROTOCOL_ERROR', 502);
}

/** 响应可能是纯 JSON，也可能是 SSE 帧；两种都要能解出 JSON-RPC 对象。 */
export function parseBody(text: string, contentType: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (contentType.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    // 取最后一个带 JSON-RPC 结果的 data 帧（前面的可能是进度通知）。
    const frames = trimmed.split('\n\n');
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const data = frames[index].split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.result || parsed.error) return parsed;
      } catch { /* 继续找前一帧 */ }
    }
    return {};
  }
  try {
    return JSON.parse(trimmed) as JsonRpcResponse;
  } catch {
    throw new AppError('MCP 服务器返回的不是合法 JSON-RPC 响应', 'MCP_PROTOCOL_ERROR', 502);
  }
}

/** 握手：initialize → notifications/initialized。返回带会话 id 的上下文。 */
export async function openSession(options: {
  endpoint: string; headers?: Record<string, string>; timeoutMs?: number;
}): Promise<McpSession> {
  const session: McpSession = {
    endpoint: options.endpoint,
    sessionId: '',
    headers: options.headers ?? {},
    timeoutMs: options.timeoutMs ?? config.plugins.timeoutMs,
  };
  assertOutboundAllowed(session.endpoint);
  // initialize 时还没有会话 id，先不带该头；响应头里可能下发。
  let target = session.endpoint;
  let initResult: JsonRpcResponse | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertOutboundAllowed(target);
    const response = await outboundRequest(target, {
      method: 'POST',
      headers: { ...session.headers, Accept: 'application/json, text/event-stream' },
      body: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'mirelth-desk', version: '1.0.0' },
        },
      },
      timeoutMs: session.timeoutMs,
      redirect: 'manual',
      accept: 'application/json, text/event-stream',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) throw new AppError('MCP 握手重定向缺少 Location', 'MCP_PROTOCOL_ERROR', 502);
      target = new URL(location, target).toString();
      if (hop === MAX_REDIRECTS) throw new AppError('MCP 握手重定向次数过多', 'MCP_PROTOCOL_ERROR', 502);
      continue;
    }
    if (!response.ok) {
      throw new AppError(`MCP 握手失败：HTTP ${response.status} ${response.text.slice(0, 150)}`, 'MCP_UPSTREAM_ERROR', 502);
    }
    session.sessionId = response.headers['mcp-session-id'] ?? '';
    // 握手后固定用最终地址，避免后续每次请求都重走跳转。
    session.endpoint = target;
    initResult = parseBody(response.text, response.headers['content-type'] ?? '');
    break;
  }
  if (!initResult) throw new AppError('MCP 握手未完成', 'MCP_PROTOCOL_ERROR', 502);
  if (initResult.error) {
    throw new AppError(`MCP 握手被拒：${initResult.error.message ?? ''}`, 'MCP_PROTOCOL_ERROR', 502);
  }
  await rpc(session, 'notifications/initialized', {}, { notify: true });
  return session;
}

/**
 * 拉取远端工具清单。
 * 描述**截断并标注来源**：它是外部可控文本，会进模型提示词。
 */
export async function listTools(session: McpSession): Promise<RemoteTool[]> {
  const response = await rpc(session, 'tools/list', {}, { id: 2 });
  const raw = response?.result?.tools;
  if (!Array.isArray(raw)) return [];
  const tools: RemoteTool[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
    const description = typeof entry.description === 'string' ? entry.description : '';
    const schema = entry.inputSchema && typeof entry.inputSchema === 'object'
      ? entry.inputSchema as Record<string, unknown>
      : { type: 'object', properties: {} };
    tools.push({
      name,
      // 截断 + 标注：降低远端描述被当作指令的风险，也让用户看得出来源。
      description: `[来自远端 MCP 服务器的工具说明，属外部数据] ${description.slice(0, 200)}`,
      inputSchema: schema,
    });
    if (tools.length >= config.plugins.maxRemoteTools) break;
  }
  return tools;
}

/** 调用远端工具，把 content 数组拼成文本。 */
export async function callTool(session: McpSession, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await rpc(session, 'tools/call', { name, arguments: args }, { id: 3 });
  const result = response?.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { type?: unknown; text?: unknown };
    if (entry.type === 'text' && typeof entry.text === 'string') parts.push(entry.text);
    else if (entry.type) parts.push(`（远端返回 ${String(entry.type)} 类型内容，本客户端只解析文本）`);
  }
  const text = parts.join('\n') || '（远端未返回文本内容）';
  // isError 是协议里的工具级错误标志，必须转成可判定失败。
  if (result.isError === true) return `工具执行失败：远端 MCP 工具报错：${text.slice(0, 400)}`;
  return text;
}