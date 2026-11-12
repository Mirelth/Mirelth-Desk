import { useState } from 'react';
import { apiClient, getErrorMessage } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { AuthUser, Paged, PlatformApiKey, PlatformMember, PlatformWorkspace } from '../../lib/types.ts';
import {
  Badge, Button, EmptyState, Field, IconButton, Modal, SectionTitle, formatDate, useToast,
} from '../../lib/ui.tsx';

const ROLES = ['viewer', 'member', 'admin'] as const;

/**
 * 成员 tab：工作区 → 成员 → 入站 Key，再加一层安装管理员的账号管理。
 * 顺序是有意的：新账号要先建出来，才可能被加进工作区；成员要加得进去，分享才有对象。
 */
export function PlatformMembers({ defaultWorkspaceId, onChanged }: { defaultWorkspaceId: string | null; onChanged?: () => void }) {
  const toast = useToast();
  const workspaces = useLoad<PlatformWorkspace[]>(() => apiClient.get<PlatformWorkspace[]>('/api/platform/workspaces'));
  const users = useLoad<Paged<AuthUser>>(() => apiClient.get<Paged<AuthUser>>('/api/auth/users'));

  const [selected, setSelected] = useState('');
  const workspaceId = selected || defaultWorkspaceId || workspaces.data?.[0]?.id || '';

  const members = useLoad<PlatformMember[]>(
    () => (workspaceId ? apiClient.get<PlatformMember[]>(`/api/platform/workspaces/${workspaceId}/members`) : Promise.resolve([])),
    [workspaceId],
  );
  const keys = useLoad<PlatformApiKey[]>(
    () => (workspaceId ? apiClient.get<PlatformApiKey[]>(`/api/platform/workspaces/${workspaceId}/keys`) : Promise.resolve([])),
    [workspaceId],
  );

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [memberName, setMemberName] = useState('');
  const [memberRole, setMemberRole] = useState<string>('member');
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyRole, setKeyRole] = useState<string>('member');
  const [issuedKey, setIssuedKey] = useState<string>('');
  const [userOpen, setUserOpen] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); onChanged?.(); }
    catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <SectionTitle
        title="工作区与成员"
        hint="一个安装可以有多个账号；成员关系决定谁能看到哪个工作区"
        action={(
          <div className="row wrap">
            <select className="input" value={workspaceId} onChange={(event) => setSelected(event.target.value)}>
              {(workspaces.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}（{item.role}）</option>)}
            </select>
            <Button variant="ghost" size="sm" icon="plus" onClick={() => setWorkspaceOpen(true)}>新建工作区</Button>
          </div>
        )}
      />

      <div className="grid-2">
        <div className="card card-pad">
          <div className="section-head mb-12"><h4>成员</h4><Badge tone="blue">{members.data?.length ?? 0} 人</Badge></div>
          {(members.data ?? []).map((member) => (
            <div key={member.userId} className="row wrap mb-8">
              <span className="text-sm grow">{member.username}</span>
              <Badge tone={member.role === 'owner' ? 'violet' : 'neutral'}>{member.role}</Badge>
              <span className="text-xs muted">{formatDate(member.createdAt)}</span>
              <IconButton icon="trash" title="移出工作区" onClick={() => void run(async () => {
                await apiClient.delete(`/api/platform/workspaces/${workspaceId}/members/${member.userId}`);
                await members.reload();
              })} />
            </div>
          ))}
          <div className="row wrap mt-12">
            <input className="input grow" placeholder="账号名（需已存在）" value={memberName} onChange={(event) => setMemberName(event.target.value)} />
            <select className="input" value={memberRole} onChange={(event) => setMemberRole(event.target.value)}>
              {['viewer', 'member', 'admin'].map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
            <Button size="sm" icon="plus" loading={busy} onClick={() => void run(async () => {
              await apiClient.post(`/api/platform/workspaces/${workspaceId}/members`, { username: memberName.trim(), role: memberRole });
              setMemberName('');
              await members.reload();
            })}>加入</Button>
          </div>
        </div>

        <div className="card card-pad">
          <div className="section-head mb-12">
            <div><h4>入站 API Key</h4><div className="text-xs muted mt-8">给 /webhook/:key 与 /mcp 用；明文只显示一次</div></div>
            <Button variant="soft" size="sm" icon="plus" onClick={() => setKeyOpen(true)}>新建 Key</Button>
          </div>
          {(keys.data ?? []).length ? (keys.data ?? []).map((key) => (
            <div key={key.id} className="row wrap mb-8">
              <code className="text-xs">mdk_{key.prefix}_…</code>
              <span className="text-sm grow">{key.name}</span>
              <Badge tone={key.revokedAt ? 'rose' : 'green'}>{key.revokedAt ? '已撤销' : key.role}</Badge>
              <span className="text-xs muted">{key.lastUsedAt ? `用过 ${formatDate(key.lastUsedAt)}` : '未使用'}</span>
              {!key.revokedAt && (
                <IconButton icon="trash" title="撤销" onClick={() => void run(async () => {
                  await apiClient.delete(`/api/platform/workspaces/${workspaceId}/keys/${key.id}`);
                  await keys.reload();
                })} />
              )}
            </div>
          )) : <div className="text-xs muted">还没有 Key。没有它，外部系统调不进 webhook 与 MCP。</div>}
        </div>

        <div className="card card-pad" style={{ gridColumn: '1 / -1' }}>
          <div className="section-head mb-12">
            <div><h4>账号</h4><div className="text-xs muted mt-8">只有安装管理员（第一个账号）能建号与删号</div></div>
            <Button variant="soft" size="sm" icon="plus" onClick={() => setUserOpen(true)}>新建账号</Button>
          </div>
          {users.error && <div className="text-xs muted mb-12">{users.error}</div>}
          {(users.data?.items ?? []).length ? (users.data?.items ?? []).map((user) => (
            <div key={user.id} className="row wrap mb-8">
              <span className="text-sm grow">{user.username}</span>
              <span className="text-xs muted">{formatDate(user.createdAt)}</span>
              <IconButton icon="trash" title="删除账号" onClick={() => void run(async () => {
                await apiClient.delete(`/api/auth/users/${user.id}`);
                await users.reload();
                await members.reload();
              })} />
            </div>
          )) : (!users.error && <EmptyState icon="user" title="没有读到账号列表" hint="用安装管理员账号登录才能管理账号。" />)}
        </div>
      </div>

      <Modal open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} title="新建工作区"
        footer={<><Button variant="ghost" onClick={() => setWorkspaceOpen(false)}>取消</Button>
          <Button loading={busy} onClick={() => void run(async () => {
            const created = await apiClient.post<{ id: string }>('/api/platform/workspaces', { name: workspaceName.trim() });
            setWorkspaceName(''); setWorkspaceOpen(false); setSelected(created.id);
            await workspaces.reload();
          })}>创建</Button></>}>
        <Field label="名称"><input className="input" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></Field>
      </Modal>

      <Modal open={keyOpen} onClose={() => { setKeyOpen(false); setIssuedKey(''); }} title="新建入站 API Key"
        subtitle="角色是这把 key 的上限；owner 不开放给长期凭据"
        footer={issuedKey ? <Button onClick={() => { setKeyOpen(false); setIssuedKey(''); }}>我已保存，关闭</Button> : <><Button variant="ghost" onClick={() => { setKeyOpen(false); setIssuedKey(''); }}>取消</Button>
          <Button loading={busy} onClick={() => void run(async () => {
            const created = await apiClient.post<{ key: string }>(`/api/platform/workspaces/${workspaceId}/keys`, { name: keyName.trim(), role: keyRole });
            setIssuedKey(created.key); setKeyName('');
            await keys.reload();
          })}>生成</Button></>}>
        {issuedKey ? (
          <div className="stack-sm">
            <div className="text-xs muted">这串明文只出现这一次，关掉就再也看不到：</div>
            <code className="text-xs" style={{ wordBreak: 'break-all' }}>{issuedKey}</code>
            <div className="text-xs muted">用法：<code>curl -H "X-Api-Key: …" -X POST /api/platform/webhook/&lt;事件名&gt;</code></div>
          </div>
        ) : (
          <div className="stack-sm">
            <Field label="名称"><input className="input" value={keyName} onChange={(event) => setKeyName(event.target.value)} /></Field>
            <Field label="角色">
              <select className="input" value={keyRole} onChange={(event) => setKeyRole(event.target.value)}>
                {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </Field>
          </div>
        )}
      </Modal>

      <Modal open={userOpen} onClose={() => setUserOpen(false)} title="新建账号"
        subtitle="新账号有自己的默认工作区；要共享数据就把它加进现有工作区"
        footer={<><Button variant="ghost" onClick={() => setUserOpen(false)}>取消</Button>
          <Button loading={busy} onClick={() => void run(async () => {
            await apiClient.post('/api/auth/users', { username: newUser.username.trim(), password: newUser.password });
            setNewUser({ username: '', password: '' }); setUserOpen(false);
            await users.reload();
          })}>创建</Button></>}>
        <div className="stack-sm">
          <Field label="账号" hint="字母、数字与 _ . @ -"><input className="input" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} /></Field>
          <Field label="初始密码" hint="至少 8 位；登录后可自行使用"><input className="input" type="password" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}
