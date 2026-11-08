import { useEffect, useState } from 'react';
import { apiClient, getErrorMessage, streamTask } from '../lib/api.ts';
import { useLoad, useStream } from '../lib/hooks.ts';
import type { MailAccountDto, MailStatus, MessageDto } from '../lib/types.ts';
import {
  AiOutput, Badge, Button, EmptyState, ErrorBanner, Field, Icon, IconButton, MarkdownView, Modal,
  Skeleton, formatDate, useToast,
} from '../lib/ui.tsx';

interface AccountForm {
  email: string; username: string; password: string;
  imapHost: string; imapPort: number; imapSecure: boolean;
  smtpHost: string; smtpPort: number; smtpSecure: boolean;
}
interface ComposeForm { to: string; subject: string; body: string }

const EMPTY_ACCOUNT: AccountForm = {
  email: '', username: '', password: '', imapHost: 'imap.qq.com', imapPort: 993, imapSecure: true,
  smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: true,
};
const EMPTY_COMPOSE: ComposeForm = { to: '', subject: '', body: '' };

const PRESETS: Array<{ name: string; patch: Partial<AccountForm> }> = [
  { name: 'QQ 邮箱', patch: { imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: true } },
  { name: '163 邮箱', patch: { imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: true } },
  { name: 'Gmail', patch: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecure: false } },
  { name: 'Outlook', patch: { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false } },
];

