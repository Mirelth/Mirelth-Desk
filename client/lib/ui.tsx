import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { renderMarkdown } from './markdown.ts';

export type IconName =
  | 'dashboard' | 'file' | 'chart' | 'book' | 'flask' | 'mail' | 'sparkles' | 'plus' | 'search'
  | 'refresh' | 'download' | 'trash' | 'edit' | 'check' | 'close' | 'send' | 'settings' | 'logout'
  | 'copy' | 'save' | 'upload' | 'clock' | 'arrow' | 'eye' | 'user' | 'info' | 'bolt' | 'inbox'
  | 'folder' | 'external' | 'more' | 'chevron' | 'wand' | 'shield' | 'tag' | 'calendar' | 'menu'
  | 'headphones' | 'bell' | 'mic' | 'down' | 'layers';

const ICONS: Record<IconName, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>,
  chart: <><path d="M3 3v18h18" /><rect x="7" y="12" width="3" height="6" rx="1" /><rect x="12" y="8" width="3" height="10" rx="1" /><rect x="17" y="5" width="3" height="13" rx="1" /></>,
  book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /><path d="M9 7h7" /></>,
  flask: <><path d="M9 2h6M10 2v6L4 19a2 2 0 0 0 1.8 3h12.4A2 2 0 0 0 20 19l-6-11V2" /><path d="M7 15h10" /></>,
  mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m2 7 10 6 10-6" /></>,
  sparkles: <><path d="m12 3 1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" /><path d="m19 15 .8 1.7L21.5 17.5l-1.7.8L19 20l-.8-1.7-1.7-.8 1.7-1.7zM5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6z" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  check: <><path d="m4 12 5 5L20 6" /></>,
  close: <><path d="M6 6l12 12M18 6 6 18" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></>,
  upload: <><path d="M12 16V4m0 0-4 4m4-4 4 4" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  bolt: <><path d="m13 2-9 12h7l-1 8 9-12h-7z" /></>,
  inbox: <><path d="M4 4h16l2 9v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z" /><path d="M2 13h6l1 3h6l1-3h6" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
  chevron: <><path d="m9 6 6 6-6 6" /></>,
  wand: <><path d="m4 20 12-12 4 4L8 24z" /><path d="M16 3v4M21 5l-3 2M14 8l3-2" /></>,
  shield: <><path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z" /><path d="m9 12 2 2 4-4" /></>,
  tag: <><path d="M20 12 12 20 3 11V4h7z" /><circle cx="7.5" cy="8.5" r="1.2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  headphones: <><path d="M3 14v-2a9 9 0 0 1 18 0v2" /><path d="M3 14h3a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2zM21 14h-3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2z" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" /></>,
  down: <><path d="m6 9 6 6 6-6" /></>,
  layers: <><path d="m12 2 9 5-9 5-9-5z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></>,
};

export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

type ToastType = 'success' | 'error' | 'info';
interface ToastItem { id: number; message: string; type: ToastType }
const ToastContext = createContext<(message: string, type?: ToastType) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = (message: string, type: ToastType = 'info') => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, message, type }]);
    setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 3600);
  };
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-stack">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.type}`}>
            <Icon name={item.type === 'success' ? 'check' : item.type === 'error' ? 'close' : 'info'} size={16} />
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function Button({
  children, onClick, variant = 'primary', size = 'md', icon, loading, disabled, title, type = 'button',
}: {
  children?: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'outline' | 'danger' | 'soft';
  size?: 'sm' | 'md'; icon?: IconName; loading?: boolean; disabled?: boolean; title?: string; type?: 'button' | 'submit';
}) {
  return (
    <button type={type} className={`btn btn-${variant} btn-${size}`} onClick={onClick}
      disabled={disabled || loading} title={title}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, onClick, title, disabled, active }: {
  icon: IconName; onClick?: () => void; title: string; disabled?: boolean; active?: boolean;
}) {
  return (
    <button type="button" className={`icon-btn ${active ? 'is-active' : ''}`} onClick={onClick}
      title={title} aria-label={title} disabled={disabled}>
      <Icon name={icon} size={16} />
    </button>
  );
}

