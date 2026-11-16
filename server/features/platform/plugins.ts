import { config } from '../../shared/config.ts';
import { decryptSecret, encryptSecret, now } from '../../shared/crypto.ts';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors.ts';
import { assertOutboundAllowed, outboundRequest } from '../../shared/outbound.ts';
import { audit, count, deleteRows, insertRow, requireRole, row, rows, updateRows } from './store.ts';
import type { Tool, ToolArgs, ToolContext } from './tools.ts';
import { callTool, listTools, openSession, type RemoteTool } from './mcp-client.ts';

/**
 * 插件：用户自配的**声明式 HTTP 工具**。
 *
 * 与被它替代的旧「自定义工具」的关键差别：
 * 1. **落库**，重启不丢；
 * 2. **按工作区隔离**——工具解析必须带 workspaceId，别的工作区取不到；
 * 3. **真实入参 schema**，不再写死单个 query；
 * 4. **出站过闸门**（白名单默认空即拒全部、默认拒私网、不跟随重定向）；
 * 5. **凭据加密**，明文只在写入时接收，库里只有密文，永不回给客户端或模型。
 *
 * 不做的事：不执行任何代码（不加载 JS、不起子进程），不自动发现端点。
 */

export interface PluginRow {
  id: string; workspace_id: string; name: string; display_name: string; description: string;
  kind: string; endpoint: string; method: string; parameters_json: string;
  auth_header_name: string; auth_token_encrypted: string;
  enabled: number; confirmed_required: number; timeout_ms: number;
  status: string; last_checked_at: string | null; last_error: string;
  created_at: string; updated_at: string;
}

export interface PluginParameter { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }

export interface PluginInput {
  name: string;
  displayName?: string;
  description: string;
  endpoint: string;
  kind?: 'http' | 'mcp';
  method?: 'GET' | 'POST';
  parameters?: Record<string, PluginParameter>;
  authHeaderName?: string;
  authToken?: string;
  confirmedRequired?: boolean;
  timeoutMs?: number;
  enabled?: boolean;
}

/** 工具名规则与内置工具一致（tools.ts 的 registerTool 同一口径）。 */
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function assertSystemEnabled(): void {
  if (!config.plugins.enabled) {
    throw new ForbiddenError('插件体系未启用。请在 .env 设置 PLUGINS_ENABLED=true 后重启服务');
  }
}

/** 入参 schema 收敛：只允许三种标量类型，杜绝把任意 JSON Schema 透传给模型。 */
function normalizeParameters(input?: Record<string, PluginParameter>): Record<string, PluginParameter> {
  const entries = Object.entries(input ?? {});
  if (entries.length > 12) throw new BadRequestError('插件入参最多 12 个');
  const result: Record<string, PluginParameter> = {};
  for (const [key, value] of entries) {
    if (!NAME_PATTERN.test(key)) throw new BadRequestError(`入参名不合法：${key}`);
    const type = value?.type;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new BadRequestError(`入参 ${key} 的类型只能是 string / number / boolean`);
    }
    result[key] = {
      type,
      description: String(value.description ?? '').slice(0, 200),
      ...(value.required ? { required: true } : {}),
    };
  }
  return result;
}