export function Mail({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const [folder, setFolder] = useState<'inbox' | 'sent'>('inbox');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const status = useLoad<MailStatus>(() => apiClient.get<MailStatus>('/api/mail/status'));
  const listQuery = `/api/mail/messages?folder=${folder}&q=${encodeURIComponent(q)}&limit=100`;
  const messages = useLoad<MessageDto[]>(() => apiClient.get<MessageDto[]>(listQuery), [listQuery]);
  const detail = useLoad<MessageDto | null>(() =>
    selectedId ? apiClient.get<MessageDto>(`/api/mail/messages/${selectedId}`) : Promise.resolve(null), [selectedId]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeForm>(EMPTY_COMPOSE);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accounts, setAccounts] = useState<MailAccountDto[]>([]);
  const [accountForm, setAccountForm] = useState<AccountForm>(EMPTY_ACCOUNT);
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [tone, setTone] = useState('专业礼貌');
  const [aiAction, setAiAction] = useState<'reply' | 'summary' | ''>('');
  const stream = useStream();

  useEffect(() => {
    if (!messages.data?.length) { setSelectedId(null); return; }
    if (!selectedId || !messages.data.some((item) => item.id === selectedId)) setSelectedId(messages.data[0].id);
  }, [messages.data, selectedId]);

  const loadAccounts = async () => {
    try { setAccounts(await apiClient.get<MailAccountDto[]>('/api/mail/accounts')); } catch { /* ignore */ }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await apiClient.post<{ synced: number; note?: string }>('/api/mail/sync');
      await Promise.all([messages.reload(), status.reload()]);
      onChanged?.();
      toast(result.note ?? `同步完成，新增 ${result.synced} 封邮件`, 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setSyncing(false); }
  };

  const send = async () => {
    setSending(true);
    try {
      const result = await apiClient.post<{ delivered: boolean; note: string }>('/api/mail/send', compose);
      setComposeOpen(false); setCompose(EMPTY_COMPOSE);
      setFolder('sent');
      await messages.reload();
      onChanged?.();
      toast(result.note, result.delivered ? 'success' : 'info');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
    finally { setSending(false); }
  };

  const saveAccount = async () => {
    try {
      await apiClient.post('/api/mail/accounts', accountForm);
      setAccountOpen(false);
      setAccountForm(EMPTY_ACCOUNT);
      await Promise.all([status.reload(), loadAccounts()]);
      toast('邮箱账户已保存，密码经加密后仅存本机', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const removeAccount = async (id: string) => {
    if (!window.confirm('确定移除该邮箱账户？')) return;
    try {
      await apiClient.delete(`/api/mail/accounts/${id}`);
      await Promise.all([status.reload(), loadAccounts()]);
      toast('账户已移除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const runReply = async () => {
    const current = detail.data;
    if (!current || stream.running) return;
    stream.reset(); setAiAction('reply'); stream.setRunning(true);
    let full = '';
    try {
      await streamTask('mail.reply', { subject: current.subject, from: current.from, body: current.body, tone }, {
        onDelta: (chunk) => { full += chunk; stream.setText(full); },
        onMeta: (meta) => stream.setLabel(meta.label),
        onError: (message) => stream.setError(message),
      });
    } catch (error) { stream.setError(getErrorMessage(error)); }
    finally { stream.setRunning(false); }
  };

  const runSummary = async () => {
    const current = detail.data;
    if (!current) return;
    stream.reset(); setAiAction('summary'); stream.setRunning(true);
    try {
      const result = await apiClient.post<{ text: string; mode: string }>('/api/mail/ai', { action: 'summary', messageId: current.id });
      stream.setText(result.text);
      stream.setLabel('邮件摘要');
      await detail.reload();
      toast('摘要已生成并保存到邮件', 'success');
    } catch (error) { stream.setError(getErrorMessage(error)); }
    finally { stream.setRunning(false); }
  };

  const draftCompose = async () => {
    try {
      const result = await apiClient.post<{ text: string }>('/api/mail/ai', {
        action: 'compose', to: compose.to, subject: compose.subject,
        points: compose.body.split('\n').map((line) => line.trim()).filter(Boolean),
      });
      setCompose({ ...compose, body: result.text });
      toast('已生成邮件草稿，请人工核对', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  const openReply = () => {
    const current = detail.data;
    if (!current) return;
    setCompose({
      to: current.from.replace(/.*<([^>]+)>/, '$1'),
      subject: current.subject.startsWith('Re:') ? current.subject : `Re: ${current.subject}`,
      body: stream.text,
    });
    setComposeOpen(true);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>智能邮箱</h1><p>IMAP 收件同步、SMTP 发送，AI 生成摘要与回复草稿</p></div>
        <div className="page-actions">
          <Button variant="outline" icon="settings" onClick={() => { void loadAccounts(); setAccountOpen(true); }}>邮箱设置</Button>
          <Button variant="outline" icon="refresh" loading={syncing} onClick={() => void sync()}>同步收件箱</Button>
          <Button icon="edit" onClick={() => { setCompose(EMPTY_COMPOSE); setComposeOpen(true); }}>写邮件</Button>
        </div>
      </div>

      {!status.loading && !status.data?.configured && (
        <div className="error-banner" style={{ background: '#fff8e9', color: '#a2701a', borderColor: '#ffe6b8' }}>
          <Icon name="info" size={16} />
          <span>当前为演示模式：展示内置样例邮件，发送仅保存到本地「已发送」。配置 IMAP / SMTP 后即可真实收发。</span>
          <button type="button" onClick={() => { void loadAccounts(); setAccountOpen(true); }}>去配置</button>
        </div>
      )}
      {messages.error && <ErrorBanner message={messages.error} onRetry={() => void messages.reload()} />}

      <div className="mail-layout">
        <div className="card mail-folders">
          <button type="button" className={`folder-item ${folder === 'inbox' ? 'active' : ''}`} onClick={() => { setFolder('inbox'); setSelectedId(null); }}>
            <Icon name="inbox" size={16} />收件箱<span className="count">{messages.data?.filter((item) => !item.isRead && folder === 'inbox').length ?? 0}</span>
          </button>
          <button type="button" className={`folder-item ${folder === 'sent' ? 'active' : ''}`} onClick={() => { setFolder('sent'); setSelectedId(null); }}>
            <Icon name="send" size={16} />已发送
          </button>
          <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 10, padding: '12px 10px 2px' }}>
            <div className="text-xs muted" style={{ lineHeight: 1.8 }}>
              账户：{status.data?.configured ? status.data.account?.email : '未配置'}<br />
              投递：{status.data?.configured ? 'SMTP' : '本地演示'}
            </div>
          </div>
        </div>

        <div className="card mail-list">
          <div className="list-search"><div className="search-box"><Icon name="search" size={15} />
            <input placeholder="搜索邮件…" value={q} onChange={(event) => setQ(event.target.value)} /></div></div>
          <div className="list-scroll">
            {messages.loading && !messages.data ? <div style={{ padding: 12 }}><Skeleton height={70} /><Skeleton height={70} /></div> : null}
            {messages.data?.length ? messages.data.map((message) => (
              <button type="button" key={message.id} className={`list-item ${selectedId === message.id ? 'active' : ''}`}
                onClick={() => { setSelectedId(message.id); stream.reset(); setAiAction(''); }}>
                <div className="list-title">
                  {!message.isRead && folder === 'inbox' && <span className="unread" />}
                  {message.subject || '（无主题）'}
                </div>
                <div className="list-meta"><span>{folder === 'inbox' ? message.from : `至 ${message.to}`}</span><span>{formatDate(message.sentAt)}</span></div>
                <div className="list-excerpt">{message.excerpt}</div>
              </button>
            )) : !messages.loading && <EmptyState icon="mail" title="没有邮件" hint="点击「同步收件箱」拉取新邮件。" />}
          </div>
        </div>

        <div className="card mail-detail">
          {!detail.data ? <EmptyState icon="mail" title="选择一封邮件" hint="左侧列表中选择邮件以查看正文和 AI 能力。" /> : (
            <>
              <div className="toolbar">
                <Button variant="soft" size="sm" icon="eye" disabled={stream.running} onClick={() => void runSummary()}>AI 摘要</Button>
                <Button variant="soft" size="sm" icon="wand" disabled={stream.running} onClick={() => void runReply()}>起草回复</Button>
                <select className="select" style={{ width: 116 }} value={tone} onChange={(event) => setTone(event.target.value)}>
                  <option>专业礼貌</option><option>简洁</option><option>正式</option><option>友好</option>
                </select>
                <span className="grow" />
                {detail.data.simulated && <Badge tone="amber">演示邮件</Badge>}
                <IconButton icon="mail" title="标记为未读" onClick={() => void apiClient.patch(`/api/mail/messages/${detail.data?.id}`, { isRead: false }).then(() => { void messages.reload(); void detail.reload(); }).catch((error) => toast(getErrorMessage(error), 'error'))} />
              </div>
              <div className="mail-head">
                <h2>{detail.data.subject || '（无主题）'}</h2>
                <div className="mail-from">
                  <span className="avatar">{(folder === 'inbox' ? detail.data.from : detail.data.to).slice(0, 1).toUpperCase()}</span>
                  <div><div className="who">{folder === 'inbox' ? detail.data.from : `收件人：${detail.data.to}`}</div>
                    <div className="text-xs muted">{folder === 'inbox' ? `收件人：${detail.data.to}` : detail.data.from}</div></div>
                  <span className="when">{formatDate(detail.data.sentAt)}</span>
                </div>
              </div>
              {detail.data.aiSummary && (
                <div className="card-pad" style={{ background: '#f7f9ff', borderBottom: '1px solid var(--line-soft)' }}>
                  <div className="row mb-12"><Icon name="sparkles" size={15} className="muted" /><strong className="text-sm">已保存的 AI 摘要</strong></div>
                  <MarkdownView source={detail.data.aiSummary} />
                </div>
              )}
              <div className="mail-body">{detail.data.body || '（正文为空）'}</div>
              <div className="ai-panel" style={{ borderTop: '1px solid var(--line-soft)' }}>
                <AiOutput text={stream.text} running={stream.running} error={stream.error}
                  label={`${aiAction === 'reply' ? '回复草稿' : aiAction === 'summary' ? '邮件摘要' : '智能体输出'}${stream.label ? ` · ${stream.label}` : ''}`}
                  onCopy={() => { void navigator.clipboard.writeText(stream.text).then(() => toast('已复制', 'success')); }}
                  emptyHint="点击「AI 摘要」或「起草回复」，基于当前邮件正文生成内容。" />
                {aiAction === 'reply' && stream.text && !stream.running && (
                  <div className="mt-12"><Button variant="primary" size="sm" icon="send" onClick={openReply}>用作回复并发送</Button></div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <Modal open={composeOpen} onClose={() => setComposeOpen(false)} title="写邮件" subtitle="AI 生成草稿后请人工核对再发送" width={680}
        footer={<>
          <Button variant="soft" size="sm" icon="wand" onClick={() => void draftCompose()}>AI 起草</Button>
          <span className="grow" />
          <Button variant="ghost" onClick={() => setComposeOpen(false)}>取消</Button>
          <Button icon="send" loading={sending} onClick={() => void send()}>发送</Button>
        </>}>
        <div className="form-grid">
          <div className="full"><Field label="收件人"><input className="input" value={compose.to} placeholder="name@example.com" onChange={(event) => setCompose({ ...compose, to: event.target.value })} /></Field></div>
          <div className="full"><Field label="主题"><input className="input" value={compose.subject} onChange={(event) => setCompose({ ...compose, subject: event.target.value })} /></Field></div>
          <div className="full"><Field label="正文" hint="也可以在正文里每行写一个要点，再点击「AI 起草」扩写"><textarea className="textarea" style={{ minHeight: 220 }} value={compose.body} onChange={(event) => setCompose({ ...compose, body: event.target.value })} /></Field></div>
        </div>
      </Modal>

      <Modal open={accountOpen} onClose={() => setAccountOpen(false)} title="邮箱账户设置" width={680}
        subtitle="凭据使用 AES-256-GCM 加密后仅保存在本机 SQLite"
        footer={<><Button variant="ghost" onClick={() => setAccountOpen(false)}>关闭</Button><Button icon="save" onClick={() => void saveAccount()}>保存账户</Button></>}>
        <div className="chip-row mb-16">
          {PRESETS.map((preset) => (
            <button type="button" className="chip" key={preset.name} onClick={() => setAccountForm({ ...accountForm, ...preset.patch })}>{preset.name}</button>
          ))}
        </div>
        {accounts.length > 0 && <div className="mb-16">
          {accounts.map((account) => (
            <div className="info-row" key={account.id}>
              <span><strong>{account.email}</strong><span className="muted text-xs"> · {account.imapHost} / {account.smtpHost}</span></span>
              <IconButton icon="trash" title="移除账户" onClick={() => void removeAccount(account.id)} />
            </div>
          ))}
        </div>}
        <div className="form-grid">
          <Field label="邮箱地址"><input className="input" value={accountForm.email} placeholder="me@example.com" onChange={(event) => setAccountForm({ ...accountForm, email: event.target.value })} /></Field>
          <Field label="登录账号" hint="留空则使用邮箱地址"><input className="input" value={accountForm.username} onChange={(event) => setAccountForm({ ...accountForm, username: event.target.value })} /></Field>
          <div className="full"><Field label="授权码 / 密码" hint="多数服务商需要开启 IMAP/SMTP 并使用应用专用授权码"><input className="input" type="password" value={accountForm.password} onChange={(event) => setAccountForm({ ...accountForm, password: event.target.value })} /></Field></div>
          <Field label="IMAP 服务器"><input className="input" value={accountForm.imapHost} onChange={(event) => setAccountForm({ ...accountForm, imapHost: event.target.value })} /></Field>
          <Field label="IMAP 端口"><input className="input" type="number" value={accountForm.imapPort} onChange={(event) => setAccountForm({ ...accountForm, imapPort: Number(event.target.value) })} /></Field>
          <Field label="SMTP 服务器"><input className="input" value={accountForm.smtpHost} onChange={(event) => setAccountForm({ ...accountForm, smtpHost: event.target.value })} /></Field>
          <Field label="SMTP 端口"><input className="input" type="number" value={accountForm.smtpPort} onChange={(event) => setAccountForm({ ...accountForm, smtpPort: Number(event.target.value) })} /></Field>
          <div className="full"><label className="row text-sm"><input type="checkbox" checked={accountForm.smtpSecure} onChange={(event) => setAccountForm({ ...accountForm, smtpSecure: event.target.checked })} /> SMTP 使用 SSL/TLS（465 端口勾选；587 端口请取消勾选并使用 STARTTLS）</label></div>
        </div>
      </Modal>
    </div>
  );
}
