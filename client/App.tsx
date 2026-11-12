import { useCallback, useEffect, useState } from 'react';
import { AgentDrawer, type AgentPreset } from './components/AgentDrawer.tsx';
import { AccountMenu } from './components/AccountMenu.tsx';
import { ActivityDrawer } from './components/ActivityDrawer.tsx';
import { apiClient, downloadFile, getErrorMessage } from './lib/api.ts';
import { useTheme } from './lib/theme.ts';
import { Icon, IconButton, useToast, type IconName } from './lib/ui.tsx';
import type { AiMode, DashboardStats, PageId, User } from './lib/types.ts';
import { Login } from './pages/Login.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Documents } from './pages/Documents.tsx';
import { Analytics } from './pages/Analytics.tsx';
import { Papers } from './pages/Papers.tsx';
import { Research } from './pages/Research.tsx';
import { Mail } from './pages/Mail.tsx';
import { Automation } from './pages/Automation.tsx';
import { Connectors } from './pages/Connectors.tsx';
import { Platform } from './pages/Platform.tsx';
import { Settings } from './pages/Settings.tsx';

const PAGE_META: Record<PageId, { title: string; sub: string }> = {
  dashboard: { title: '工作台', sub: '一个入口，统筹你的办公任务' },
  documents: { title: '文档协作', sub: '大纲、起草、润色、导出与共享前校对' },
  analytics: { title: '数据分析', sub: 'CSV 统计、图表与 AI 洞察' },
  papers: { title: '论文整理', sub: '文献库、引用导出与综述生成' },
  research: { title: '科学研究', sub: '项目、实验记录与任务看板' },
  mail: { title: '智能邮箱', sub: '收发、摘要与回复起草' },
  automation: { title: '自动化任务', sub: '定时触发办公动作，结果可追溯' },
  connectors: { title: '技能专家连接器', sub: '模型、邮箱、存储与外部服务接入状态' },
  platform: { title: '智能体工作台', sub: '多轮会话、工具调用与知识库检索' },
  settings: { title: '设置', sub: 'AI 模型、邮箱账户与本机账号' },
};

/**
 * 活动流水 → 页面。`module` 只有 7 个值而 `action` 是自由字符串，所以先看 action 再看 module：
 * 绝大多数写操作记的是 `module='agent'`（含自动化、连接器、各类 *_ai），只按 module 映射会把它们全导到首页。
 */
const MODULE_PAGE: Record<string, PageId> = {
  document: 'documents', documents: 'documents', analytics: 'analytics', paper: 'papers',
  research: 'research', mail: 'mail', system: 'dashboard',
};

function pageForActivity(entry: { module: string; action: string }): PageId {
  const action = entry.action;
  if (action.startsWith('automation_') || action.startsWith('connector_')) return 'automation';
  if (action === 'document_ai') return 'documents';
  if (action === 'analytics_ai') return 'analytics';
  if (action === 'paper_ai') return 'papers';
  if (action === 'research_ai') return 'research';
  if (action === 'mail_ai') return 'mail';
  if (action === 'stream' || action === 'generate' || action === 'chat') return 'platform';
  return MODULE_PAGE[entry.module] ?? 'dashboard';
}

/**
 * 侧栏应用入口的唯一真相：侧栏从它渲染，`PageId` 的新增要同时在这里挂一条（首页 `dashboard` 不列，靠点品牌回）。
 */
const APP_ENTRIES: Array<{ id: PageId; icon: IconName; hint: string; metric?: 'unreadMail' }> = [
  { id: 'mail', icon: 'mail', hint: '收发、摘要与回复', metric: 'unreadMail' },
  { id: 'automation', icon: 'bolt', hint: '定时触发办公动作' },
  { id: 'connectors', icon: 'external', hint: '模型、邮箱、存储接入' },
  { id: 'platform', icon: 'headphones', hint: '多轮会话、工具与知识库' },
];

interface SystemInfo { version: string; build: string; aiMode: string; env: string }

