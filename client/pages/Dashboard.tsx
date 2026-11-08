import { useState } from 'react';
import type { DashboardStats, PageId } from '../lib/types.ts';
import { Badge, ErrorBanner, Icon, useToast, type IconName } from '../lib/ui.tsx';

interface Props {
  stats: DashboardStats | null;
  loading: boolean;
  error: string;
  reload: () => void;
  navigate: (page: PageId) => void;
  openAgent: (text: string) => void;
}

type MetricKey = 'documents' | 'datasets' | 'papers' | 'experiments' | 'tasks' | 'unreadMail';

interface LaunchCard {
  icon: IconName; title: string; description: string; prompt: string;
  color: string; bg: string; tint: string;
}

interface HomeApp {
  icon: IconName; name: string; description: string; color: string; bg: string;
  page: PageId; metric?: MetricKey; unit?: string;
}

const TASK_SETS: LaunchCard[][] = [
  [
    { icon: 'file', title: '写一份周报', description: '汇总本周进展与下周计划，自动生成可用初稿', prompt: '帮我写本周工作周报', color: '#5b6cff', bg: '#eef0ff', tint: '#f4f6ff' },
    { icon: 'chart', title: '分析经营数据', description: '基于已导入的 CSV 计算趋势、分组差异与洞察', prompt: '分析上半年经营数据', color: '#13bfa2', bg: '#e4f9f4', tint: '#f1fcf9' },
    { icon: 'book', title: '整理文献综述', description: '按主题聚类，输出研究脉络与综述大纲', prompt: '整理 LLM 文献综述', color: '#f3a43a', bg: '#fff3df', tint: '#fffaf1' },
    { icon: 'flask', title: '设计实验方案', description: '假设、变量、评价指标与风险一次列清', prompt: '设计一个 A/B 实验', color: '#9b6cff', bg: '#f4efff', tint: '#faf7ff' },
  ],
  [
    { icon: 'mail', title: '起草一封邮件', description: '生成得体的商务回复，明确时间与下一步', prompt: '帮我起草一封项目进展邮件', color: '#ef6c83', bg: '#ffedf1', tint: '#fff6f8' },
    { icon: 'bolt', title: '生成洞察报告', description: '引用真实统计结果写报告，不编造数字', prompt: '生成上半年经营数据分析报告', color: '#3a8fdf', bg: '#e9f3ff', tint: '#f4f9ff' },
    { icon: 'inbox', title: '摘要未读邮件', description: '提取关键信息、明确诉求与待执行动作项', prompt: '摘要最新的未读邮件', color: '#13bfa2', bg: '#e4f9f4', tint: '#f1fcf9' },
    { icon: 'calendar', title: '规划研究里程碑', description: '把研究目标拆成阶段任务与验收标准', prompt: '生成研究计划与里程碑', color: '#9b6cff', bg: '#f4efff', tint: '#faf7ff' },
  ],
];

const CHIPS: Array<{ label: string; icon: IconName; prompt: string }> = [
  { label: '写周报', icon: 'file', prompt: '帮我写本周工作周报' },
  { label: '做调研', icon: 'search', prompt: '帮我整理一份行业调研提纲' },
  { label: '做表格', icon: 'layers', prompt: '帮我整理一份数据表格并说明字段口径' },
  { label: '搭应用', icon: 'bolt', prompt: '帮我规划一个自动化任务' },
  { label: '写文档', icon: 'edit', prompt: '帮我起草一份项目方案' },
  { label: '替我办', icon: 'sparkles', prompt: '帮我梳理今天需要处理的邮件和任务' },
];

const HOME_APPS: HomeApp[] = [
  { icon: 'file', name: '文档协作', description: '大纲、起草、润色与导出', color: '#5b6cff', bg: '#eef0ff', page: 'documents', metric: 'documents', unit: '篇' },
  { icon: 'chart', name: '数据分析', description: 'CSV 统计、图表与报告', color: '#13bfa2', bg: '#e4f9f4', page: 'analytics', metric: 'datasets', unit: '个' },
  { icon: 'book', name: '论文整理', description: '文献库、引用与综述', color: '#f3a43a', bg: '#fff3df', page: 'papers', metric: 'papers', unit: '篇' },
  { icon: 'flask', name: '科学研究', description: '项目、实验与任务看板', color: '#9b6cff', bg: '#f4efff', page: 'research', metric: 'experiments', unit: '个' },
  { icon: 'mail', name: '智能邮箱', description: '收发、摘要与回复', color: '#ef6c83', bg: '#ffedf1', page: 'mail', metric: 'unreadMail', unit: '封未读' },
  { icon: 'settings', name: '设置', description: '模型、账户与本机状态', color: '#3a8fdf', bg: '#e9f3ff', page: 'settings' },
];

const PERMANENT: Array<{ icon: IconName; label: string; page: PageId }> = [
  { icon: 'mail', label: '智能邮箱', page: 'mail' },
  { icon: 'bolt', label: '自动化任务', page: 'automation' },
  { icon: 'external', label: '技能专家连接器', page: 'connectors' },
];

