import { useState } from 'react';
import { apiClient, getErrorMessage } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { DocumentDto, Paged, PlatformComment, PlatformMember, PlatformShare, PlatformVersion } from '../../lib/types.ts';
import { Badge, Button, EmptyState, SectionTitle, formatDate, useToast } from '../../lib/ui.tsx';

/**
 * 协作 tab：分享、评论、版本都挂在同一篇文档上，所以先选文档再操作。
 * 分享对象只能从当前工作区成员里挑——这正是「先建账号、再加成员」那条链路的下游。
 */
export function PlatformCollab({ workspaceId }: { workspaceId: string | null }) {
  const toast = useToast();
  const docs = useLoad<Paged<DocumentDto>>(() => apiClient.get<Paged<DocumentDto>>('/api/documents?limit=50'));
  const [docId, setDocId] = useState('');
  const effective = docId || docs.data?.items[0]?.id || '';

  const members = useLoad<PlatformMember[]>(
    () => (workspaceId ? apiClient.get<PlatformMember[]>(`/api/platform/workspaces/${workspaceId}/members`) : Promise.resolve([])),
    [workspaceId],
  );
  const shares = useLoad<PlatformShare[]>(
    () => (effective ? apiClient.get<PlatformShare[]>(`/api/platform/shares?documentId=${encodeURIComponent(effective)}`) : Promise.resolve([])),
    [effective],
  );
  const comments = useLoad<PlatformComment[]>(
    () => (effective ? apiClient.get<PlatformComment[]>(`/api/platform/comments?documentId=${encodeURIComponent(effective)}`) : Promise.resolve([])),
    [effective],
  );
  const versions = useLoad<PlatformVersion[]>(
    () => (effective ? apiClient.get<PlatformVersion[]>(`/api/platform/versions?documentId=${encodeURIComponent(effective)}`) : Promise.resolve([])),
    [effective],
  );

  const [targetUserId, setTargetUserId] = useState('');
  const [permission, setPermission] = useState<'read' | 'comment' | 'edit'>('read');
  const [comment, setComment] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const usernameOf = (userId: string) => members.data?.find((item) => item.userId === userId)?.username ?? userId;

  const addShare = async () => {
    if (!effective || !targetUserId) { toast('选一篇文档与一个成员', 'error'); return; }
    setBusy(true);
    try {
      await apiClient.post('/api/platform/shares', { documentId: effective, targetUserId, permission });
      await shares.reload();
      toast('已分享', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const addComment = async () => {
    if (!effective || !comment.trim()) return;
    setBusy(true);
    try {
      await apiClient.post('/api/platform/comments', { documentId: effective, content: comment.trim() });
      setComment('');
      await comments.reload();
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const snapshot = async () => {
    if (!effective) return;
    setBusy(true);
    try {
      await apiClient.post('/api/platform/versions', { documentId: effective, note: note.trim() });
      setNote('');
      await versions.reload();
      toast('已保存快照', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const restore = async (id: string) => {
    setBusy(true);
    try {
      await apiClient.post(`/api/platform/versions/${id}/restore`);
      await Promise.all([versions.reload(), docs.reload()]);
      toast('已恢复到该版本（恢复前自动存了一份快照）', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <SectionTitle
        title="文档协作"
        hint="分享给工作区成员、就地评论、随时存快照并恢复"
        action={(
          <select className="input" value={effective} onChange={(event) => setDocId(event.target.value)}>
            {(docs.data?.items ?? []).map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
          </select>
        )}
      />

      {!effective && <EmptyState icon="file" title="还没有可协作的文档" hint="先去「文档协作」应用建一篇。" />}

      {effective && (
        <div className="grid-2">
          <div className="card card-pad">
            <div className="section-head mb-12"><h4>分享</h4><Badge tone="blue">{shares.data?.length ?? 0} 条</Badge></div>
            <div className="row wrap mb-12">
              <select className="input grow" value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)}>
                <option value="">选择工作区成员…</option>
                {(members.data ?? []).map((item) => <option key={item.userId} value={item.userId}>{item.username}（{item.role}）</option>)}
              </select>
              <select className="input" value={permission} onChange={(event) => setPermission(event.target.value as 'read' | 'comment' | 'edit')}>
                <option value="read">只读</option>
                <option value="comment">可评论</option>
                <option value="edit">可编辑</option>
              </select>
              <Button size="sm" icon="plus" loading={busy} onClick={() => void addShare()}>分享</Button>
            </div>
            {(shares.data ?? []).length ? (shares.data ?? []).map((item) => (
              <div key={item.id} className="row wrap mb-8">
                <span className="text-sm grow">{usernameOf(item.user_id)}</span>
                <Badge tone="neutral">{item.permission}</Badge>
                <span className="text-xs muted">{formatDate(item.created_at)}</span>
              </div>
            )) : <div className="text-xs muted">还没分享给任何人。</div>}
          </div>

          <div className="card card-pad">
            <div className="section-head mb-12"><h4>评论</h4><Badge tone="blue">{comments.data?.length ?? 0} 条</Badge></div>
            <div className="stack-sm" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {(comments.data ?? []).length ? (comments.data ?? []).map((item) => (
                <div key={item.id} className="card-pad" style={{ background: 'var(--surface-2)', borderRadius: 10 }}>
                  <div className="text-xs muted mb-8">{item.username} · {formatDate(item.created_at)}</div>
                  <div className="text-sm">{item.content}</div>
                </div>
              )) : <div className="text-xs muted">还没有评论。</div>}
            </div>
            <div className="row mt-12">
              <input className="input grow" placeholder="写一条评论…" value={comment} onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addComment(); } }} />
              <Button variant="soft" size="sm" loading={busy} onClick={() => void addComment()}>发送</Button>
            </div>
          </div>

          <div className="card card-pad" style={{ gridColumn: '1 / -1' }}>
            <div className="section-head mb-12"><h4>版本</h4><Badge tone="blue">{versions.data?.length ?? 0} 个快照</Badge></div>
            <div className="row wrap mb-12">
              <input className="input grow" placeholder="快照备注（可选）" value={note} onChange={(event) => setNote(event.target.value)} />
              <Button size="sm" icon="save" loading={busy} onClick={() => void snapshot()}>存快照</Button>
            </div>
            {(versions.data ?? []).length ? (versions.data ?? []).map((item) => (
              <div key={item.id} className="row wrap mb-8">
                <span className="text-sm grow">{item.note || '（无备注）'} · {item.title}</span>
                <span className="text-xs muted">{formatDate(item.created_at)}</span>
                <Button variant="ghost" size="sm" icon="refresh" loading={busy} onClick={() => void restore(item.id)}>恢复</Button>
              </div>
            )) : <div className="text-xs muted">还没有快照。恢复会先把当前内容存成一份新快照。</div>}
          </div>
        </div>
      )}
    </div>
  );
}
