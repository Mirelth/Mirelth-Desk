import { useState } from 'react';
import { apiClient, getErrorMessage } from '../../lib/api.ts';
import { useLoad } from '../../lib/hooks.ts';
import type { BrowserResult, BrowserRun, BrowserStatus } from '../../lib/types.ts';
import { Badge, Button, EmptyState, Field, Icon, formatDate, useToast } from '../../lib/ui.tsx';

const ACTIONS = [
  { value: 'open', label: '打开', sensitive: false },
  { value: 'read', label: '读正文', sensitive: false },
  { value: 'screenshot', label: '截图', sensitive: false },
  { value: 'click', label: '点击', sensitive: true },
  { value: 'fill', label: '填写', sensitive: true },
];

/**
 * 浏览器 tab：连接本机已有浏览器（CDP），默认关闭。
 * 点击与填写属敏感动作，必须勾选确认才发送——它们可能触发提交、发送或支付。
 */
export function PlatformBrowser() {
  const toast = useToast();
  const status = useLoad<BrowserStatus>(() => apiClient.get<BrowserStatus>('/api/browser/status'));
  const runs = useLoad<BrowserRun[]>(() => apiClient.get<BrowserRun[]>('/api/browser/runs'));

  const [action, setAction] = useState('read');
  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('');
  const [value, setValue] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BrowserResult | null>(null);

  const current = ACTIONS.find((item) => item.value === action);
  const needsConfirm = current?.sensitive ?? false;
  const needsSelector = action === 'click' || action === 'fill';

  const run = async () => {
    if (!url.trim()) { toast('请填写目标网址', 'error'); return; }
    if (needsSelector && !selector.trim()) { toast('点击与填写需要 CSS 选择器', 'error'); return; }
    if (needsConfirm && !confirmed) { toast('敏感动作请先勾选确认', 'error'); return; }
    setBusy(true);
    try {
      const data = await apiClient.post<BrowserResult>('/api/browser/run', {
        action, url: url.trim(), selector: selector.trim() || undefined,
        value: value || undefined, confirmed,
      });
      setResult(data);
      await runs.reload();
      toast('执行完成', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid-2">
      <div className="card card-pad">
        <div className="section-head mb-12">
          <div>
            <h4>浏览器自动化</h4>
            <div className="text-xs muted mt-8">{status.data?.note ?? '读取状态中…'}</div>
          </div>
          <Badge tone={status.data?.enabled ? 'green' : 'amber'}>{status.data?.enabled ? '已启用' : '未启用'}</Badge>
        </div>

        {!status.data?.enabled && (
          <div className="card-pad mb-12" style={{ background: 'var(--surface-2)', borderRadius: 10 }}>
            <div className="text-sm mb-8"><strong>默认关闭，这是有意的安全设计</strong></div>
            <div className="text-xs muted">
              开启步骤：① 在 .env 设置 <code>BROWSER_ENABLED=true</code>；
              ② 用 <code>BROWSER_ALLOWED_HOSTS</code> 显式授权域名（留空则拒绝全部）；
              ③ 用独立用户目录启动浏览器调试端口（Chrome 136+ 必需 <code>--user-data-dir</code>）；④ 重启服务。
            </div>
            <div className="text-xs muted mt-8">
              注意：独立用户目录是全新 profile，<strong>不会复用你日常浏览器的登录态</strong>，首次需在自动化浏览器里登录目标站点。
            </div>
          </div>
        )}

        <div className="row wrap mb-12">
          {ACTIONS.map((item) => (
            <Button key={item.value} size="sm" variant={action === item.value ? 'primary' : 'ghost'}
              onClick={() => { setAction(item.value); setConfirmed(false); }}>
              {item.label}{item.sensitive ? ' ⚠' : ''}
            </Button>
          ))}
        </div>

        <Field label="目标网址" hint={status.data?.allowedHosts.length ? `已授权：${status.data.allowedHosts.join('、')}` : '白名单为空，当前会拒绝所有站点'}>
          <input className="input" value={url} placeholder="https://example.com/page" onChange={(event) => setUrl(event.target.value)} />
        </Field>

        {needsSelector && (
          <Field label="CSS 选择器" hint="例如 button.submit 或 #search-input">
            <input className="input" value={selector} onChange={(event) => setSelector(event.target.value)} />
          </Field>
        )}
        {action === 'fill' && (
          <Field label="填入内容" hint="内容不会被写入审计日志">
            <input className="input" value={value} onChange={(event) => setValue(event.target.value)} />
          </Field>
        )}

        {needsConfirm && (
          <label className="row mb-12" style={{ gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span className="text-xs">
              我已确认此操作：点击或填写可能触发<strong>提交表单、发送消息或支付</strong>等不可逆后果，由我承担。
            </span>
          </label>
        )}

        <Button icon="bolt" loading={busy} disabled={!status.data?.enabled} onClick={() => void run()}>执行</Button>

        {result && (
          <div className="mt-16">
            <div className="text-xs muted mb-8">执行结果{result.url ? ` · ${result.url}` : ''}</div>
            {result.screenshotBase64
              ? <img src={`data:image/png;base64,${result.screenshotBase64}`} alt="页面截图" style={{ maxWidth: '100%', borderRadius: 8 }} />
              : <pre className="text-xs" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>{result.text}</pre>}
          </div>
        )}
      </div>

      <div className="card card-pad">
        <div className="section-head mb-12">
          <div><h4>操作留痕</h4><div className="text-xs muted mt-8">每次导航、点击与填写都记录，可回溯</div></div>
          <Icon name="eye" size={16} className="muted" />
        </div>
        {runs.data?.length ? (
          <div className="stack-sm" style={{ maxHeight: 460, overflowY: 'auto' }}>
            {runs.data.map((item) => (
              <div key={item.id} className="card-pad" style={{ background: 'var(--surface-2)', borderRadius: 10 }}>
                <div className="row wrap mb-8">
                  <Badge tone={item.status === 'success' ? 'green' : item.status === 'blocked' ? 'amber' : 'rose'}>{item.status}</Badge>
                  <code className="text-xs">{item.action}</code>
                  <span className="grow" />
                  <span className="text-xs muted">{formatDate(item.created_at)}</span>
                </div>
                <div className="text-xs">{item.target}</div>
                {item.detail && <div className="text-xs muted mt-8">{item.detail.slice(0, 160)}</div>}
              </div>
            ))}
          </div>
        ) : <EmptyState icon="external" title="还没有操作记录" hint="启用后执行的每一步都会出现在这里。" />}
      </div>
    </div>
  );
}