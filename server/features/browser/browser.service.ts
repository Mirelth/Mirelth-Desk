/**
 * 浏览器自动化：通过 CDP 附着到本机已有浏览器，不下载内核。
 *
 * 安全边界（缺一不可）：
 * 1. 默认关闭，必须显式 BROWSER_ENABLED=true；
 * 2. 调试地址只允许回环，杜绝把调试端口暴露到网络；
 * 3. 域名白名单，默认空 = 全部拒绝；
 * 4. 敏感动作（提交/发送/支付/删除）必须带人工确认令牌；
 * 5. 每次操作记 browser_runs + 活动流水，可回溯；
 * 6. 不读取、不存储 Cookie；步数与超时上限防失控。
 *
 * 已知限制：Chrome 136+ 要求 --remote-debugging-port 搭配非默认 --user-data-dir，
 * 因此这是独立 profile，不会复用日常浏览器的登录态，首次需在自动化浏览器内登录。
 */
import { config } from '../../shared/config.ts';
import { newId, now } from '../../shared/crypto.ts';
import { all, run } from '../../shared/database.ts';
import { AppError, BadRequestError, ForbiddenError } from '../../shared/errors.ts';
import { logger } from '../../shared/logger.ts';
import { activityService } from '../activity/activity.service.ts';

export type BrowserAction = 'open' | 'read' | 'click' | 'fill' | 'screenshot';

/** 需要人工确认的动作：填表与点击可能触发提交、发送、支付等不可逆后果。 */
const SENSITIVE: BrowserAction[] = ['click', 'fill'];

interface BrowserRunRow {
  id: string; action: string; target: string; status: string; detail: string; created_at: string;
}

function assertEnabled(): void {
  if (!config.browser.enabled) {
    throw new ForbiddenError('浏览器自动化未启用。请在 .env 设置 BROWSER_ENABLED=true 后重启服务');
  }
}

/** 只允许回环调试地址——调试端口能读 Cookie，绝不能指向外部主机。 */
function assertLoopbackCdp(): void {
  let url: URL;
  try {
    url = new URL(config.browser.cdpUrl);
  } catch {
    throw new BadRequestError('BROWSER_CDP_URL 不是合法地址');
  }
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new ForbiddenError('出于安全考虑，只允许连接本机回环地址的调试端口');
  }
}

export function assertHostAllowed(target: string): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new BadRequestError('目标地址不是合法 URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BadRequestError('只支持 http 与 https 地址');
  }
  const host = url.hostname.toLowerCase();
  const allowed = config.browser.allowedHosts;
  if (!allowed.length) {
    throw new ForbiddenError('浏览器白名单为空，已拒绝全部站点。请在 BROWSER_ALLOWED_HOSTS 中显式授权域名');
  }
  const matched = allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!matched) {
    throw new ForbiddenError(`站点 ${host} 不在白名单内。已授权：${allowed.join('、')}`);
  }
  return url;
}

function record(userId: string, workspaceId: string, action: string, target: string, status: string, detail: string): void {
  run('INSERT INTO browser_runs (id, workspace_id, user_id, action, target, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId('brw'), workspaceId, userId, action, target.slice(0, 500), status, detail.slice(0, 1000), now());
  activityService.record(userId, 'browser', action, `${status === 'success' ? '' : '[失败] '}${action} ${target}`.trim().slice(0, 200));
}

/** 动态加载 playwright：未启用浏览器时完全不加载，也不要求安装浏览器内核。 */
async function connect(): Promise<{ browser: import('playwright').Browser; close: () => Promise<void> }> {
  assertEnabled();
  assertLoopbackCdp();
  const { chromium } = await import('playwright');
  try {
    const browser = await chromium.connectOverCDP(config.browser.cdpUrl, { timeout: config.browser.timeoutMs });
    return { browser, close: async () => { try { await browser.close(); } catch { /* 断开失败不影响 */ } } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError(
      `无法连接本机浏览器（${detail.slice(0, 120)}）。请确认浏览器已用 --remote-debugging-port 与独立 --user-data-dir 启动（Chrome 136+ 必需）`,
      'BROWSER_CONNECT_FAILED', 502,
    );
  }
}

export interface BrowserResult { ok: boolean; text: string; screenshotBase64?: string; url?: string }

export const browserService = {
  status() {
    return {
      enabled: config.browser.enabled,
      cdpUrl: config.browser.cdpUrl,
      allowedHosts: config.browser.allowedHosts,
      maxSteps: config.browser.maxSteps,
      sensitiveActions: SENSITIVE,
      note: config.browser.enabled
        ? '已启用。仅允许白名单站点；点击与填写需人工确认。'
        : '未启用（默认关闭）。开启需设置 BROWSER_ENABLED=true 并配置 BROWSER_ALLOWED_HOSTS。',
    };
  },

  runs(userId: string, workspaceId: string, limit = 30) {
    return all<BrowserRunRow>(
      'SELECT * FROM browser_runs WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      workspaceId, userId, Math.min(Math.max(limit, 1), 100),
    );
  },

  async run(
    userId: string, workspaceId: string,
    input: { action: BrowserAction; url: string; selector?: string; value?: string; confirmed?: boolean },
  ): Promise<BrowserResult> {
    assertEnabled();
    const url = assertHostAllowed(input.url);

    if (SENSITIVE.includes(input.action) && input.confirmed !== true) {
      record(userId, workspaceId, input.action, input.url, 'blocked', '缺少人工确认');
      throw new ForbiddenError(`${input.action} 属于敏感动作，可能触发提交或发送。请显式确认后再执行（confirmed=true）`);
    }

    const { browser, close } = await connect();
    try {
      const context = browser.contexts()[0] ?? await browser.newContext();
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(config.browser.timeoutMs);

      let result: BrowserResult;
      if (input.action === 'screenshot') {
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
        const buffer = await page.screenshot({ type: 'png', fullPage: false });
        result = { ok: true, text: `已截图 ${url.hostname}`, screenshotBase64: buffer.toString('base64'), url: page.url() };
      } else if (input.action === 'read') {
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
        // 只取可见正文，不读 Cookie、不读 localStorage。
        const text = await page.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? '');
        const title = await page.title();
        result = { ok: true, text: `# ${title}\n\n${text}`, url: page.url() };
      } else if (input.action === 'open') {
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
        result = { ok: true, text: `已打开 ${await page.title()}`, url: page.url() };
      } else {
        if (!input.selector) throw new BadRequestError('click 与 fill 必须提供 selector');
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
        if (input.action === 'click') {
          await page.click(input.selector);
          result = { ok: true, text: `已点击 ${input.selector}`, url: page.url() };
        } else {
          // 填写内容不落库、不记日志正文，避免把凭据写进审计。
          await page.fill(input.selector, String(input.value ?? ''));
          result = { ok: true, text: `已填写 ${input.selector}`, url: page.url() };
        }
      }
      record(userId, workspaceId, input.action, input.url, 'success', result.text.slice(0, 200));
      logger.info('browser.action', { action: input.action, host: url.hostname });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record(userId, workspaceId, input.action, input.url, 'failed', detail);
      if (error instanceof AppError) throw error;
      throw new AppError(`浏览器操作失败：${detail.slice(0, 200)}`, 'BROWSER_ACTION_FAILED', 502);
    } finally {
      await close();
    }
  },
};