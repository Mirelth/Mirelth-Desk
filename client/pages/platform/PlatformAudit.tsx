import { apiClient } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { PlatformAuditLog, PlatformUsage } from '../../lib/types.ts';
import { Badge, EmptyState, SectionTitle, formatDate, formatNumber } from '../../lib/ui.tsx';

/** 审计 tab：写操作留痕与模型用量。两者都要求工作区 admin 起，viewer 会拿到 403 文案。 */
export function PlatformAudit() {
  const audit = useLoad<PlatformAuditLog[]>(() => apiClient.get<PlatformAuditLog[]>('/api/platform/audit'));
  const usage = useLoad<PlatformUsage[]>(() => apiClient.get<PlatformUsage[]>('/api/platform/usage'));

  return (
    <div className="grid-2">
      <div className="card card-pad">
        <SectionTitle title="审计" hint="成员、分享、版本、文件、工作流、MCP 的写操作" />
        {audit.error && <div className="text-xs muted mb-12">{audit.error}</div>}
        {(audit.data ?? []).length ? (
          <div className="stack-sm" style={{ maxHeight: 460, overflowY: 'auto' }}>
            {(audit.data ?? []).map((log) => (
              <div key={log.id} className="row wrap mb-8">
                <Badge tone="neutral">{log.action}</Badge>
                <span className="text-xs muted grow">{log.resource || log.detail || '—'}</span>
                <span className="text-xs muted">{formatDate(log.created_at)}</span>
              </div>
            ))}
          </div>
        ) : <EmptyState icon="shield" title="还没有审计记录" hint="扳一次成员或文件操作就会出现在这里。" />}
      </div>

      <div className="card card-pad">
        <SectionTitle title="模型用量" hint="只统计平台会话写入的 model_usage；其他模块调模型不记在这里" />
        {usage.error && <div className="text-xs muted mb-12">{usage.error}</div>}
        {(usage.data ?? []).length ? (
          <div className="stack-sm" style={{ maxHeight: 460, overflowY: 'auto' }}>
            {(usage.data ?? []).map((row) => (
              <div key={row.id} className="row wrap mb-8">
                <span className="text-sm grow">{row.model}</span>
                <span className="text-xs muted">{formatNumber(row.tokens_estimate)} 字符</span>
                <span className="text-xs muted">{formatDate(row.created_at)}</span>
              </div>
            ))}
          </div>
        ) : <EmptyState icon="chart" title="还没有用量记录" hint="在「对话」tab 跑一次会话就会写入一行。" />}
      </div>
    </div>
  );
}
