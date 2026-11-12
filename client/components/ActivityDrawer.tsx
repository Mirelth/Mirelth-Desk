import { useEffect } from 'react';
import { apiClient } from '../lib/api.ts';
import type { Activity } from '../lib/types.ts';
import { Button, Icon, IconButton, Skeleton } from '../lib/ui.tsx';
import { useLoad } from '../lib/hooks.ts';

const MODULE_LABEL: Record<string, string> = {
  document: '文档', documents: '文档', analytics: '数据', paper: '论文', papers: '论文',
  research: '科研', mail: '邮箱', agent: '智能体', system: '系统',
};

function timeText(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  const today = new Date();
  const sameDay = time.toDateString() === today.toDateString();
  const hhmm = time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `今天 ${hhmm}` : `${time.getMonth() + 1}/${time.getDate()} ${hhmm}`;
}

/**
 * 「活动」抽屉：读 `/api/dashboard/activity` 的最近流水，和侧栏「最近任务」同源但带模块与时间。
 * 活动是流水而不是任务表，所以只读、不可操作。
 */
export function ActivityDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, loading, error, reload } = useLoad(
    () => (open ? apiClient.get<Activity[]>('/api/dashboard/activity?limit=50') : Promise.resolve([] as Activity[])),
    [open],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="agent-backdrop" onClick={onClose} />
      <aside className="agent-drawer activity-drawer">
        <header className="agent-head">
          <div className="brand-mark"><Icon name="clock" size={19} /></div>
          <div className="grow"><h3>活动</h3><p>最近 50 条操作流水 · 与侧栏「最近任务」同源</p></div>
          <IconButton icon="close" title="关闭活动" onClick={onClose} />
        </header>
        <div className="activity-body">
          {loading && <div className="stack"><Skeleton /><Skeleton /><Skeleton /></div>}
          {error && <div className="inline-error">{error} <Button variant="ghost" size="sm" onClick={reload}>重试</Button></div>}
          {!loading && !error && (data?.length ?? 0) === 0 && <div className="muted text-sm">还没有活动记录。</div>}
          {(data ?? []).map((item) => (
            <div className="activity-row" key={item.id}>
              <span className="activity-module">{MODULE_LABEL[item.module] ?? item.module}</span>
              <span className="activity-text">{item.description}</span>
              <span className="activity-time">{timeText(item.created_at)}</span>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
