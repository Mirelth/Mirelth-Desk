import { useState } from 'react';
import { apiClient, getErrorMessage } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { PlatformPlugin, PlatformPluginRun, PlatformStatus } from '../../lib/types.ts';
import { Badge, Button, EmptyState, Field, IconButton, Modal, SectionTitle, formatDate, useToast } from '../../lib/ui.tsx';

interface ParameterDraft { name: string; type: 'string' | 'number' | 'boolean'; description: string; required: boolean }

interface PluginDraft {
  id?: string;
  name: string;
  description: string;
  endpoint: string;
  kind: 'http' | 'mcp';
  method: 'GET' | 'POST';
  authToken: string;
  confirmedRequired: boolean;
  parameters: ParameterDraft[];
}

const EMPTY: PluginDraft = {
  name: '', description: '', endpoint: '', kind: 'http', method: 'POST',
  authToken: '', confirmedRequired: false, parameters: [],
};

/**
 * 插件 tab：用户自配的声明式 HTTP 工具。
 * 与被它替代的「注册自定义工具」不同——落库、按工作区隔离、出站受白名单约束、凭据加密。
 */
export function PlatformPlugins({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const plugins = useLoad<PlatformPlugin[]>(() => apiClient.get<PlatformPlugin[]>('/api/platform/plugins'));
  const status = useLoad<PlatformStatus>(() => apiClient.get<PlatformStatus>('/api/platform/status'));
  const runs = useLoad<PlatformPluginRun[]>(() => apiClient.get<PlatformPluginRun[]>('/api/platform/plugins/runs'));

  const [draft, setDraft] = useState<PluginDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRuns, setShowRuns] = useState(false);

  const allowedHosts = status.data?.plugins?.allowedHosts ?? [];
  const allowPrivate = status.data?.plugins?.allowPrivateNetworks ?? false;

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.description.trim() || !draft.endpoint.trim()) {
      toast('名称、描述与地址都要填', 'error');
      return;
    }
    setBusy(true);
    try {
      const parameters: Record<string, { type: string; description: string; required?: boolean }> = {};
      for (const item of draft.parameters) {
        if (!item.name.trim()) continue;
        parameters[item.name.trim()] = {
          type: item.type, description: item.description,
          ...(item.required ? { required: true } : {}),
        };
      }
      const payload = {
        name: draft.name.trim(), description: draft.description.trim(),
        endpoint: draft.endpoint.trim(), kind: draft.kind, method: draft.method,
        // MCP 插件的入参由远端 schema 决定，本地声明无意义。
        ...(draft.kind === 'mcp' ? {} : { parameters }),
        confirmedRequired: draft.confirmedRequired,
        // 编辑时留空＝不改凭据；新建时留空＝不配凭据。
        ...(draft.authToken ? { authToken: draft.authToken } : {}),
      };
      if (draft.id) await apiClient.patch(`/api/platform/plugins/${draft.id}`, payload);
      else await apiClient.post('/api/platform/plugins', payload);
      setDraft(null);
      await Promise.all([plugins.reload(), status.reload()]);
      onChanged?.();
      toast('已保存', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await apiClient.delete(`/api/platform/plugins/${id}`);
      await Promise.all([plugins.reload(), status.reload()]);
      onChanged?.();
      toast('已删除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const toggle = async (plugin: PlatformPlugin) => {
    try {
      await apiClient.patch(`/api/platform/plugins/${plugin.id}`, { enabled: !plugin.enabled });
      await Promise.all([plugins.reload(), status.reload()]);
      onChanged?.();
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const test = async (id: string) => {
    setBusy(true);
    try {
      const result = await apiClient.post<{ ok: boolean; detail: string }>(`/api/platform/plugins/${id}/test`, {});
      toast(result.detail, result.ok ? 'success' : 'error');
      await plugins.reload();
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const updateParameter = (index: number, patch: Partial<ParameterDraft>) => {
    if (!draft) return;
    const next = draft.parameters.map((item, position) => (position === index ? { ...item, ...patch } : item));
    setDraft({ ...draft, parameters: next });
  };

  return (
    <div>
      <SectionTitle
        title="插件"
        hint="把外部接口接成智能体工具。落库保存、按工作区隔离，出站需显式授权域名"
        action={
          <div className="row">
            <Button variant="ghost" size="sm" icon="clock" onClick={() => { setShowRuns(!showRuns); void runs.reload(); }}>
              {showRuns ? '收起记录' : '调用记录'}
            </Button>
            <Button size="sm" icon="plus" onClick={() => setDraft({ ...EMPTY, parameters: [] })}>新建插件</Button>
          </div>
        }
      />

      <div className="card card-pad mb-12">
        <div className="text-xs muted">
          出站白名单：{allowedHosts.length ? allowedHosts.join('、') : '空（已拒绝全部地址）'}
          {' · '}本机与内网地址：{allowPrivate ? '已允许（仍需在白名单内）' : '默认拒绝'}
        </div>
        {!allowedHosts.length && (
          <div className="text-xs mt-8">
            要新增插件，先在 .env 的 PLUGINS_ALLOWED_HOSTS 中授权目标域名；连本机服务还需 PLUGINS_ALLOW_PRIVATE_NETWORKS=true，然后重启服务。
          </div>
        )}
      </div>

      {plugins.error && <div className="text-xs muted mb-12">{plugins.error}</div>}
      {(plugins.data ?? []).length ? (
        <div className="grid-2">
          {(plugins.data ?? []).map((plugin) => (
            <div key={plugin.id} className="card card-pad">
              <div className="row wrap mb-8">
                <strong>{plugin.displayName || plugin.name}</strong>
                <Badge tone={plugin.kind === 'mcp' ? 'violet' : 'neutral'}>{plugin.kind === 'mcp' ? 'MCP' : 'HTTP'}</Badge>
                <Badge tone={plugin.enabled ? 'green' : 'neutral'}>{plugin.enabled ? '启用' : '停用'}</Badge>
                <Badge tone={plugin.status === 'connected' ? 'green' : plugin.status === 'error' ? 'rose' : 'neutral'}>
                  {plugin.status === 'connected' ? '连通' : plugin.status === 'error' ? '异常' : '未测试'}
                </Badge>
                {plugin.confirmedRequired ? <Badge tone="amber">需确认</Badge> : null}
                {plugin.hasToken ? <Badge tone="blue">已配凭据</Badge> : null}
                <span className="grow" />
                <IconButton icon="bolt" title="测试连通性" onClick={() => void test(plugin.id)} />
                <IconButton icon="edit" title="编辑" onClick={() => setDraft({
                  id: plugin.id, name: plugin.name, description: plugin.description,
                  endpoint: plugin.endpoint, kind: plugin.kind === 'mcp' ? 'mcp' : 'http',
                  method: plugin.method === 'GET' ? 'GET' : 'POST',
                  authToken: '', confirmedRequired: plugin.confirmedRequired,
                  parameters: Object.entries(plugin.parameters ?? {}).map(([name, spec]) => ({
                    name, type: spec.type, description: spec.description, required: Boolean(spec.required),
                  })),
                })} />
                <IconButton icon="trash" title="删除" onClick={() => void remove(plugin.id)} />
              </div>
              <div className="text-xs muted mb-8">{plugin.description}</div>
              <div className="text-xs muted mb-8">工具名：{plugin.name} · {plugin.method} {plugin.endpoint}</div>
              <div className="text-xs muted mb-8">
                入参：{Object.keys(plugin.parameters ?? {}).length ? Object.keys(plugin.parameters).join('、') : '无'}
              </div>
              {plugin.lastError ? <div className="text-xs mb-8">最近错误：{plugin.lastError}</div> : null}
              <div className="row">
                <span className="text-xs muted grow">创建于 {formatDate(plugin.createdAt)}</span>
                <Button variant="ghost" size="sm" onClick={() => void toggle(plugin)}>
                  {plugin.enabled ? '停用' : '启用'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : <EmptyState icon="bolt" title="还没有插件" hint="插件让智能体调用你自己的接口。只发声明过的入参，凭据由服务端注入，不会交给模型。" />}

      {showRuns && (
        <div className="card card-pad mt-12">
          <h4 className="mb-12">调用记录</h4>
          {runs.data?.length ? (
            <div className="stack-sm" style={{ maxHeight: 280, overflowY: 'auto' }}>
              {runs.data.map((run) => (
                <div key={run.id} className="text-xs muted">
                  · {formatDate(run.created_at)} {run.tool_name} → {run.host || '（未发出）'}
                  {' '}[{run.status}] {run.detail} · {run.duration_ms}ms
                </div>
              ))}
            </div>
          ) : <div className="text-xs muted">还没有调用记录。</div>}
        </div>
      )}

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? '编辑插件' : '新建插件'}
        subtitle="只支持声明式 HTTP 调用，不执行任何代码；地址必须在出站白名单内"
        footer={<><Button variant="ghost" onClick={() => setDraft(null)}>取消</Button><Button loading={busy} onClick={() => void save()}>保存</Button></>}
      >
        {draft && (
          <div className="stack-sm">
            <Field label="工具名" hint="模型看到的名字，字母数字下划线连字符，不能与内置工具重名">
              <input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="描述" hint="写清楚它做什么，模型据此决定何时调用">
              <input className="input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </Field>
            <Field label="类型" hint="HTTP：单个接口；MCP：连接外部 MCP 服务器，自动引入它的工具">
              <select className="input" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as 'http' | 'mcp' })}>
                <option value="http">HTTP 接口</option>
                <option value="mcp">MCP 服务器</option>
              </select>
            </Field>
            <Field label="地址" hint={draft.kind === 'mcp' ? 'MCP 端点（Streamable HTTP），域名需在白名单内' : 'http/https，且域名需在 PLUGINS_ALLOWED_HOSTS 中授权'}>
              <input className="input" placeholder="https://…" value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} />
            </Field>
            {draft.kind === 'http' && (
              <Field label="方法">
                <select className="input" value={draft.method} onChange={(event) => setDraft({ ...draft, method: event.target.value as 'GET' | 'POST' })}>
                  <option value="POST">POST（入参放请求体）</option>
                  <option value="GET">GET（仅探活式调用，不发送入参）</option>
                </select>
              </Field>
            )}
            <Field label="凭据 Token" hint={draft.id ? '留空表示不修改；填入则覆盖。加密存储，不回显也不交给模型' : '可留空。加密存储，由服务端注入请求头'}>
              <input className="input" type="password" value={draft.authToken} onChange={(event) => setDraft({ ...draft, authToken: event.target.value })} />
            </Field>
            <Field label="敏感操作" hint="有外部副作用（下单、发信、写入）时勾选：调用必须人工确认">
              <label className="row text-sm">
                <input type="checkbox" checked={draft.confirmedRequired} onChange={(event) => setDraft({ ...draft, confirmedRequired: event.target.checked })} />
                <span>调用前需人工确认</span>
              </label>
            </Field>
            {draft.kind === 'mcp' ? (
              <Field label="远端工具" hint="保存后点「测试连通性」完成握手并查看引入了哪些工具">
                <div className="text-xs muted">
                  工具名会是 plug_{draft.name || '插件名'}_&lt;远端工具名&gt;。远端说明按外部数据处理并截断，不可达时这些工具不会出现在候选里。
                </div>
              </Field>
            ) : (
            <Field label="入参" hint="只有声明过的字段会外发，最多 12 个">
              <div className="stack-sm">
                {draft.parameters.map((item, index) => (
                  <div key={index} className="row wrap">
                    <input className="input" style={{ width: 120 }} placeholder="名称" value={item.name}
                      onChange={(event) => updateParameter(index, { name: event.target.value })} />
                    <select className="input" style={{ width: 100 }} value={item.type}
                      onChange={(event) => updateParameter(index, { type: event.target.value as ParameterDraft['type'] })}>
                      <option value="string">文本</option>
                      <option value="number">数字</option>
                      <option value="boolean">布尔</option>
                    </select>
                    <input className="input grow" placeholder="说明" value={item.description}
                      onChange={(event) => updateParameter(index, { description: event.target.value })} />
                    <label className="row text-xs">
                      <input type="checkbox" checked={item.required} onChange={(event) => updateParameter(index, { required: event.target.checked })} />
                      <span>必填</span>
                    </label>
                    <IconButton icon="trash" title="移除" onClick={() => setDraft({ ...draft, parameters: draft.parameters.filter((_, position) => position !== index) })} />
                  </div>
                ))}
                <Button variant="ghost" size="sm" icon="plus"
                  onClick={() => setDraft({ ...draft, parameters: [...draft.parameters, { name: '', type: 'string', description: '', required: false }] })}>
                  添加入参
                </Button>
              </div>
            </Field>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}