export function Dashboard({ stats, loading, error, reload, navigate, openAgent }: Props) {
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [activeChip, setActiveChip] = useState('做调研');
  const [cardSet, setCardSet] = useState(0);
  const [attachOpen, setAttachOpen] = useState(false);

  const send = (text: string) => {
    const value = text.trim();
    if (!value) return;
    openAgent(value);
    setQuestion('');
    setActiveChip('');
    setAttachOpen(false);
  };

  const pickChip = (chip: typeof CHIPS[number]) => {
    setActiveChip(chip.label);
    setQuestion(chip.prompt);
  };

  return (
    <div className="page launch-page">
      <div className="launch-inner">
        <div className="launch-mark"><Icon name="sparkles" size={32} /></div>
        <h1 className="launch-title">你说我做，随时待命</h1>

        <div className="launch-chip-bar">
          <span className="label">想做点什么：</span>
          {CHIPS.map((chip) => (
            <button type="button" key={chip.label} className={`launch-chip ${activeChip === chip.label ? 'active' : ''}`}
              onClick={() => pickChip(chip)}>
              <Icon name={chip.icon} size={14} />{chip.label}
            </button>
          ))}
        </div>

        {error && <div className="mt-16"><ErrorBanner message={error} onRetry={reload} /></div>}

        <div className="launch-cards">
          {TASK_SETS[cardSet].map((card) => (
            <button type="button" key={card.title} className="launch-card"
              style={{ background: `linear-gradient(150deg, ${card.tint}, #ffffff)` }}
              onClick={() => openAgent(card.prompt)}>
              <span className="launch-card-icon" style={{ color: card.color }}><Icon name={card.icon} size={22} /></span>
              <h4>{card.title}</h4>
              <p>{card.description}</p>
            </button>
          ))}
        </div>
        <div className="launch-refresh">
          <button type="button" className="launch-chip" onClick={() => setCardSet((value) => (value + 1) % TASK_SETS.length)}>
            <Icon name="refresh" size={14} />换一换
          </button>
        </div>

        <div className="launch-composer">
          <div className="launch-composer-top">
            <span className="launch-tag"><Icon name="shield" size={12} />本地运行<Icon name="down" size={12} /></span>
            <span className="launch-tag"><Icon name="layers" size={12} />Mirelth 工作台<Icon name="down" size={12} /></span>
          </div>
          <textarea className="launch-textarea" value={question}
            placeholder="如果我有做得不好的地方，请及时发消息指正，这样我会越来越懂您"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(question); } }} />
          {attachOpen && (
            <div className="attach-menu">
              <button type="button" onClick={() => { setAttachOpen(false); navigate('analytics'); }}>导入 CSV 数据</button>
              <button type="button" onClick={() => { setAttachOpen(false); navigate('documents'); }}>从模板写文档</button>
              <button type="button" onClick={() => { setAttachOpen(false); navigate('papers'); }}>粘贴 BibTeX 文献</button>
            </div>
          )}
          <div className="launch-composer-foot">
            <button type="button" className="launch-plus" title="添加材料" onClick={() => setAttachOpen(!attachOpen)}>
              <Icon name="plus" size={15} />
            </button>
            <span className="grow" />
            <span className="launch-select" title="仅使用本机数据">默认权限 <Icon name="down" size={12} /></span>
            <span className="launch-select" title="当前生成引擎">智能 <Icon name="down" size={12} /></span>
            <button type="button" className="launch-plus" title="语音输入" onClick={() => toast('语音输入暂未接入，可直接输入文字', 'info')}>
              <Icon name="mic" size={15} />
            </button>
            <button type="button" className="launch-send" title="发送给智能体" disabled={!question.trim()} onClick={() => send(question)}>
              <Icon name="send" size={16} />
            </button>
          </div>
        </div>
        <div className="launch-disclaimer">内容由 AI 生成，需人工核对；离线引擎仅基于你提供的数据，不编造事实</div>

        <div className="launch-divider" />
        <div className="launch-section-head">
          <div><h3>全部应用</h3><p>文档协作、数据分析、论文整理、科学研究、邮箱与设置</p></div>
          <Badge tone="blue">{HOME_APPS.length} 个应用</Badge>
        </div>
        <div className="launch-apps">
          {HOME_APPS.map((app) => (
            <button type="button" className="launch-app" key={app.page} onClick={() => navigate(app.page)}>
              <span className="launch-app-icon" style={{ color: app.color, background: app.bg }}><Icon name={app.icon} size={17} /></span>
              <span><h5>{app.name}</h5><p>{app.description}</p></span>
              {app.metric && <span className="metric">{stats?.[app.metric] ?? 0} {app.unit}</span>}
            </button>
          ))}
        </div>
        <div className="row wrap mt-16">
          <span className="text-sm muted">常驻服务</span>
          {PERMANENT.map((item) => (
            <button type="button" className="chip" key={item.page} onClick={() => navigate(item.page)}>
              <Icon name={item.icon} size={13} />{item.label}
            </button>
          ))}
        </div>
        <div className="launch-stats">
          {loading ? '正在加载工作台数据…' : `${stats?.documents ?? 0} 篇文档 · ${stats?.datasets ?? 0} 个数据集 · ${stats?.papers ?? 0} 篇文献 · ${stats?.experiments ?? 0} 个实验 · ${stats?.unreadMail ?? 0} 封未读邮件`}
        </div>
      </div>
    </div>
  );
}
