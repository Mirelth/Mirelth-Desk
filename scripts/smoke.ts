const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3001';

let cookie = '';
let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
  if (condition) { passed += 1; console.log(`[OK]   ${label}`); }
  else { failed += 1; console.error(`[FAIL] ${label}`); }
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T | null; text: string }> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: T | null = null;
  try { data = JSON.parse(text) as T; } catch { /* text response */ }
  return { status: response.status, data, text };
}

interface Envelope<T> { data: T }
interface Paged<T> { items: T[]; total: number; limit: number; offset: number }

async function main(): Promise<void> {
  console.log(`Smoke test → ${BASE}\n`);

  const health = await request<{ status: string }>('/health');
  check(health.status === 200 && health.data?.status === 'ok', 'GET /health');

  const ready = await request<{ status: string }>('/ready');
  check(ready.status === 200 && ready.data?.status === 'ok', 'GET /ready');

  const unauthenticated = await request('/api/dashboard');
  check(unauthenticated.status === 401, '未登录访问受保护接口返回 401');

  const loginResponse = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME ?? 'admin', password: process.env.ADMIN_PASSWORD ?? 'admin123' }),
  });
  const setCookie = loginResponse.headers.get('set-cookie') ?? '';
  cookie = setCookie.split(';')[0];
  check(loginResponse.status === 200 && cookie.startsWith('md_session='), 'POST /api/auth/login');

  const dashboard = await request<Envelope<{ documents: number; recent: unknown[] }>>('/api/dashboard');
  check(dashboard.status === 200 && Array.isArray(dashboard.data?.data.recent), 'GET /api/dashboard');

  const documents = await request<Envelope<Paged<{ id: string }>>>('/api/documents');
  check(documents.status === 200 && Array.isArray(documents.data?.data.items), 'GET /api/documents');

  const created = await request<Envelope<{ id: string; title: string }>>('/api/documents', {
    method: 'POST', body: { title: '冒烟测试文档', template: 'weekly', content: '# 测试\n\n这是冒烟测试。' },
  });
  const docId = created.data?.data.id ?? '';
  check(created.status === 201 && Boolean(docId), 'POST /api/documents');

  if (docId) {
    const patched = await request(`/api/documents/${docId}`, { method: 'PATCH', body: { content: '# 测试\n\n已更新。' } });
    check(patched.status === 200, 'PATCH /api/documents/:id');
    const ai = await request<Envelope<{ text: string; mode: string }>>(`/api/documents/${docId}/ai`, {
      method: 'POST', body: { action: 'outline', points: ['目标', '进度'] },
    });
    check(ai.status === 200 && Boolean(ai.data?.data.text.includes('大纲')), 'POST /api/documents/:id/ai');
    const exported = await request(`/api/documents/${docId}/export?format=md`);
    check(exported.status === 200 && exported.text.includes('测试'), 'GET /api/documents/:id/export');
    const removed = await request(`/api/documents/${docId}`, { method: 'DELETE' });
    check(removed.status === 200, 'DELETE /api/documents/:id');
  }

  const csv = '月份,产品线,营收\n1月,文档,120\n2月,文档,150\n3月,文档,180';
  const dataset = await request<Envelope<{ id: string; stats: { rowCount: number; trend: unknown[] } }>>('/api/analytics/datasets', {
    method: 'POST', body: { name: '冒烟测试数据', filename: 'smoke.csv', csv },
  });
  const datasetId = dataset.data?.data.id ?? '';
  check(dataset.status === 201 && dataset.data?.data.stats.rowCount === 3, 'POST /api/analytics/datasets (CSV 解析)');
  if (datasetId) {
    const insights = await request<Envelope<{ text: string }>>(`/api/analytics/datasets/${datasetId}/insights`, {
      method: 'POST', body: { kind: 'insights' },
    });
    check(insights.status === 200 && Boolean(insights.data?.data.text.includes('洞察')), 'POST /api/analytics/datasets/:id/insights');
    const removed = await request(`/api/analytics/datasets/${datasetId}`, { method: 'DELETE' });
    check(removed.status === 200, 'DELETE /api/analytics/datasets/:id');
  }

  const paperStats = await request<Envelope<{ total: number }>>('/api/papers/stats');
  check(paperStats.status === 200 && typeof paperStats.data?.data.total === 'number', 'GET /api/papers/stats');
  const references = await request('/api/papers/export?format=bibtex');
  check(references.status === 200 && references.text.includes('@article'), 'GET /api/papers/export (BibTeX)');

  const research = await request<Envelope<{ projects: unknown[]; experiments: unknown[] }>>('/api/research/overview');
  check(research.status === 200 && Array.isArray(research.data?.data.experiments), 'GET /api/research/overview');

  const automationActions = await request<Envelope<unknown[]>>('/api/automation/actions');
  check(automationActions.status === 200 && Array.isArray(automationActions.data?.data), 'GET /api/automation/actions');
  const createdTask = await request<Envelope<{ id: string }>>('/api/automation', {
    method: 'POST', body: {
      name: '冒烟测试任务', description: '验证动作执行', triggerType: 'manual',
      intervalMinutes: 0, action: 'agent.chat', enabled: false,
    },
  });
  const taskId = createdTask.data?.data.id ?? '';
  check(createdTask.status === 201 && Boolean(taskId), 'POST /api/automation');
  if (taskId) {
    const run = await request<Envelope<{ ok: boolean; text: string }>>(`/api/automation/${taskId}/run`, { method: 'POST' });
    check(run.status === 200 && run.data?.data.ok === true, 'POST /api/automation/:id/run');
    check((await request(`/api/automation/${taskId}`, { method: 'DELETE' })).status === 200, 'DELETE /api/automation/:id');
  }

  const connectors = await request<Envelope<Array<{ builtin: boolean }>>>('/api/connectors');
  check(connectors.status === 200 && (connectors.data?.data.filter((item) => item.builtin).length ?? 0) >= 3, 'GET /api/connectors (含内置)');
  const createdConnector = await request<Envelope<{ id: string }>>('/api/connectors', {
    method: 'POST', body: {
      name: '冒烟连接器', kind: 'api', baseUrl: `${BASE}/health`, description: '本机健康检查', enabled: true,
    },
  });
  const connectorId = createdConnector.data?.data.id ?? '';
  check(createdConnector.status === 201 && Boolean(connectorId), 'POST /api/connectors');
  if (connectorId) {
    const tested = await request<Envelope<{ ok: boolean }>>(`/api/connectors/${connectorId}/test`, { method: 'POST' });
    check(tested.status === 200 && tested.data?.data.ok === true, 'POST /api/connectors/:id/test');
    check((await request(`/api/connectors/${connectorId}`, { method: 'DELETE' })).status === 200, 'DELETE /api/connectors/:id');
  }

  const mailStatus = await request<Envelope<{ configured: boolean }>>('/api/mail/status');
  check(mailStatus.status === 200, 'GET /api/mail/status');
  const mailList = await request<Envelope<Paged<{ id: string }>>>('/api/mail/messages?folder=inbox');
  const firstMail = mailList.data?.data.items[0]?.id ?? '';
  check(mailList.status === 200 && Array.isArray(mailList.data?.data.items), 'GET /api/mail/messages');
  if (firstMail) {
    const reply = await request<Envelope<{ text: string }>>('/api/mail/ai', {
      method: 'POST', body: { action: 'reply', messageId: firstMail, tone: '专业礼貌' },
    });
    check(reply.status === 200 && Boolean(reply.data?.data.text), 'POST /api/mail/ai (回复草稿)');
  }

  const generated = await request<Envelope<{ text: string; mode: string }>>('/api/agent/generate', {
    method: 'POST', body: { kind: 'agent.chat', input: { message: '帮我写周报' } },
  });
  check(generated.status === 200 && Boolean(generated.data?.data.text.includes('文档写作')), 'POST /api/agent/generate');

  const stream = await fetch(`${BASE}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ kind: 'document.outline', input: { title: '冒烟测试' } }),
  });
  const streamText = await stream.text();
  check(stream.status === 200 && streamText.includes('event: delta') && streamText.includes('event: done'), 'POST /api/agent/run (SSE 流式)');

  // —— platform：全组已挂载，这里验四类最容易静默坏掉的写路径 ——
  const platformStatus = await request<Envelope<{ workspace: { id: string }; features: string[] }>>('/api/platform/status');
  const workspaceId = platformStatus.data?.data.workspace.id ?? '';
  check(platformStatus.status === 200 && Boolean(workspaceId), 'GET /api/platform/status');

  const workspaces = await request<Envelope<Array<{ id: string }>>>('/api/platform/workspaces');
  check(workspaces.status === 200 && Array.isArray(workspaces.data?.data), 'GET /api/platform/workspaces（原 deferred）');

  const members = await request<Envelope<Array<{ userId: string }>>>(`/api/platform/workspaces/${workspaceId}/members`);
  check(members.status === 200 && Array.isArray(members.data?.data), 'GET /api/platform/workspaces/:id/members');

  const agent = await request<Envelope<{ id: string }>>('/api/platform/agents', {
    method: 'POST', body: { name: '冒烟智能体', tools: ['document_outline'], maxSteps: 3 },
  });
  const agentId = agent.data?.data.id ?? '';
  check(agent.status === 201 && Boolean(agentId), 'POST /api/platform/agents');
  const agentRemoved = await request(`/api/platform/agents/${agentId}`, { method: 'DELETE' });
  check(agentRemoved.status === 200, 'DELETE /api/platform/agents/:id');

  const upload = await request<Envelope<{ id: string }>>('/api/platform/files', {
    method: 'POST', body: { filename: 'smoke.txt', mime: 'text/plain', contentBase64: Buffer.from('冒烟附件').toString('base64') },
  });
  const fileId = upload.data?.data.id ?? '';
  check(upload.status === 201 && Boolean(fileId), 'POST /api/platform/files');
  const download = await request(`/api/platform/files/${fileId}/download`);
  check(download.status === 200 && download.text === '冒烟附件', 'GET /api/platform/files/:id/download');

  const workflow = await request<Envelope<{ id: string }>>('/api/platform/workflows', {
    method: 'POST', body: { name: '冒烟工作流', nodes: [{ id: 'n1', tool: 'rag_search', args: { query: '周报' } }], edges: [] },
  });
  const workflowId = workflow.data?.data.id ?? '';
  check(workflow.status === 200 && Boolean(workflowId), 'POST /api/platform/workflows');
  const workflowRun = await request<Envelope<{ text: string }>>(`/api/platform/workflows/${workflowId}/run`, { method: 'POST' });
  check(workflowRun.status === 200 && Boolean(workflowRun.data?.data.text), 'POST /api/platform/workflows/:id/run');

  const key = await request<Envelope<{ id: string; key: string }>>(`/api/platform/workspaces/${workspaceId}/keys`, {
    method: 'POST', body: { name: '冒烟 Key', role: 'member' },
  });
  const rawKey = key.data?.data.key ?? '';
  check(key.status === 201 && rawKey.startsWith('mdk_'), 'POST /api/platform/workspaces/:id/keys');
  if (rawKey) {
    const hook = await fetch(`${BASE}/api/platform/webhook/smoke.event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': rawKey }, body: '{}',
    });
    check(hook.status === 200, 'POST /api/platform/webhook/:key（带 X-Api-Key）');
    const revoked = await request(`/api/platform/workspaces/${workspaceId}/keys/${key.data?.data.id}`, { method: 'DELETE' });
    check(revoked.status === 200, 'DELETE /api/platform/workspaces/:id/keys/:keyId');
  }

  const audit = await request<Envelope<unknown[]>>('/api/platform/audit');
  check(audit.status === 200 && Array.isArray(audit.data?.data), 'GET /api/platform/audit');
  const usage = await request<Envelope<unknown[]>>('/api/platform/usage');
  check(usage.status === 200 && Array.isArray(usage.data?.data), 'GET /api/platform/usage');

  const logout = await request('/api/auth/logout', { method: 'POST' });
  check(logout.status === 200, 'POST /api/auth/logout');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('冒烟测试异常：', error);
  process.exitCode = 1;
});