function readPage(): PageId {
  // hash 允许带子页（`#/platform/agents`）：判页面只看第一段。
  const value = window.location.hash.replace(/^#\/?/, '').split('/')[0] as PageId;
  return Object.prototype.hasOwnProperty.call(PAGE_META, value) ? value : 'dashboard';
}

export function App() {
  const [page, setPage] = useState<PageId>(readPage);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [aiMode, setAiMode] = useState<AiMode>('offline');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsError, setStatsError] = useState('');
  const [agentOpen, setAgentOpen] = useState(false);
  const [preset, setPreset] = useState<AgentPreset | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [recentOpen, setRecentOpen] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const theme = useTheme();
  const toast = useToast();

  useEffect(() => {
    const onHashChange = () => setPage(readPage());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    apiClient.get<{ user: User; aiMode: AiMode }>('/api/auth/me')
      .then((result) => { setUser(result.user); setAiMode(result.aiMode); })
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    apiClient.get<SystemInfo>('/api/system/info').then(setSystemInfo).catch(() => setSystemInfo(null));
  }, [user]);

  const downloadLogs = async () => {
    setAccountOpen(false);
    try {
      await downloadFile('/api/system/logs', 'mirelth-desk-logs.txt');
      toast('诊断日志已开始下载', 'success');
    } catch (error) {
      toast(getErrorMessage(error), 'error');
    }
  };

  const checkUpdates = () => {
    setAccountOpen(false);
    if (!systemInfo) {
      toast('读不到版本信息，请确认服务在运行', 'error');
      return;
    }
    toast(`当前 v${systemInfo.version}（本地构建），已是最新`, 'success');
  };

  const refreshStats = useCallback(async () => {
    if (!user) return;
    try {
      setStats(await apiClient.get<DashboardStats>('/api/dashboard'));
      setStatsError('');
    } catch (error) {
      setStatsError(error instanceof Error ? error.message : '统计加载失败');
    }
  }, [user]);

  useEffect(() => { void refreshStats(); }, [refreshStats]);

  const navigate = (next: PageId) => {
    window.location.hash = `#/${next}`;
    setPage(next);
    void refreshStats();
  };

  const openAgent = (text: string) => {
    setPreset({ text, nonce: Date.now() + Math.random() });
    setAgentOpen(true);
  };

  const logout = async () => {
    try { await apiClient.post('/api/auth/logout'); } catch { /* ignore */ }
    setUser(null);
    setStats(null);
  };

  if (user === undefined) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#6b748c' }}>
      <div className="row"><span className="spinner" /> 正在加载工作台…</div>
    </div>;
  }

  if (!user) return <Login onSuccess={(nextUser, mode) => { setUser(nextUser); setAiMode(mode); }} />;

  const meta = PAGE_META[page];
  const recent = (stats?.recent ?? []).slice(0, 5);

  return (
    <>
      <div className="app-shell">
        <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}>
          <div className="brand-row">
            <button type="button" className="brand" onClick={() => navigate('dashboard')} title="返回工作台首页">
              <div className="brand-mark"><Icon name="sparkles" size={18} /></div>
              <div><div className="brand-name">Mirelth Desk</div><div className="brand-sub">办公智能体 v1.0</div></div>
            </button>
            <IconButton icon="menu" title={collapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setCollapsed(!collapsed)} />
          </div>
          <button type="button" className="new-task" onClick={() => openAgent('')} title="打开智能体，开始一个新任务">
            <Icon name="edit" size={16} />
            <span>新建任务</span>
            <span className="new-task-search"><Icon name="search" size={14} /></span>
          </button>
          <div className="nav-section">应用 ({APP_ENTRIES.length})</div>
          <nav>
            {APP_ENTRIES.map((item) => {
              const count = item.metric ? stats?.[item.metric] ?? 0 : 0;
              return (
                <button type="button" key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`}
                  onClick={() => navigate(item.id)} title={`${PAGE_META[item.id].title} · ${item.hint}`}>
                  <Icon name={item.icon} size={17} />
                  <span>{PAGE_META[item.id].title}</span>
                  {count > 0 ? <span className="nav-count">{count}</span> : null}
                </button>
              );
            })}
          </nav>
          <button type="button" className="nav-section is-toggle" onClick={() => setRecentOpen(!recentOpen)}
            aria-expanded={recentOpen} title={recentOpen ? '收起最近任务' : '展开最近任务'}>
            最近任务 ({recent.length})
            <span className={`nav-chevron ${recentOpen ? 'is-open' : ''}`}><Icon name="down" size={12} /></span>
          </button>
          {recentOpen && (
            <div className="sidebar-tasks">
              {recent.length === 0 && <div className="sidebar-tasks-empty">还没有执行过的任务</div>}
              {recent.map((item) => (
                <button type="button" className="sidebar-task" key={item.id} title={item.description}
                  onClick={() => navigate(pageForActivity(item))}>
                  <span className="dot" /><span>{item.description}</span>
                </button>
              ))}
            </div>
          )}
          <div className="sidebar-foot">
            <div className={`ai-status-chip ${aiMode === 'offline' ? 'offline' : ''}`}>
              <span className="dot" />
              <span>{aiMode === 'offline' ? '离线规则引擎' : '模型已接入'}</span>
            </div>
            <button type="button" className="sidebar-user" onClick={() => setAccountOpen(!accountOpen)}
              aria-haspopup="menu" aria-expanded={accountOpen} title="账号与外观">
              <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
              <span className="sidebar-user-name">{user.username}</span>
              <span className="sidebar-user-chevron"><Icon name="down" size={13} /></span>
            </button>
          </div>
        </aside>

        <div className="main-area">
          <header className="topbar">
            <div className="topbar-status"><span className="dot" />本地运行 · 数据不出本机</div>
            <div className="topbar-actions">
              <span className="text-xs muted">{meta.title}</span>
              <div className={`topbar-pill ${aiMode === 'offline' ? 'offline' : ''}`}>
                <span className="dot" />{aiMode === 'offline' ? '离线引擎' : 'AI 在线'}
              </div>
              <IconButton icon="dashboard" title="返回工作台首页" onClick={() => navigate('dashboard')} />
              <IconButton icon="headphones" title="打开智能体助手" onClick={() => setAgentOpen(true)} />
              <IconButton icon="refresh" title="刷新数据" onClick={() => void refreshStats()} />
              <IconButton icon="bell" title="查看最近任务" onClick={() => navigate('dashboard')} />
              <div className="avatar" title={user.username}>{user.username.slice(0, 1).toUpperCase()}</div>
            </div>
          </header>

          <main>
            {page === 'dashboard' && (
              <Dashboard error={statsError} reload={() => void refreshStats()}
                navigate={navigate} openAgent={openAgent} />
            )}
            {page === 'documents' && <Documents onChanged={refreshStats} />}
            {page === 'analytics' && <Analytics onChanged={refreshStats} />}
            {page === 'papers' && <Papers onChanged={refreshStats} />}
            {page === 'research' && <Research onChanged={refreshStats} />}
            {page === 'mail' && <Mail onChanged={refreshStats} />}
            {page === 'automation' && <Automation onChanged={refreshStats} />}
            {page === 'connectors' && <Connectors onChanged={refreshStats} />}
            {page === 'platform' && <Platform onChanged={refreshStats} />}
            {page === 'settings' && <Settings user={user} aiMode={aiMode} onLogout={() => void logout()} onChanged={refreshStats} />}
          </main>
        </div>
      </div>
      <AgentDrawer open={agentOpen} onClose={() => setAgentOpen(false)} preset={preset} stats={stats} />
      <ActivityDrawer open={activityOpen} onClose={() => setActivityOpen(false)} />
      {accountOpen && (
        <AccountMenu username={user.username} mode={theme.mode} version={systemInfo?.version ?? ''}
          onMode={theme.setMode}
          onActivity={() => { setAccountOpen(false); setActivityOpen(true); }}
          onSettings={() => { setAccountOpen(false); navigate('settings'); }}
          onLogs={() => void downloadLogs()}
          onCheckUpdate={checkUpdates}
          onLogout={() => { setAccountOpen(false); void logout(); }}
          onClose={() => setAccountOpen(false)} />
      )}
    </>
  );
}
