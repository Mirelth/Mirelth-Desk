import { useCallback, useEffect, useState } from 'react';
import { AgentDrawer, type AgentPreset } from './components/AgentDrawer.tsx';
import { apiClient } from './lib/api.ts';
import { ToastProvider, Icon, IconButton, Button, type IconName } from './lib/ui.tsx';
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
  settings: { title: '设置', sub: 'AI 模型、邮箱账户与本机账号' },
};

const MODULE_PAGE: Record<string, PageId> = {
  document: 'documents', documents: 'documents', analytics: 'analytics', paper: 'papers',
  research: 'research', mail: 'mail', agent: 'dashboard', system: 'dashboard',
};

const NAV: Array<{ id: PageId; label: string; icon: IconName; hint: string }> = [
  { id: 'mail', label: '智能邮箱', icon: 'mail', hint: '收发与 AI 回复' },
  { id: 'automation', label: '自动化任务', icon: 'bolt', hint: '定时与手动执行' },
  { id: 'connectors', label: '技能专家连接器', icon: 'external', hint: '外部能力接入' },
];

function readPage(): PageId {
  const value = window.location.hash.replace(/^#\/?/, '') as PageId;
  return Object.prototype.hasOwnProperty.call(PAGE_META, value) ? value : 'dashboard';
}

export function App() {
  const [page, setPage] = useState<PageId>(readPage);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [aiMode, setAiMode] = useState<AiMode>('offline');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');
  const [agentOpen, setAgentOpen] = useState(false);
  const [preset, setPreset] = useState<AgentPreset | null>(null);
  const [collapsed, setCollapsed] = useState(false);

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

  const refreshStats = useCallback(async () => {
    if (!user) return;
    setStatsLoading(true);
    try {
      setStats(await apiClient.get<DashboardStats>('/api/dashboard'));
      setStatsError('');
    } catch (error) {
      setStatsError(error instanceof Error ? error.message : '统计加载失败');
    } finally {
      setStatsLoading(false);
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
  const counts: Partial<Record<PageId, number>> = { mail: stats?.unreadMail ?? 0 };

  return (
    <ToastProvider>
      <div className="app-shell">
        <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}>
          <div className="brand-row">
            <button type="button" className="brand" onClick={() => navigate('dashboard')} title="返回工作台首页">
              <div className="brand-mark"><Icon name="sparkles" size={18} /></div>
              <div><div className="brand-name">Mirelth Desk</div><div className="brand-sub">办公智能体 v1.0</div></div>
            </button>
            <IconButton icon="menu" title={collapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setCollapsed(!collapsed)} />
          </div>
          <div className="nav-section">常驻入口 ({NAV.length})</div>
          <nav>
            {NAV.map((item) => (
              <button type="button" key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => navigate(item.id)} title={`${item.label} · ${item.hint}`}>
                <Icon name={item.icon} size={17} />
                <span>{item.label}</span>
                {counts[item.id] ? <span className="nav-count">{counts[item.id]}</span> : null}
              </button>
            ))}
          </nav>
          <div className="nav-section">最近任务 ({Math.min(stats?.recent.length ?? 0, 3)})</div>
          <div className="sidebar-tasks">
            {(stats?.recent ?? []).slice(0, 3).map((item) => (
              <button type="button" className="sidebar-task" key={item.id} title={item.description}
                onClick={() => navigate(MODULE_PAGE[item.module] ?? 'dashboard')}>
                <span className="dot" /><span>{item.description}</span>
              </button>
            ))}
          </div>
          <div className="sidebar-foot">
            <div className={`ai-status-chip ${aiMode === 'offline' ? 'offline' : ''}`}>
              <span className="dot" />
              <span>{aiMode === 'offline' ? '离线规则引擎' : '模型已接入'}</span>
            </div>
            <div className="sidebar-user">
              <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
              <span>{user.username}</span>
            </div>
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
            {page !== 'dashboard' && !NAV.some((item) => item.id === page) && (
              <div className="back-bar">
                <Button variant="ghost" size="sm" icon="dashboard" onClick={() => navigate('dashboard')}>返回工作台</Button>
                <span>{meta.title} 从首页「应用宫格」进入</span>
              </div>
            )}
            {page === 'dashboard' && (
              <Dashboard stats={stats} loading={statsLoading} error={statsError} reload={() => void refreshStats()}
                navigate={navigate} openAgent={openAgent} />
            )}
            {page === 'documents' && <Documents onChanged={refreshStats} />}
            {page === 'analytics' && <Analytics onChanged={refreshStats} />}
            {page === 'papers' && <Papers onChanged={refreshStats} />}
            {page === 'research' && <Research onChanged={refreshStats} />}
            {page === 'mail' && <Mail onChanged={refreshStats} />}
            {page === 'automation' && <Automation onChanged={refreshStats} />}
            {page === 'connectors' && <Connectors onChanged={refreshStats} />}
            {page === 'settings' && <Settings user={user} aiMode={aiMode} onLogout={() => void logout()} />}
          </main>
        </div>
      </div>
      <AgentDrawer open={agentOpen} onClose={() => setAgentOpen(false)} preset={preset} stats={stats} />
    </ToastProvider>
  );
}
