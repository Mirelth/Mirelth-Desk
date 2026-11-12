import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api.ts';
import { useLoad } from '../lib/hooks.ts';
import type { PlatformStatus } from '../lib/types.ts';
import { Badge, Button, ErrorBanner, formatNumber } from '../lib/ui.tsx';
import { PlatformAgents } from './platform/PlatformAgents.tsx';
import { PlatformAudit } from './platform/PlatformAudit.tsx';
import { PlatformChat } from './platform/PlatformChat.tsx';
import { PlatformCollab } from './platform/PlatformCollab.tsx';
import { PlatformFiles } from './platform/PlatformFiles.tsx';
import { PlatformKnowledge } from './platform/PlatformKnowledge.tsx';
import { PlatformMembers } from './platform/PlatformMembers.tsx';
import { PlatformWorkflows } from './platform/PlatformWorkflows.tsx';

const TABS = [
  { value: 'chat', label: '对话' },
  { value: 'knowledge', label: '知识库' },
  { value: 'agents', label: '智能体' },
  { value: 'collab', label: '协作' },
  { value: 'files', label: '文件' },
  { value: 'workflows', label: '工作流' },
  { value: 'audit', label: '审计' },
  { value: 'members', label: '成员' },
] as const;

type TabId = typeof TABS[number]['value'];

/** 子页放在 hash 里（`#/platform/agents`），刷新与深链都不会丢。 */
function readTab(): TabId {
  const [, sub] = window.location.hash.replace(/^#\/?/, '').split('/');
  return (TABS.some((tab) => tab.value === sub) ? sub : 'chat') as TabId;
}

export function Platform({ onChanged }: { onChanged?: () => void }) {
  const [tab, setTab] = useState<TabId>(readTab);
  const status = useLoad<PlatformStatus>(() => apiClient.get<PlatformStatus>('/api/platform/status'));

  useEffect(() => {
    const onHashChange = () => setTab(readTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (next: TabId) => {
    window.location.hash = `#/platform/${next}`;
    setTab(next);
  };

  const quota = status.data?.quota;
  const workspaceId = status.data?.workspace.id ?? null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>智能体工作台</h1>
          <p>多轮会话、工具调用、知识库与工作区协作都落在本机</p>
        </div>
        <div className="page-actions">
          <Button icon="refresh" onClick={() => void status.reload()}>刷新配额</Button>
        </div>
      </div>

      <div className="row wrap mb-16">
        <Badge tone={status.data?.mode === 'live' ? 'green' : 'amber'}>
          {status.data?.mode === 'live' ? `模型已接入 · ${status.data.model}` : '离线规则引擎'}
        </Badge>
        <Badge tone="blue">{status.data?.tools ?? 0} 个工具</Badge>
        <Badge tone="neutral">{formatNumber(status.data?.knowledgeChunks ?? 0)} 个知识片段</Badge>
        <Badge tone="neutral">{status.data?.conversations ?? 0} 个会话</Badge>
        <Badge tone="neutral">{status.data?.runs ?? 0} 次运行</Badge>
        <Badge tone="neutral">{status.data?.members ?? 0} 位成员</Badge>
        <span className="grow" />
        {quota && <span className="text-xs muted">今日模型调用 {quota.used} / {quota.limit}</span>}
        {status.data && <span className="text-xs muted">工作区：{status.data.workspace.name}（{status.data.workspace.role}）</span>}
      </div>

      {status.error && <ErrorBanner message={status.error} onRetry={() => void status.reload()} />}

      <div className="row wrap mb-16">
        {TABS.map((item) => (
          <Button key={item.value} size="sm" variant={tab === item.value ? 'primary' : 'ghost'} onClick={() => switchTab(item.value)}>
            {item.label}
          </Button>
        ))}
      </div>

      {tab === 'chat' && <PlatformChat onChanged={onChanged} />}
      {tab === 'knowledge' && <PlatformKnowledge status={status.data} reloadStatus={status.reload} />}
      {tab === 'agents' && <PlatformAgents onChanged={onChanged} />}
      {tab === 'collab' && <PlatformCollab workspaceId={workspaceId} />}
      {tab === 'files' && <PlatformFiles onChanged={onChanged} />}
      {tab === 'workflows' && <PlatformWorkflows />}
      {tab === 'audit' && <PlatformAudit />}
      {tab === 'members' && <PlatformMembers defaultWorkspaceId={workspaceId} onChanged={onChanged} />}
    </div>
  );
}