function toSchema(parameters: Record<string, PluginParameter>): Tool['parameters'] {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(parameters)) {
    properties[key] = { type: value.type, description: value.description };
    if (value.required) required.push(key);
  }
  // confirmed 由门禁注入，所有插件都接受它，敏感插件必须带。
  properties.confirmed = { type: 'boolean', description: '敏感操作的人工确认标记；有外部副作用时必须为 true' };
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function parseParameters(raw: string): Record<string, PluginParameter> {
  try {
    const parsed = JSON.parse(raw) as Record<string, PluginParameter>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 回给客户端的形状：**不含密文、不含 token**，只说有没有配凭据。 */
function dto(plugin: PluginRow) {
  const parameters = parseParameters(plugin.parameters_json);
  return {
    id: plugin.id, name: plugin.name, displayName: plugin.display_name,
    description: plugin.description, kind: plugin.kind, endpoint: plugin.endpoint,
    method: plugin.method, parameters,
    authHeaderName: plugin.auth_header_name, hasToken: Boolean(plugin.auth_token_encrypted),
    enabled: Boolean(plugin.enabled), confirmedRequired: Boolean(plugin.confirmed_required),
    timeoutMs: plugin.timeout_ms, status: plugin.status,
    lastCheckedAt: plugin.last_checked_at, lastError: plugin.last_error,
    createdAt: plugin.created_at, updatedAt: plugin.updated_at,
  };
}

function record(plugin: PluginRow, ctx: ToolContext, host: string, status: string, detail: string, durationMs: number): void {
  insertRow('plugin_runs', {
    workspace_id: ctx.workspaceId, plugin_id: plugin.id, user_id: ctx.userId,
    tool_name: plugin.name, host: host.slice(0, 200), status,
    detail: detail.slice(0, 500), duration_ms: durationMs,
  });
}

/**
 * 把一行插件变成可执行工具。
 * 失败**返回带固定前缀的字符串**（与 tools.ts 的 executeTool 同口径），
 * 让规划层的 isFailure 能判定，而不是把失败混进正常输出。
 */
function toTool(plugin: PluginRow): Tool {
  const parameters = parseParameters(plugin.parameters_json);
  return {
    name: plugin.name,
    description: plugin.description || plugin.display_name || plugin.name,
    category: 'custom',
    parameters: toSchema(parameters),
    run: async (ctx, args: ToolArgs) => {
      const started = Date.now();
      if (!plugin.enabled) return `工具执行失败：插件 ${plugin.name} 已停用`;
      if (plugin.confirmed_required && args.confirmed !== true) {
        record(plugin, ctx, '', 'blocked', '敏感插件缺少人工确认', Date.now() - started);
        throw new ForbiddenError(`插件「${plugin.name}」有外部副作用，需人工确认后才能调用（confirmed=true）`);
      }
      // 只取声明过的入参：多余字段不外发，避免把上下文里的其他内容顺带传出去。
      const payload: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(parameters)) {
        const value = args[key];
        if (value === undefined) {
          if (spec.required) return `工具执行失败：插件 ${plugin.name} 缺少必填入参 ${key}`;
          continue;
        }
        if (spec.type === 'number') {
          const num = Number(value);
          if (!Number.isFinite(num)) return `工具执行失败：入参 ${key} 需要数字`;
          payload[key] = num;
        } else if (spec.type === 'boolean') {
          payload[key] = value === true || value === 'true';
        } else {
          payload[key] = String(value).slice(0, 8000);
        }
      }

      let host = '';
      try {
        host = assertOutboundAllowed(plugin.endpoint).host;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        record(plugin, ctx, '', 'blocked', detail, Date.now() - started);
        return `工具执行失败：${detail}`;
      }

      const headers: Record<string, string> = {};
      if (plugin.auth_token_encrypted) {
        try {
          headers[plugin.auth_header_name || 'Authorization'] =
            plugin.auth_header_name ? decryptSecret(plugin.auth_token_encrypted) : `Bearer ${decryptSecret(plugin.auth_token_encrypted)}`;
        } catch {
          // 不静默跳过：少发凭据会把「凭据坏了」表现成对方的 401（连接器已有此教训）。
          const detail = '插件凭据解密失败，请重新填写 Token';
          updateRows('plugins', { status: 'error', last_error: detail, last_checked_at: now() }, 'id = ?', [plugin.id]);
          record(plugin, ctx, host, 'error', detail, Date.now() - started);
          return `工具执行失败：${detail}`;
        }
      }

      try {
        const result = await outboundRequest(plugin.endpoint, {
          method: plugin.method === 'GET' ? 'GET' : 'POST',
          headers,
          ...(plugin.method === 'GET' ? {} : { body: payload }),
          timeoutMs: plugin.timeout_ms,
        });
        const detail = `HTTP ${result.status}`;
        record(plugin, ctx, host, result.ok ? 'success' : 'error', detail, Date.now() - started);
        updateRows('plugins', {
          status: result.ok ? 'connected' : 'error',
          last_checked_at: now(), last_error: result.ok ? '' : detail,
        }, 'id = ?', [plugin.id]);
        return result.ok ? result.text : `工具执行失败：插件返回 ${result.status}：${result.text.slice(0, 300)}`;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        record(plugin, ctx, host, 'error', detail, Date.now() - started);
        updateRows('plugins', { status: 'error', last_checked_at: now(), last_error: detail.slice(0, 300) }, 'id = ?', [plugin.id]);
        return `工具执行失败：${detail.slice(0, 300)}`;
      }
    },
  };
}

/**
 * 远端工具清单缓存。
 *
 * 为什么必须缓存：不缓存的话每轮对话都要向远端拉一次 tools/list，
 * 既慢又可能因远端抖动让工具清单忽有忽无。缓存是**进程内**的，重启即失效，
 * 且提供显式刷新（连通性测试会清掉对应条目）。
 */
const remoteCache = new Map<string, { at: number; tools: RemoteTool[] }>();

function cacheKey(plugin: PluginRow): string {
  return `${plugin.id}:${plugin.updated_at}`;
}

/** 解密并组装远端请求头。失败即抛，不静默降级成无凭据请求。 */
function remoteHeaders(plugin: PluginRow): Record<string, string> {
  if (!plugin.auth_token_encrypted) return {};
  const token = decryptSecret(plugin.auth_token_encrypted);
  return { [plugin.auth_header_name || 'Authorization']: plugin.auth_header_name ? token : `Bearer ${token}` };
}

/**
 * 把一个 MCP 插件展开成多个本地工具。
 *
 * 命名空间 `plug_<插件名>_<远端名>`：避免与内置工具或其他插件撞名。
 * 远端不可达时**返回空数组**并记 last_error——不让规划器许诺调不通的工具。
 */
async function mcpTools(plugin: PluginRow): Promise<Tool[]> {
  const key = cacheKey(plugin);
  const cached = remoteCache.get(key);
  let remote: RemoteTool[];
  if (cached && config.plugins.remoteCacheMs > 0 && Date.now() - cached.at < config.plugins.remoteCacheMs) {
    remote = cached.tools;
  } else {
    try {
      const session = await openSession({
        endpoint: plugin.endpoint, headers: remoteHeaders(plugin), timeoutMs: plugin.timeout_ms,
      });
      remote = await listTools(session);
      remoteCache.set(key, { at: Date.now(), tools: remote });
      updateRows('plugins', { status: 'connected', last_checked_at: now(), last_error: '' }, 'id = ?', [plugin.id]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      updateRows('plugins', { status: 'error', last_checked_at: now(), last_error: detail.slice(0, 300) }, 'id = ?', [plugin.id]);
      // 不可达：不返回工具。清单里宁可少一个，也不要给模型一个调不通的选项。
      return [];
    }
  }

  return remote.map((tool) => {
    const localName = `plug_${plugin.name}_${tool.name}`.slice(0, 64);
    return {
      name: localName,
      description: tool.description,
      category: 'custom' as const,
      parameters: normalizeRemoteSchema(tool.inputSchema),
      run: async (ctx: ToolContext, args: ToolArgs) => {
        const started = Date.now();
        if (plugin.confirmed_required && args.confirmed !== true) {
          record(plugin, ctx, '', 'blocked', '敏感 MCP 工具缺少人工确认', Date.now() - started);
          throw new ForbiddenError(`插件「${plugin.name}」有外部副作用，需人工确认后才能调用（confirmed=true）`);
        }
        let host = '';
        try {
          host = assertOutboundAllowed(plugin.endpoint).host;
          const session = await openSession({
            endpoint: plugin.endpoint, headers: remoteHeaders(plugin), timeoutMs: plugin.timeout_ms,
          });
          // confirmed 是本地门禁标记，不传给远端。
          const { confirmed: _confirmed, ...remoteArgs } = args;
          const output = await callTool(session, tool.name, remoteArgs);
          const failed = output.startsWith('工具执行失败：');
          record(plugin, ctx, host, failed ? 'error' : 'success', `MCP ${tool.name}`, Date.now() - started);
          return output;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          record(plugin, ctx, host, 'error', detail, Date.now() - started);
          return `工具执行失败：${detail.slice(0, 300)}`;
        }
      },
    };
  });
}

/**
 * 远端 inputSchema 收敛成本地工具 schema。
 *
 * 只取 object 的 properties 与 required，且**只保留三种标量**——
 * 远端 schema 是外部可控数据，不能原样透传给模型（可能含超大嵌套或注入性描述）。
 */
function normalizeRemoteSchema(schema: Record<string, unknown>): Tool['parameters'] {
  const properties: Record<string, { type: string; description: string }> = {};
  const rawProps = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, Record<string, unknown>>
    : {};
  let count = 0;
  for (const [key, spec] of Object.entries(rawProps)) {
    if (count >= 12) break;
    if (!NAME_PATTERN.test(key)) continue;
    const type = spec?.type === 'number' || spec?.type === 'integer' ? 'number'
      : spec?.type === 'boolean' ? 'boolean' : 'string';
    properties[key] = { type, description: String(spec?.description ?? '').slice(0, 200) };
    count += 1;
  }
  properties.confirmed = { type: 'boolean', description: '敏感操作的人工确认标记；有外部副作用时必须为 true' };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string' && Boolean(properties[item]) && item !== 'confirmed')
    : [];
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

export const pluginsService = {
  /**
   * 按工作区取启用的插件工具——**这是隔离的落点**，不带工作区就一个也不返回。
   * MCP 插件需要网络握手，故本函数是异步的。
   */
  async toolsFor(workspaceId: string): Promise<Tool[]> {
    if (!config.plugins.enabled || !workspaceId) return [];
    const list = rows<PluginRow>('plugins', 'workspace_id = ? AND enabled = 1', [workspaceId], 'created_at ASC');
    const result: Tool[] = [];
    for (const plugin of list) {
      if (plugin.kind === 'mcp') result.push(...await mcpTools(plugin));
      else result.push(toTool(plugin));
    }
    return result;
  },

  /** 显式刷新某插件的远端工具清单（连通性测试与界面刷新用）。 */
  invalidateRemote(pluginId: string): void {
    for (const key of remoteCache.keys()) {
      if (key.startsWith(`${pluginId}:`)) remoteCache.delete(key);
    }
  },

  list(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows<PluginRow>('plugins', 'workspace_id = ?', [workspaceId], 'created_at DESC').map(dto);
  },

  create(userId: string, workspaceId: string, input: PluginInput, builtinNames: string[]) {
    requireRole(workspaceId, userId, 'admin');
    assertSystemEnabled();
    if (!NAME_PATTERN.test(input.name)) throw new BadRequestError('插件名只允许字母、数字、下划线与连字符，长度 1–64');
    if (builtinNames.includes(input.name)) throw new BadRequestError(`插件名与内置工具「${input.name}」冲突，请换一个`);
    if (row('plugins', 'workspace_id = ? AND name = ?', [workspaceId, input.name])) {
      throw new BadRequestError('本工作区已有同名插件');
    }
    if (count('plugins', 'workspace_id = ?', [workspaceId]) >= config.plugins.maxPerWorkspace) {
      throw new BadRequestError(`单工作区插件数量已达上限（${config.plugins.maxPerWorkspace}）`);
    }
    // 注册时就校验地址：不合法/未授权的地址不许落库，避免留下一个永远调不通的工具。
    assertOutboundAllowed(input.endpoint);
    const parameters = normalizeParameters(input.parameters);
    const id = insertRow('plugins', {
      workspace_id: workspaceId, name: input.name,
      display_name: input.displayName ?? input.name, description: input.description,
      kind: input.kind === 'mcp' ? 'mcp' : 'http',
      endpoint: input.endpoint, method: input.method === 'GET' ? 'GET' : 'POST',
      parameters_json: JSON.stringify(parameters),
      auth_header_name: input.authHeaderName ?? '',
      auth_token_encrypted: input.authToken ? encryptSecret(input.authToken) : '',
      enabled: input.enabled === false ? 0 : 1,
      confirmed_required: input.confirmedRequired ? 1 : 0,
      timeout_ms: Math.min(Math.max(input.timeoutMs ?? config.plugins.timeoutMs, 1000), 60_000),
      updated_at: now(),
    });
    audit(workspaceId, userId, 'plugin.create', id, input.name);
    return dto(row<PluginRow>('plugins', 'id = ?', [id])!);
  },

  update(userId: string, workspaceId: string, id: string, patch: Partial<PluginInput>, builtinNames: string[]) {
    requireRole(workspaceId, userId, 'admin');
    const current = row<PluginRow>('plugins', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    if (!current) throw new NotFoundError('插件', id);
    const mapped: Record<string, unknown> = { updated_at: now() };
    if (patch.name !== undefined) {
      if (!NAME_PATTERN.test(patch.name)) throw new BadRequestError('插件名不合法');
      if (builtinNames.includes(patch.name)) throw new BadRequestError('插件名与内置工具冲突');
      const clash = row<{ id: string }>('plugins', 'workspace_id = ? AND name = ?', [workspaceId, patch.name]);
      if (clash && clash.id !== id) throw new BadRequestError('本工作区已有同名插件');
      mapped.name = patch.name;
    }
    if (patch.endpoint !== undefined) {
      assertOutboundAllowed(patch.endpoint);
      mapped.endpoint = patch.endpoint;
      mapped.status = 'untested';
      mapped.last_error = '';
    }
    if (patch.kind !== undefined) mapped.kind = patch.kind === 'mcp' ? 'mcp' : 'http';
    if (patch.displayName !== undefined) mapped.display_name = patch.displayName;
    if (patch.description !== undefined) mapped.description = patch.description;
    if (patch.method !== undefined) mapped.method = patch.method === 'GET' ? 'GET' : 'POST';
    if (patch.parameters !== undefined) mapped.parameters_json = JSON.stringify(normalizeParameters(patch.parameters));
    if (patch.authHeaderName !== undefined) mapped.auth_header_name = patch.authHeaderName;
    // 空串＝清空凭据；undefined＝不动。与连接器同口径。
    if (patch.authToken !== undefined) mapped.auth_token_encrypted = patch.authToken ? encryptSecret(patch.authToken) : '';
    if (patch.confirmedRequired !== undefined) mapped.confirmed_required = patch.confirmedRequired ? 1 : 0;
    if (patch.enabled !== undefined) mapped.enabled = patch.enabled ? 1 : 0;
    if (patch.timeoutMs !== undefined) mapped.timeout_ms = Math.min(Math.max(patch.timeoutMs, 1000), 60_000);
    updateRows('plugins', mapped, 'id = ? AND workspace_id = ?', [id, workspaceId]);
    this.invalidateRemote(id);
    audit(workspaceId, userId, 'plugin.update', id, String(patch.name ?? current.name));
    return dto(row<PluginRow>('plugins', 'id = ?', [id])!);
  },

  remove(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'admin');
    const current = row<PluginRow>('plugins', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    if (!current) throw new NotFoundError('插件', id);
    deleteRows('plugins', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    audit(workspaceId, userId, 'plugin.delete', id, current.name);
    return { ok: true };
  },

  /** 连通性测试：GET 探活，不发送任何业务入参，避免测试本身产生副作用。 */
  async test(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'admin');
    const plugin = row<PluginRow>('plugins', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    if (!plugin) throw new NotFoundError('插件', id);
    this.invalidateRemote(id);

    // MCP 插件：GET 探活没有意义，必须走真实握手并报告发现了几个工具。
    if (plugin.kind === 'mcp') {
      try {
        const session = await openSession({
          endpoint: plugin.endpoint, headers: remoteHeaders(plugin), timeoutMs: plugin.timeout_ms,
        });
        const tools = await listTools(session);
        remoteCache.set(cacheKey(plugin), { at: Date.now(), tools });
        const detail = `握手成功，发现 ${tools.length} 个远端工具${tools.length ? `：${tools.map((tool) => tool.name).join('、').slice(0, 200)}` : ''}`;
        updateRows('plugins', { status: 'connected', last_checked_at: now(), last_error: '' }, 'id = ?', [id]);
        audit(workspaceId, userId, 'plugin.test', id, detail.slice(0, 120));
        return { ok: true, detail, tools: tools.length };
      } catch (error) {
        const detail = error instanceof AppError ? error.message : `MCP 连接失败：${error instanceof Error ? error.message : String(error)}`;
        updateRows('plugins', { status: 'error', last_checked_at: now(), last_error: detail.slice(0, 300) }, 'id = ?', [id]);
        audit(workspaceId, userId, 'plugin.test', id, detail.slice(0, 120));
        return { ok: false, detail, tools: 0 };
      }
    }

    const headers: Record<string, string> = {};
    if (plugin.auth_token_encrypted) {
      try {
        headers[plugin.auth_header_name || 'Authorization'] =
          plugin.auth_header_name ? decryptSecret(plugin.auth_token_encrypted) : `Bearer ${decryptSecret(plugin.auth_token_encrypted)}`;
      } catch {
        const detail = '插件凭据解密失败，请重新填写 Token';
        updateRows('plugins', { status: 'error', last_checked_at: now(), last_error: detail }, 'id = ?', [id]);
        return { ok: false, detail };
      }
    }
    try {
      const result = await outboundRequest(plugin.endpoint, { method: 'GET', headers, timeoutMs: plugin.timeout_ms });
      const detail = result.ok
        ? `${plugin.endpoint} 返回 HTTP ${result.status}`
        : result.status === 401 || result.status === 403
          ? `鉴权失败（HTTP ${result.status}），请检查 Token`
          : `地址可达但返回 HTTP ${result.status}`;
      updateRows('plugins', {
        status: result.ok ? 'connected' : 'error', last_checked_at: now(), last_error: result.ok ? '' : detail,
      }, 'id = ?', [id]);
      audit(workspaceId, userId, 'plugin.test', id, detail.slice(0, 120));
      return { ok: result.ok, detail, status: result.status };
    } catch (error) {
      const detail = error instanceof AppError ? error.message : `连接失败：${error instanceof Error ? error.message : String(error)}`;
      updateRows('plugins', { status: 'error', last_checked_at: now(), last_error: detail.slice(0, 300) }, 'id = ?', [id]);
      audit(workspaceId, userId, 'plugin.test', id, detail.slice(0, 120));
      return { ok: false, detail };
    }
  },

  runs(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows('plugin_runs', 'workspace_id = ?', [workspaceId], 'created_at DESC', 50);
  },

  status(workspaceId: string) {
    return {
      enabled: config.plugins.enabled,
      allowedHosts: config.plugins.allowedHosts,
      allowPrivateNetworks: config.plugins.allowPrivateNetworks,
      count: count('plugins', 'workspace_id = ?', [workspaceId]),
      note: config.plugins.allowedHosts.length
        ? '已授权部分域名；插件调用全程留痕，凭据加密存储。'
        : '出站白名单为空，已拒绝全部地址。请在 PLUGINS_ALLOWED_HOSTS 中显式授权域名。',
    };
  },
};