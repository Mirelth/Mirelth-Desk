import { useLoad } from '../lib/hooks.ts';
import { apiClient, getErrorMessage } from '../lib/api.ts';
import { Button, ErrorBanner, Icon, SectionTitle, Skeleton, useToast } from '../lib/ui.tsx';
import type { AiMode, MailAccountDto, MailStatus, User } from '../lib/types.ts';

interface AiStatus { mode: AiMode; model: string; baseUrl: string; label: string }

const ENV_SAMPLE = `# 复制 .env.example 为 .env，填入任意 OpenAI 兼容服务
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# 修改本机登录凭据
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-strong-password`;

export function Settings({ user, aiMode, onLogout, onChanged }: { user: User; aiMode: AiMode; onLogout: () => void; onChanged?: () => void }) {
  const toast = useToast();
  const ai = useLoad<AiStatus>(() => apiClient.get<AiStatus>('/api/agent/status'));
  const mail = useLoad<MailStatus>(() => apiClient.get<MailStatus>('/api/mail/status'));
  const accounts = useLoad<MailAccountDto[]>(() => apiClient.get<MailAccountDto[]>('/api/mail/accounts'));

  const removeAccount = async (id: string) => {
    if (!window.confirm('确定移除该邮箱账户？')) return;
    try {
      await apiClient.delete(`/api/mail/accounts/${id}`);
      await Promise.all([mail.reload(), accounts.reload()]);
      onChanged?.();
      toast('账户已移除', 'success');
    } catch (error) { toast(getErrorMessage(error), 'error'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>设置</h1><p>模型接入、邮箱账户与本机工作区信息</p></div>
        <div className="page-actions"><Button variant="danger" icon="logout" onClick={onLogout}>退出登录</Button></div>
      </div>

      {ai.error && <ErrorBanner message={ai.error} onRetry={() => void ai.reload()} />}

      <div className="settings-grid">
        <section className="card card-pad">
          <div className="row mb-16"><div className="stat-icon" style={{ color: 'var(--primary)', background: 'var(--primary-soft)', margin: 0 }}><Icon name="sparkles" size={17} /></div>
            <div><h3>AI 模型</h3><div className="text-xs muted">当前生成引擎</div></div></div>
          {ai.loading && !ai.data ? <Skeleton height={110} /> : (
            <>
              <div className="info-row"><span className="label">运行模式</span><span><strong>{ai.data?.mode === 'live' ? `在线 · ${ai.data.model}` : '离线规则引擎'}</strong></span></div>
              <div className="info-row"><span className="label">接口地址</span><span className="text-xs">{ai.data?.baseUrl || '未配置'}</span></div>
              <div className="info-row"><span className="label">状态</span><span>{aiMode === 'live' ? '可调用外部模型' : '无需密钥，数据不出本机'}</span></div>
              <div className="settings-note mt-12">
                未配置密钥时，智能体使用基于真实材料的离线规则引擎：文档生成、统计洞察、文献综述、实验设计、邮件草稿均可正常工作，且不会编造数据。填入任意 OpenAI 兼容接口后，所有生成自动切换为模型流式输出。
              </div>
            </>
          )}
          <div className="mt-16"><div className="text-sm muted mb-12">接入方式</div><div className="code-block">{ENV_SAMPLE}</div></div>
        </section>

        <section className="card card-pad">
          <div className="row mb-16"><div className="stat-icon" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', margin: 0 }}><Icon name="mail" size={17} /></div>
            <div><h3>邮箱账户</h3><div className="text-xs muted">IMAP 收件 / SMTP 发送</div></div></div>
          {mail.loading && !mail.data ? <Skeleton height={90} /> : (
            <>
              <div className="info-row"><span className="label">配置状态</span><span><strong>{mail.data?.configured ? mail.data.account?.email : '未配置（演示模式）'}</strong></span></div>
              <div className="info-row"><span className="label">投递方式</span><span>{mail.data?.configured ? 'SMTP 真实发送' : '仅保存到本地已发送'}</span></div>
              {accounts.data?.map((account) => (
                <div className="info-row" key={account.id}>
                  <span className="text-xs">{account.email}<br /><span className="muted">{account.imapHost}:{account.imapPort} · {account.smtpHost}:{account.smtpPort}</span></span>
                  <Button variant="danger" size="sm" icon="trash" onClick={() => void removeAccount(account.id)}>移除</Button>
                </div>
              ))}
              <div className="settings-note mt-12">
                账户凭据经 AES-256-GCM 加密后保存在本机 SQLite，不会写入日志。多数邮箱服务商需要开启 IMAP/SMTP 并使用「应用专用授权码」而非登录密码。到「智能邮箱 → 邮箱设置」可新增账户。
              </div>
            </>
          )}
        </section>

        <section className="card card-pad">
          <div className="row mb-16"><div className="stat-icon" style={{ color: 'var(--accent)', background: 'var(--accent-soft)', margin: 0 }}><Icon name="shield" size={17} /></div>
            <div><h3>本机账号与数据</h3><div className="text-xs muted">单用户本地工作区</div></div></div>
          <div className="info-row"><span className="label">当前账号</span><strong>{user.username}</strong></div>
          <div className="info-row"><span className="label">会话方式</span><span>httpOnly Cookie + HMAC 签名</span></div>
          <div className="info-row"><span className="label">数据存储</span><span className="text-xs">.data/mirelth.db（SQLite）</span></div>
          <div className="info-row"><span className="label">密码存储</span><span className="text-xs">scrypt 加盐哈希</span></div>
          <div className="settings-note mt-12">所有文档、数据集、文献、实验记录与邮件都保存在本机，无外部遥测。健康检查：<code>/health</code> 与 <code>/ready</code>。</div>
        </section>

        <section className="card card-pad">
          <div className="row mb-16"><div className="stat-icon" style={{ color: 'var(--warn)', background: 'var(--warn-soft)', margin: 0 }}><Icon name="bolt" size={17} /></div>
            <div><h3>能力与边界</h3><div className="text-xs muted">避免把演示当成生产</div></div></div>
          <div className="settings-note">
            <p className="mb-12">已实现：文档 CRUD 与 AI 写作、CSV 统计与图表、文献库与引用导出、实验与任务看板、IMAP/SMTP 邮件收发、统一智能体与 SSE 流式输出。</p>
            <p className="mb-12">当前边界：单用户本地版；CSV 单次最多 5000 行；AI 结论仅基于你提供的数据；离线引擎使用规则模板，风格改写能力弱于真实模型。</p>
            <p>生产部署建议：配置 <code>APP_SECRET</code>、启用 HTTPS 与反向代理、把 SQLite 迁移到 PostgreSQL、为模型调用增加配额与审计。</p>
          </div>
        </section>
      </div>

      <SectionTitle title="架构" hint="feature-first 三层结构，Controller → Service → Repository" />
      <div className="card card-pad settings-note">
        <div className="code-block">{`server/
  features/{auth,documents,analytics,papers,research,mail,agent,activity}/
    *.controller.ts   HTTP 边界 + Zod 校验
    *.service.ts      业务逻辑与 AI 编排
    *.repository.ts   SQLite 数据访问
  shared/             config / errors / logger / database / migrations
  ai/                 provider(OpenAI 兼容 + 离线引擎) / prompts
client/               React + Vite，typed API client + SSE 流式渲染
scripts/smoke.ts      端到端冒烟测试`}</div>
      </div>
    </div>
  );
}