export function Modal({ open, onClose, title, subtitle, children, footer, width = 560 }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: ReactNode; footer?: ReactNode; width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>
          <IconButton icon="close" title="关闭" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: Array<{ value: T; label: string }>; value: T; onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button type="button" key={option.value} className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'violet' | 'rose' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Skeleton({ height = 80 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} />;
}

export function EmptyState({ icon = 'folder', title, hint, action }: {
  icon?: IconName; title: string; hint?: string; action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={icon} size={26} /></div>
      <h4>{title}</h4>{hint && <p>{hint}</p>}{action}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner">
      <Icon name="info" size={16} />
      <span>{message}</span>
      {onRetry && <button type="button" onClick={onRetry}>重试</button>}
    </div>
  );
}

export function MarkdownView({ source, className = '' }: { source: string; className?: string }) {
  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />;
}

export function AiOutput({ text, running, error, label, onInsert, onReplace, onCopy, emptyHint = '点击上方按钮，让智能体基于当前材料生成内容。' }: {
  text: string; running: boolean; error: string; label?: string;
  onInsert?: () => void; onReplace?: () => void; onCopy?: () => void; emptyHint?: string;
}) {
  if (!text && !running && !error) {
    return <div className="ai-empty"><Icon name="sparkles" size={22} /><p>{emptyHint}</p></div>;
  }
  return (
    <div className="ai-output">
      <div className="ai-output-head">
        <span className="ai-output-label"><Icon name="sparkles" size={14} />{label ?? '智能体输出'}{running && <span className="typing" />}</span>
        <div className="ai-output-actions">
          {onCopy && text && <IconButton icon="copy" title="复制内容" onClick={onCopy} />}
          {onInsert && text && !running && <Button variant="soft" size="sm" icon="plus" onClick={onInsert}>追加到内容</Button>}
          {onReplace && text && !running && <Button variant="soft" size="sm" icon="check" onClick={onReplace}>替换内容</Button>}
        </div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <MarkdownView source={text} className="ai-markdown" />
    </div>
  );
}

function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 120) setWidth(Math.round(measured));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function BarChart({ data, unit = '' }: { data: Array<{ label: string; value: number }>; unit?: string }) {
  const { ref, width } = useChartWidth();
  if (!data.length) return <EmptyState icon="chart" title="暂无分组数据" />;
  const height = 230, left = 44, bottom = 34, top = 18;
  const max = Math.max(...data.map((item) => item.value), 1);
  const plotHeight = height - bottom - top;
  const step = (width - left - 20) / data.length;
  const barWidth = Math.min(step * 0.56, 52);
  const labelEvery = step < 52 ? Math.ceil(52 / step) : 1;
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="分组柱状图">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = top + plotHeight * (1 - ratio);
          return <g key={ratio}><line x1={left} y1={y} x2={width - 12} y2={y} className="chart-grid" />
            <text x={left - 8} y={y + 4} textAnchor="end" className="chart-label">{(max * ratio).toFixed(0)}</text></g>;
        })}
        {data.map((item, index) => {
          const barHeight = (item.value / max) * plotHeight;
          const x = left + step * index + (step - barWidth) / 2;
          return <g key={`${item.label}-${index}`}>
            <rect x={x} y={top + plotHeight - barHeight} width={barWidth} height={Math.max(barHeight, 2)} rx="6" className="chart-bar" />
            {barWidth >= 18 && <text x={x + barWidth / 2} y={top + plotHeight - barHeight - 6} textAnchor="middle" className="chart-value">{item.value}{unit}</text>}
            {index % labelEvery === 0 && <text x={x + barWidth / 2} y={height - 10} textAnchor="middle" className="chart-label">{item.label}</text>}
          </g>;
        })}
      </svg>
    </div>
  );
}

export function LineChart({ data }: { data: Array<{ label: string; value: number }> }) {
  const { ref, width } = useChartWidth();
  if (data.length < 2) return <EmptyState icon="chart" title="趋势数据不足" />;
  const height = 230, left = 44, bottom = 34, top = 18;
  const values = data.map((item) => item.value);
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const range = max - min || 1;
  const plotHeight = height - bottom - top;
  const step = (width - left - 20) / (data.length - 1);
  const labelEvery = step < 52 ? Math.ceil(52 / step) : 1;
  const points = data.map((item, index) => ({
    x: left + step * index,
    y: top + plotHeight * (1 - (item.value - min) / range),
  }));
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${line} L${points[points.length - 1].x.toFixed(1)},${top + plotHeight} L${points[0].x.toFixed(1)},${top + plotHeight} Z`;
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="趋势折线图">
        <defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6c7cff" stopOpacity="0.28" /><stop offset="100%" stopColor="#6c7cff" stopOpacity="0" />
        </linearGradient></defs>
        {[0, 0.5, 1].map((ratio) => {
          const y = top + plotHeight * (1 - ratio);
          return <g key={ratio}><line x1={left} y1={y} x2={width - 12} y2={y} className="chart-grid" />
            <text x={left - 8} y={y + 4} textAnchor="end" className="chart-label">{(min + range * ratio).toFixed(0)}</text></g>;
        })}
        <path d={area} fill="url(#areaFill)" />
        <path d={line} className="chart-line" />
        {points.map((point, index) => <g key={index}>
          <circle cx={point.x} cy={point.y} r="4" className="chart-dot" />
          {index % labelEvery === 0 && <text x={point.x} y={height - 10} textAnchor="middle" className="chart-label">{data[index].label}</text>}
        </g>)}
      </svg>
    </div>
  );
}

export function SectionTitle({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="section-title">
      <div><h3>{title}</h3>{hint && <p>{hint}</p>}</div>
      {action}
    </div>
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toFixed(2);
}
