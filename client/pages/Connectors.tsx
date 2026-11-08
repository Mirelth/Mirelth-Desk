import { useState } from 'react';
import { apiClient, getErrorMessage } from '../lib/api.ts';
import { useLoad } from '../lib/hooks.ts';
import type { ConnectorDto } from '../lib/types.ts';
import { Badge, Button, EmptyState, ErrorBanner, Field, Icon, IconButton, Modal, Skeleton, formatDate, useToast } from '../lib/ui.tsx';

interface ConnectorForm {
  name: string; kind: string; baseUrl: string; description: string; token: string; enabled: boolean;
}

const EMPTY_FORM: ConnectorForm = {
  name: '', kind: 'webhook', baseUrl: 'https://', description: '', token: '', enabled: true,
};

const KIND_LABEL: Record<string, string> = {
  llm: 'AI 模型', mail: '邮箱服务', storage: '存储', webhook: 'Webhook', api: 'HTTP API', custom: '自定义',
};
const KIND_ICON: Record<string, 'sparkles' | 'mail' | 'folder' | 'external' | 'settings'> = {
  llm: 'sparkles', mail: 'mail', storage: 'folder', webhook: 'external', api: 'external', custom: 'settings',
};

function statusBadge(status: string) {
  if (status === 'connected') return <Badge tone="green">已连接</Badge>;
  if (status === 'error') return <Badge tone="rose">连接异常</Badge>;
  return <Badge tone="neutral">未连接</Badge>;
}

