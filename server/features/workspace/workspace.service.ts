import { aiStatus, generate } from '../../ai/provider.ts';
import { decryptSecret, encryptSecret } from '../../shared/crypto.ts';
import { AppError, BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { logger } from '../../shared/logger.ts';
import { activityService } from '../activity/activity.service.ts';
import { analyticsService } from '../analytics/analytics.service.ts';
import { documentsService } from '../documents/documents.service.ts';
import { mailService } from '../mail/mail.service.ts';
import { papersService } from '../papers/papers.service.ts';
import { researchService } from '../research/research.service.ts';
import { workspaceRepository, type AutomationRow, type ConnectorRow } from './workspace.repository.ts';

export const AUTOMATION_ACTIONS = [
  { value: 'mail.sync', label: '同步收件箱', module: 'mail', description: '从 IMAP 拉取最近邮件（演示模式会返回提示）' },
  { value: 'mail.summary', label: '摘要最新未读邮件', module: 'mail', description: '为最新一封未读邮件生成并保存 AI 摘要' },
  { value: 'analytics.insights', label: '生成数据洞察', module: 'analytics', description: '基于最近的数据集生成洞察报告' },
  { value: 'document.draft', label: '起草文档并存稿', module: 'documents', description: '生成文档初稿并保存到文档库' },
  { value: 'paper.review', label: '生成文献综述大纲', module: 'papers', description: '基于文献库生成综述大纲' },
  { value: 'research.plan', label: '生成研究计划', module: 'research', description: '基于首个研究项目生成里程碑计划' },
  { value: 'agent.chat', label: '向智能体提问', module: 'agent', description: '把任务描述作为问题交给智能体' },
] as const;

export interface TaskInput {
  name: string;
  description: string;
  triggerType: 'manual' | 'interval' | 'event';
  intervalMinutes: number;
  action: string;
  enabled: boolean;
  workspaceId?: string;
  eventKey?: string;
}

export interface ConnectorInput {
  name: string;
  kind: string;
  baseUrl: string;
  description: string;
  token?: string;
  enabled: boolean;
}

function taskDto(row: AutomationRow) {
  return {
    id: row.id, name: row.name, description: row.description,
    triggerType: row.trigger_type, intervalMinutes: row.interval_minutes,
    module: row.module, action: row.action, enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at, nextRunAt: row.next_run_at, runCount: row.run_count,
    lastStatus: row.last_status, lastResult: row.last_result,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function connectorDto(row: ConnectorRow) {
  return {
    id: row.id, name: row.name, kind: row.kind, baseUrl: row.base_url,
    description: row.description, hasToken: Boolean(row.token_encrypted),
    status: row.status, enabled: Boolean(row.enabled),
    lastCheckedAt: row.last_checked_at, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at, builtin: false as const,
  };
}

function validateUrl(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new BadRequestError('连接器地址不是有效的 URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestError('连接器地址只支持 http / https');
  }
}

async function performConnectorTest(userId: string, id: string): Promise<{ ok: boolean; detail: string; status?: number }> {
  if (id.startsWith('builtin-')) {
    const item = workspaceService.listConnectors(userId).find((connector) => connector.id === id);
    return item
      ? { ok: item.status === 'connected', detail: item.status === 'connected' ? `${item.name} 已连接` : `${item.name} 未配置，当前不可用` }
      : { ok: false, detail: '内置连接器不存在' };
  }
  const row = workspaceRepository.connector(userId, id);
  if (!row) throw new NotFoundError('连接器', id);
  const headers: Record<string, string> = {};
  if (row.token_encrypted) {
    try {
      headers.Authorization = `Bearer ${decryptSecret(row.token_encrypted)}`;
    } catch (error) {
      // 不能静默跳过：不发 Authorization 头会把「凭据坏了」表现成对方的 401。
      const detail = error instanceof AppError ? error.message : '凭据解密失败，请重新填写 Token';
      workspaceRepository.updateConnector(userId, id, {
        status: 'error', last_checked_at: new Date().toISOString(), last_error: detail.slice(0, 300),
      });
      return { ok: false, detail };
    }
  }
  try {
    const response = await fetch(row.base_url, { method: 'GET', headers, signal: AbortSignal.timeout(6000) });
    const ok = response.ok;
    const detail = ok
      ? `${row.base_url} 返回 HTTP ${response.status}`
      : response.status === 401 || response.status === 403
        ? `${row.base_url} 鉴权失败（HTTP ${response.status}），请检查 Token`
        : `${row.base_url} 地址可达但返回 HTTP ${response.status}`;
    workspaceRepository.updateConnector(userId, id, {
      status: ok ? 'connected' : 'error',
      last_checked_at: new Date().toISOString(),
      last_error: ok ? '' : detail,
    });
    return { ok, detail, status: response.status };
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    workspaceRepository.updateConnector(userId, id, {
      status: 'error', last_checked_at: new Date().toISOString(), last_error: detail.slice(0, 300),
    });
    return { ok: false, detail: `连接失败：${detail.slice(0, 200)}` };
  }
}

export const workspaceService = {
  actions() { return AUTOMATION_ACTIONS; },

  listTasks(userId: string) { return workspaceRepository.tasks(userId).map(taskDto); },

  createTask(userId: string, input: TaskInput) {
    if (input.triggerType === 'interval' && input.intervalMinutes < 1) {
      throw new BadRequestError('定时任务的执行间隔必须大于 0 分钟');
    }
    const action = AUTOMATION_ACTIONS.find((item) => item.value === input.action);
    if (!action) throw new BadRequestError('不支持的任务动作');
    const id = workspaceRepository.createTask(userId, {
      name: input.name, description: input.description,
      trigger_type: input.triggerType,
      interval_minutes: input.triggerType === 'interval' ? input.intervalMinutes : 0,
      module: action.module, action: input.action, enabled: input.enabled ? 1 : 0,
      workspace_id: input.workspaceId ?? null, event_key: input.eventKey ?? '',
    });
    activityService.record(userId, 'agent', 'automation_create', `创建自动化任务「${input.name}」`);
    return taskDto(workspaceRepository.task(userId, id)!);
  },

  updateTask(userId: string, id: string, input: Partial<TaskInput>) {
    const current = workspaceRepository.task(userId, id);
    if (!current) throw new NotFoundError('自动化任务', id);
    if (input.action && !AUTOMATION_ACTIONS.some((item) => item.value === input.action)) {
      throw new BadRequestError('不支持的任务动作');
    }
    const triggerType = input.triggerType ?? current.trigger_type;
    const interval = input.intervalMinutes ?? current.interval_minutes;
    if (triggerType === 'interval' && interval < 1) throw new BadRequestError('定时任务的执行间隔必须大于 0 分钟');
    const nextRunAt = triggerType === 'interval'
      ? new Date(Date.now() + interval * 60_000).toISOString()
      : null;
    workspaceRepository.updateTask(userId, id, {
      name: input.name, description: input.description,
      trigger_type: triggerType as TaskInput['triggerType'],
      interval_minutes: triggerType === 'interval' ? interval : 0,
      workspace_id: input.workspaceId,
      event_key: input.eventKey,
      module: input.action ? AUTOMATION_ACTIONS.find((item) => item.value === input.action)?.module : undefined,
      action: input.action,
      enabled: input.enabled === undefined ? undefined : (input.enabled ? 1 : 0),
      nextRunAt,
    });
    activityService.record(userId, 'agent', 'automation_update', `更新自动化任务「${input.name ?? current.name}」`);
    return taskDto(workspaceRepository.task(userId, id)!);
  },

  deleteTask(userId: string, id: string): void {
    if (!workspaceRepository.task(userId, id)) throw new NotFoundError('自动化任务', id);
    workspaceRepository.deleteTask(userId, id);
    activityService.record(userId, 'agent', 'automation_delete', `删除自动化任务 ${id}`);
  },

  async runTask(userId: string, id: string): Promise<{ ok: boolean; text: string; error?: string; task: ReturnType<typeof taskDto> }> {
    const current = workspaceRepository.task(userId, id);
    if (!current) throw new NotFoundError('自动化任务', id);
    let ok = true;
    let text = '';
    let error = '';
    try {
      switch (current.action) {
        case 'mail.sync': {
          const result = await mailService.sync(userId);
          text = result.note ?? `同步完成，新增 ${result.synced} 封邮件`;
          break;
        }
        case 'mail.summary': {
          const unread = mailService.list(userId, { folder: 'inbox' }).find((message) => !message.isRead);
          if (!unread) { text = '当前没有未读邮件，无需生成摘要。'; break; }
          text = (await mailService.ai(userId, { action: 'summary', messageId: unread.id })).text;
          break;
        }
        case 'analytics.insights': {
          const [dataset] = analyticsService.list(userId);
          if (!dataset) { text = '尚未导入数据集，请先在数据分析模块上传 CSV。'; break; }
          text = (await analyticsService.insights(userId, dataset.id, 'insights')).text;
          break;
        }
        case 'document.draft': {
          const draft = await generate('document.draft', {
            title: current.name, template: '工作周报', sections: [], points: [], content: '',
          });
          const doc = documentsService.create(userId, {
            title: `${current.name} · ${new Date().toLocaleDateString('zh-CN')}`,
            content: draft.text, kind: 'weekly',
          });
          text = `已创建文档「${doc.title}」\n\n${draft.text.slice(0, 800)}`;
          break;
        }
        case 'paper.review': {
          text = (await papersService.ai(userId, 'review')).text;
          break;
        }
        case 'research.plan': {
          const project = researchService.overview(userId).projects[0];
          if (!project) { text = '尚未创建研究项目，请先在科学研究模块建立项目。'; break; }
          text = (await researchService.plan(userId, project.id)).text;
          break;
        }
        default: {
          text = (await generate('agent.chat', { message: current.description || current.name })).text;
        }
      }
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : String(caught);
      text = `执行失败：${error}`;
      logger.error('automation.run_failed', { task_id: id, action: current.action, error });
    }

    const nextRunAt = current.trigger_type === 'interval' && current.interval_minutes > 0
      ? new Date(Date.now() + current.interval_minutes * 60_000).toISOString()
      : null;
    workspaceRepository.recordRun(id, ok ? 'success' : 'failed', text, nextRunAt);
    activityService.record(userId, 'agent', 'automation_run', `${ok ? '执行成功' : '执行失败'}：${current.name}`);
    return { ok, text, error: ok ? undefined : error, task: taskDto(workspaceRepository.task(userId, id)!) };
  },

  listConnectors(userId: string) {
    const ai = aiStatus();
    const mail = mailService.status(userId);
    const builtins = [
      {
        id: 'builtin-llm', name: 'AI 模型服务', kind: 'llm', builtin: true as const,
        baseUrl: ai.baseUrl || '未配置', description: 'OpenAI 兼容 /chat/completions 流式接口',
        status: ai.mode === 'live' ? 'connected' : 'disconnected', enabled: true,
        hasToken: Boolean(ai.baseUrl), lastCheckedAt: null, lastError: '',
        createdAt: '', updatedAt: '', detail: ai.label,
      },
      {
        id: 'builtin-mail', name: '邮箱服务 (IMAP / SMTP)', kind: 'mail', builtin: true as const,
        baseUrl: mail.account ? `${mail.account.imapHost} / ${mail.account.smtpHost}` : '未配置',
        description: '收件同步与邮件投递', status: mail.configured ? 'connected' : 'disconnected',
        enabled: mail.configured, hasToken: mail.configured, lastCheckedAt: null, lastError: '',
        createdAt: '', updatedAt: '', detail: mail.configured ? mail.account?.email : '演示模式',
      },
      {
        id: 'builtin-db', name: '本地知识库 (SQLite)', kind: 'storage', builtin: true as const,
        baseUrl: '.data/mirelth.db', description: '文档、数据、文献与邮件的本机存储',
        status: 'connected', enabled: true, hasToken: false, lastCheckedAt: null, lastError: '',
        createdAt: '', updatedAt: '', detail: '已连接',
      },
    ];
    return [...builtins, ...workspaceRepository.connectors(userId).map(connectorDto)];
  },

  createConnector(userId: string, input: ConnectorInput) {
    validateUrl(input.baseUrl);
    const id = workspaceRepository.createConnector(userId, {
      name: input.name, kind: input.kind, baseUrl: input.baseUrl,
      description: input.description, tokenEncrypted: input.token ? encryptSecret(input.token) : '',
      enabled: input.enabled ? 1 : 0,
    });
    activityService.record(userId, 'agent', 'connector_create', `添加连接器「${input.name}」`);
    return connectorDto(workspaceRepository.connector(userId, id)!);
  },

  updateConnector(userId: string, id: string, input: Partial<ConnectorInput>) {
    const current = workspaceRepository.connector(userId, id);
    if (!current) throw new NotFoundError('连接器', id);
    if (input.baseUrl) validateUrl(input.baseUrl);
    workspaceRepository.updateConnector(userId, id, {
      name: input.name, kind: input.kind, base_url: input.baseUrl,
      description: input.description,
      token_encrypted: input.token === undefined ? undefined : (input.token ? encryptSecret(input.token) : ''),
      enabled: input.enabled === undefined ? undefined : (input.enabled ? 1 : 0),
      status: input.baseUrl ? 'disconnected' : undefined,
      last_error: input.baseUrl ? '' : undefined,
    });
    activityService.record(userId, 'agent', 'connector_update', `更新连接器「${input.name ?? current.name}」`);
    return connectorDto(workspaceRepository.connector(userId, id)!);
  },

  deleteConnector(userId: string, id: string): void {
    if (!workspaceRepository.connector(userId, id)) throw new NotFoundError('连接器', id);
    workspaceRepository.deleteConnector(userId, id);
    activityService.record(userId, 'agent', 'connector_delete', `移除连接器 ${id}`);
  },

  async testConnector(userId: string, id: string): Promise<{ ok: boolean; detail: string; status?: number }> {
    const outcome = await performConnectorTest(userId, id);
    activityService.record(userId, 'agent', 'connector_test', `测试连接器 ${id}：${outcome.ok ? '成功' : '失败'}`);
    return outcome;
  },


};