export function Connectors({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const connectors = useLoad<ConnectorDto[]>(() => apiClient.get<ConnectorDto[]>('/api/connectors'));
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectorForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const builtins = connectors.data?.filter((item) => item.builtin) ?? [];
  const custom = connectors.data?.filter((item) => !item.builtin) ?? [];
  const connectedCount = connectors.data?.filter((item) => item.status === 'connected').length ?? 0;

  const openCreate = () => { setEditingId(null); setForm(EMPTY_FORM); setFormOpen(true); };
  const openEdit = (item: ConnectorDto) => {
    setEditingId(item.id);
    setForm({ name: item.name, kind: item.kind, baseUrl: item.baseUrl, description: item.description, token: '', enabled: item.enabled });
    setFormOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) { toast('请填写连接器名称', 'error'); return; }
    setBusy(true);
    try {
      const body = { ...form, token: form.token || undefined };
      if (editingId) await apiClient.patch(`/api/connectors/${editingId}`, body);
      else await apiClient.post('/api/connectors', body);
      setFormOpen(false);
      await connectors.reload();
      onChanged?.();
      toast(editingId ? '连接器已更新' : '连接器已添加', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const test = async (item: ConnectorDto) => {
    setTestingId(item.id);
    try {
      const result = await apiClient.post<{ ok: boolean; detail: string }>(`/api/connectors/${item.id}/test`);
      await connectors.reload();
      toast(result.detail, result.ok ? 'success' : 'error');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setTestingId(null); }
  };

  const toggle = async (item: ConnectorDto) => {
    try {
      await apiClient.patch(`/api/connectors/${item.id}`, { enabled: !item.enabled });
      await connectors.reload();
      toast(item.enabled ? '已停用' : '已启用', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const remove = async (item: ConnectorDto) => {
    if (!window.confirm(`确定移除连接器「${item.name}」？`)) return;
    try {
      await apiClient.delete(`/api/connectors/${item.id}`);
      await connectors.reload();
      onChanged?.();
      toast('连接器已移除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>技能专家连接器</h1><p>统一查看模型、邮箱、本地存储与外部服务的接入状态</p></div>
        <div className="page-actions"><Button icon="plus" onClick={openCreate}>添加连接器</Button></div>
      </div>

      <div className="row wrap mb-16">
        <Badge tone="blue">{connectors.data?.length ?? 0} 个连接器</Badge>
        <Badge tone="green">{connectedCount} 个可用</Badge>
        <Badge tone="neutral">{builtins.length} 个内置</Badge>
        <span className="grow" />
        <span className="text-xs muted">内置连接器状态由系统实时读取；自定义连接器可测试 HTTP 连通性</span>
      </div>

      {connectors.error && <ErrorBanner message={connectors.error} onRetry={() => void connectors.reload()} />}
      {connectors.loading && !connectors.data ? <Skeleton height={200} /> : null}

      <div className="section-title"><div><h3>内置能力</h3><p>随工作台一起提供，无需额外配置</p></div></div>
      <div className="connector-grid">
        {builtins.map((item) => (
          <div className="card card-pad connector-card" key={item.id}>
            <div className="between">
              <div className="row">
                <div className="stat-icon" style={{ color: '#5b6cff', background: '#eef0ff', margin: 0 }}><Icon name={KIND_ICON[item.kind] ?? 'settings'} size={17} /></div>
                <div><h4>{item.name}</h4><div className="text-xs muted">{KIND_LABEL[item.kind] ?? item.kind}</div></div>
              </div>
              {statusBadge(item.status)}
            </div>
            <p className="settings-note mt-12">{item.description}</p>
            <div className="chip-row mt-12">
              <span className="chip">{item.baseUrl}</span>
              {item.detail && <span className="chip">{item.detail}</span>}
            </div>
            <div className="row mt-16">
              <Button variant="outline" size="sm" icon="refresh" loading={testingId === item.id} onClick={() => void test(item)}>检查状态</Button>
              {item.id === 'builtin-mail' && <Button variant="ghost" size="sm" icon="settings" onClick={() => { window.location.hash = '#/mail'; }}>去配置</Button>}
              {item.id === 'builtin-llm' && <Button variant="ghost" size="sm" icon="settings" onClick={() => { window.location.hash = '#/settings'; }}>去配置</Button>}
            </div>
          </div>
        ))}
      </div>

      <div className="section-title"><div><h3>自定义连接器</h3><p>接入企业内部 API、Webhook 或第三方技能服务</p></div>
        <Button variant="outline" size="sm" icon="plus" onClick={openCreate}>添加</Button></div>

      {custom.length ? (
        <div className="connector-grid">
          {custom.map((item) => (
            <div className="card card-pad connector-card" key={item.id}>
              <div className="between">
                <div className="row">
                  <div className="stat-icon" style={{ color: '#13bfa2', background: '#e4f9f4', margin: 0 }}><Icon name={KIND_ICON[item.kind] ?? 'external'} size={17} /></div>
                  <div><h4>{item.name}</h4><div className="text-xs muted">{KIND_LABEL[item.kind] ?? item.kind} · {item.enabled ? '已启用' : '已停用'}</div></div>
                </div>
                {statusBadge(item.status)}
              </div>
              <p className="settings-note mt-12">{item.description || '暂无描述'}</p>
              <div className="chip-row mt-12">
                <span className="chip">{item.baseUrl}</span>
                {item.hasToken && <span className="chip">已配置 Token</span>}
                {item.lastCheckedAt && <span className="chip">检查于 {formatDate(item.lastCheckedAt)}</span>}
              </div>
              {item.lastError && <div className="inline-error mt-12">{item.lastError}</div>}
              <div className="row wrap mt-16">
                <Button variant="outline" size="sm" icon="refresh" loading={testingId === item.id} onClick={() => void test(item)}>测试连接</Button>
                <Button variant="ghost" size="sm" icon={item.enabled ? 'close' : 'check'} onClick={() => void toggle(item)}>{item.enabled ? '停用' : '启用'}</Button>
                <span className="grow" />
                <IconButton icon="edit" title="编辑连接器" onClick={() => openEdit(item)} />
                <IconButton icon="trash" title="移除连接器" onClick={() => void remove(item)} />
              </div>
            </div>
          ))}
        </div>
      ) : !connectors.loading && (
        <div className="card"><EmptyState icon="external" title="还没有自定义连接器" hint="添加一个 HTTP 服务地址，即可在这里集中管理连通性与凭据。"
          action={<Button size="sm" icon="plus" onClick={openCreate}>添加连接器</Button>} /></div>
      )}

      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={editingId ? '编辑连接器' : '添加连接器'}
        subtitle="Token 使用 AES-256-GCM 加密保存在本机，不会回显到界面" width={620}
        footer={<><Button variant="ghost" onClick={() => setFormOpen(false)}>取消</Button><Button icon="save" loading={busy} onClick={() => void save()}>保存</Button></>}>
        <div className="form-grid">
          <Field label="名称"><input className="input" value={form.name} placeholder="例如：企业知识库" onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="类型"><select className="select" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
            <option value="webhook">Webhook</option><option value="api">HTTP API</option><option value="storage">存储服务</option><option value="custom">自定义技能</option></select></Field>
          <div className="full"><Field label="服务地址" hint="必须以 http:// 或 https:// 开头"><input className="input" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></Field></div>
          <div className="full"><Field label="描述"><textarea className="textarea" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field></div>
          <div className="full"><Field label="Bearer Token（可选）" hint={editingId ? '留空表示不修改已有凭据' : '会作为 Authorization 头发送'}><input className="input" type="password" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} /></Field></div>
        </div>
        <label className="row text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> 保存后启用</label>
      </Modal>
    </div>
  );
}
