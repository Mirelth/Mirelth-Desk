import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../shared/config.ts';
import { all, get } from '../../shared/database.ts';
import { newId, now } from '../../shared/crypto.ts';
import { BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { aiStatus } from '../../ai/provider.ts';
import { documentsService } from '../documents/documents.service.ts';
import { workspaceService } from '../workspace/workspace.service.ts';
import { indexChunk, indexSize, reindex, search } from './rag.ts';
import { audit, count, defaultWorkspace, deleteRows, insertRow, requireRole, row, rows, updateRows, ROLE_LEVEL } from './store.ts';
import { allTools, executeTool, getTool, registerTool, toolManifest } from './tools.ts';

const DAILY_LIMIT = config.ai.dailyLimit;

function filesDir(): string {
  return path.join(config.root, '.data', 'files');
}

export const platformService = {
  status(userId: string) {
    const workspace = defaultWorkspace(userId);
    const today = new Date().toISOString().slice(0, 10);
    return {
      ...aiStatus(),
      workspace,
      tools: allTools().length,
      knowledgeChunks: indexSize(workspace.id),
      conversations: count('conversations', 'workspace_id = ?', [workspace.id]),
      runs: count('agent_runs', 'workspace_id = ?', [workspace.id]),
      members: count('memberships', 'workspace_id = ?', [workspace.id]),
      quota: {
        limit: DAILY_LIMIT,
        used: count('model_usage', 'user_id = ? AND created_at LIKE ?', [userId, `${today}%`]),
      },
      features: ['tool_calls', 'rag_fts5_vector', 'conversations', 'memory', 'workspaces', 'shares',
        'comments', 'versions', 'files', 'events', 'audit', 'quota', 'workflows', 'mcp'],
    };
  },

  workspaces(userId: string) {
    const memberships = rows<{ workspace_id: string; role: string }>('memberships', 'user_id = ?', [userId]);
    return memberships.map((item) => {
      const workspace = row<{ id: string; name: string; owner_id: string; created_at: string }>('workspaces', 'id = ?', [item.workspace_id]);
      return { id: item.workspace_id, name: workspace?.name ?? '未知工作区', role: item.role, createdAt: workspace?.created_at ?? '', memberCount: count('memberships', 'workspace_id = ?', [item.workspace_id]) };
    });
  },

  createWorkspace(userId: string, name: string) {
    const id = insertRow('workspaces', { name: name.trim() || '新工作区', owner_id: userId });
    insertRow('memberships', { workspace_id: id, user_id: userId, role: 'owner' });
    audit(id, userId, 'workspace.create', id, name);
    return { id, name, role: 'owner' };
  },

  members(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows<{ user_id: string; role: string; created_at: string }>('memberships', 'workspace_id = ?', [workspaceId])
      .map((item) => ({
        userId: item.user_id, role: item.role, createdAt: item.created_at,
        username: get<{ username: string }>('SELECT username FROM users WHERE id = ?', item.user_id)?.username ?? '未知用户',
      }));
  },

  addMember(userId: string, workspaceId: string, username: string, role: string) {
    requireRole(workspaceId, userId, 'admin');
    if (!ROLE_LEVEL[role]) throw new BadRequestError('角色必须是 viewer / member / admin / owner');
    const target = get<{ id: string }>('SELECT id FROM users WHERE username = ?', username);
    if (!target) throw new NotFoundError('用户', username);
    deleteRows('memberships', 'workspace_id = ? AND user_id = ?', [workspaceId, target.id]);
    insertRow('memberships', { workspace_id: workspaceId, user_id: target.id, role });
    audit(workspaceId, userId, 'member.add', target.id, role);
    return { userId: target.id, username, role };
  },

  removeMember(userId: string, workspaceId: string, targetUserId: string) {
    requireRole(workspaceId, userId, 'admin');
    deleteRows('memberships', 'workspace_id = ? AND user_id = ?', [workspaceId, targetUserId]);
    audit(workspaceId, userId, 'member.remove', targetUserId);
  },

  agents(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows<{ id: string; name: string; description: string; system_prompt: string; tool_whitelist: string; model: string; max_steps: number; created_at: string }>(
      'agent_definitions', 'workspace_id = ?', [workspaceId], 'created_at DESC',
    ).map((item) => ({ ...item, tools: JSON.parse(item.tool_whitelist) as string[] }));
  },

  createAgent(userId: string, workspaceId: string, input: { name: string; description?: string; systemPrompt?: string; tools?: string[]; model?: string; maxSteps?: number }) {
    requireRole(workspaceId, userId, 'admin');
    const id = insertRow('agent_definitions', {
      workspace_id: workspaceId, name: input.name, description: input.description ?? '',
      system_prompt: input.systemPrompt ?? '', tool_whitelist: JSON.stringify(input.tools ?? []),
      model: input.model ?? '', max_steps: input.maxSteps ?? 4, updated_at: now(),
    });
    audit(workspaceId, userId, 'agent.create', id, input.name);
    return id;
  },

  updateAgent(userId: string, workspaceId: string, id: string, patch: Record<string, unknown>) {
    requireRole(workspaceId, userId, 'admin');
    const mapped: Record<string, unknown> = { updated_at: now() };
    if (patch.name !== undefined) mapped.name = patch.name;
    if (patch.description !== undefined) mapped.description = patch.description;
    if (patch.systemPrompt !== undefined) mapped.system_prompt = patch.systemPrompt;
    if (patch.model !== undefined) mapped.model = patch.model;
    if (patch.maxSteps !== undefined) mapped.max_steps = patch.maxSteps;
    if (patch.tools !== undefined) mapped.tool_whitelist = JSON.stringify(patch.tools);
    updateRows('agent_definitions', mapped, 'id = ? AND workspace_id = ?', [id, workspaceId]);
    return id;
  },

  deleteAgent(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'admin');
    deleteRows('agent_definitions', 'id = ? AND workspace_id = ?', [id, workspaceId]);
  },

  conversations(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows<{ id: string; title: string; created_at: string; updated_at: string }>(
      'conversations', 'workspace_id = ? AND user_id = ?', [workspaceId, userId], 'updated_at DESC',
    ).map((item) => ({ ...item, messageCount: count('conversation_messages', 'conversation_id = ?', [item.id]) }));
  },

  conversation(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'viewer');
    const conversation = row<{ id: string; title: string }>('conversations', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    if (!conversation) throw new NotFoundError('会话', id);
    const messages = rows<{ id: string; role: string; content: string; created_at: string }>(
      'conversation_messages', 'conversation_id = ?', [id], 'created_at ASC, rowid ASC',
    );
    return { ...conversation, messages };
  },

  runs(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows<{ id: string; status: string; input: string; output: string; steps_count: number; tokens_estimate: number; duration_ms: number; created_at: string }>(
      'agent_runs', 'workspace_id = ?', [workspaceId], 'created_at DESC', 50,
    );
  },

  run(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'viewer');
    const found = row<{ id: string; status: string; input: string; output: string; created_at: string }>(
      'agent_runs', 'id = ? AND workspace_id = ?', [id, workspaceId],
    );
    if (!found) throw new NotFoundError('运行记录', id);
    return { ...found, steps: rows('agent_run_steps', 'run_id = ?', [id], 'step_index ASC') };
  },

  searchKnowledge(userId: string, workspaceId: string, query: string) {
    requireRole(workspaceId, userId, 'viewer');
    return search(workspaceId, query, 8);
  },

  addKnowledge(userId: string, workspaceId: string, input: { title: string; content: string; sourceType?: string }) {
    requireRole(workspaceId, userId, 'member');
    indexChunk(workspaceId, input.sourceType ?? 'manual', newId('knw'), input.title, input.content);
    audit(workspaceId, userId, 'knowledge.add', '', input.title);
    return { chunks: indexSize(workspaceId) };
  },

  reindex(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'admin');
    return { chunks: reindex(workspaceId, userId) };
  },

  shares(userId: string, workspaceId: string, documentId?: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows('document_shares', documentId ? 'workspace_id = ? AND document_id = ?' : 'workspace_id = ?',
      documentId ? [workspaceId, documentId] : [workspaceId]);
  },

  share(userId: string, workspaceId: string, documentId: string, targetUserId: string, permission: string) {
    requireRole(workspaceId, userId, 'admin');
    documentsService.get(userId, documentId);
    if (!get<{ id: string }>('SELECT id FROM users WHERE id = ?', targetUserId)) throw new NotFoundError('用户', targetUserId);
    const id = insertRow('document_shares', { workspace_id: workspaceId, document_id: documentId, user_id: targetUserId, permission });
    audit(workspaceId, userId, 'document.share', documentId, `${targetUserId}:${permission}`);
    return id;
  },

  comments(userId: string, workspaceId: string, documentId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows<{ id: string; user_id: string; content: string; created_at: string }>(
      'comments', 'workspace_id = ? AND document_id = ?', [workspaceId, documentId], 'created_at DESC',
    ).map((item) => ({ ...item, username: get<{ username: string }>('SELECT username FROM users WHERE id = ?', item.user_id)?.username ?? '未知' }));
  },

  addComment(userId: string, workspaceId: string, documentId: string, content: string) {
    requireRole(workspaceId, userId, 'member');
    const id = insertRow('comments', { workspace_id: workspaceId, document_id: documentId, user_id: userId, content });
    audit(workspaceId, userId, 'document.comment', documentId, content.slice(0, 100));
    return id;
  },

  versions(userId: string, workspaceId: string, documentId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows('document_versions', 'workspace_id = ? AND document_id = ?', [workspaceId, documentId], 'created_at DESC', 30);
  },

  snapshot(userId: string, workspaceId: string, documentId: string, note = '') {
    requireRole(workspaceId, userId, 'member');
    const doc = documentsService.get(userId, documentId);
    const id = insertRow('document_versions', {
      workspace_id: workspaceId, document_id: documentId, user_id: userId,
      title: doc.title, content: doc.content, note,
    });
    audit(workspaceId, userId, 'document.version', documentId, note);
    return id;
  },

  restoreVersion(userId: string, workspaceId: string, versionId: string) {
    requireRole(workspaceId, userId, 'member');
    const version = row<{ document_id: string; title: string; content: string }>('document_versions', 'id = ? AND workspace_id = ?', [versionId, workspaceId]);
    if (!version) throw new NotFoundError('版本', versionId);
    this.snapshot(userId, workspaceId, version.document_id, '恢复前自动快照');
    documentsService.update(userId, version.document_id, { title: version.title, content: version.content });
    audit(workspaceId, userId, 'document.restore', version.document_id, versionId);
    return version.document_id;
  },

  files(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows('files', 'workspace_id = ?', [workspaceId], 'created_at DESC', 100);
  },

  uploadFile(userId: string, workspaceId: string, input: { filename: string; mime: string; contentBase64: string }) {
    requireRole(workspaceId, userId, 'member');
    const buffer = Buffer.from(input.contentBase64, 'base64');
    if (buffer.length > 5_000_000) throw new BadRequestError('单个附件不能超过 5MB');
    const id = newId('fil');
    const safeName = input.filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 150) || 'file.bin';
    fs.mkdirSync(filesDir(), { recursive: true });
    const filePath = path.join(filesDir(), id);
    fs.writeFileSync(filePath, buffer);
    insertRow('files', { id, workspace_id: workspaceId, user_id: userId, filename: safeName, mime: input.mime || 'application/octet-stream', size: buffer.length, path: filePath });
    indexChunk(workspaceId, 'file', id, safeName, safeName);
    audit(workspaceId, userId, 'file.upload', id, safeName);
    return { id, filename: safeName, size: buffer.length };
  },

  readFile(userId: string, workspaceId: string, id: string): { filename: string; mime: string; content: Buffer } {
    requireRole(workspaceId, userId, 'viewer');
    const file = row<{ filename: string; mime: string; path: string }>('files', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    if (!file) throw new NotFoundError('文件', id);
    return { filename: file.filename, mime: file.mime, content: fs.readFileSync(file.path) };
  },

  deleteFile(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'member');
    const file = row<{ path: string }>('files', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    if (file) { try { fs.unlinkSync(file.path); } catch { /* 文件已不存在 */ } }
    deleteRows('files', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    audit(workspaceId, userId, 'file.delete', id);
  },

  async emitEvent(userId: string, workspaceId: string, eventKey: string, payload: Record<string, unknown>) {
    requireRole(workspaceId, userId, 'member');
    const eventId = insertRow('automation_events', { workspace_id: workspaceId, event_key: eventKey, payload: JSON.stringify(payload), status: 'pending' });
    const tasks = all<{ id: string }>(
      "SELECT id FROM automation_tasks WHERE workspace_id = ? AND trigger_type = 'event' AND event_key = ? AND enabled = 1",
      workspaceId, eventKey,
    );
    let executed = 0;
    for (const task of tasks) {
      await workspaceService.runTask(userId, task.id);
      executed += 1;
    }
    updateRows('automation_events', { status: 'processed' }, 'id = ?', [eventId]);
    audit(workspaceId, userId, 'event.emit', eventKey, `${tasks.length} 个任务`);
    return { eventId, matched: tasks.length, executed };
  },

  events(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows('automation_events', 'workspace_id = ?', [workspaceId], 'created_at DESC', 50);
  },

  workflows(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return rows<{ id: string; name: string; nodes: string; edges: string; enabled: number; created_at: string }>(
      'workflows', 'workspace_id = ?', [workspaceId], 'created_at DESC',
    ).map((item) => ({ ...item, nodes: JSON.parse(item.nodes), edges: JSON.parse(item.edges), enabled: Boolean(item.enabled) }));
  },

  saveWorkflow(userId: string, workspaceId: string, input: { id?: string; name: string; nodes: unknown[]; edges: unknown[]; enabled?: boolean }) {
    requireRole(workspaceId, userId, 'admin');
    const fields = {
      name: input.name, nodes: JSON.stringify(input.nodes), edges: JSON.stringify(input.edges),
      enabled: input.enabled === false ? 0 : 1, updated_at: now(),
    };
    if (input.id) { updateRows('workflows', fields, 'id = ? AND workspace_id = ?', [input.id, workspaceId]); return input.id; }
    const id = insertRow('workflows', { workspace_id: workspaceId, ...fields });
    audit(workspaceId, userId, 'workflow.save', id, input.name);
    return id;
  },

  async runWorkflow(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'member');
    const workflow = row<{ nodes: string; name: string }>('workflows', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    if (!workflow) throw new NotFoundError('工作流', id);
    const nodes = JSON.parse(workflow.nodes) as Array<{ id: string; tool: string; args?: Record<string, unknown> }>;
    const results: string[] = [];
    for (const node of nodes) {
      const output = await executeTool(node.tool, { userId, workspaceId }, node.args ?? {});
      results.push(`- ${node.tool}: ${output.slice(0, 160)}`);
    }
    audit(workspaceId, userId, 'workflow.run', id, `${nodes.length} 个节点`);
    return { results, text: `## 工作流「${workflow.name}」执行结果\n\n${results.join('\n')}` };
  },

  auditLogs(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'admin');
    return rows('audit_logs', 'workspace_id = ?', [workspaceId], 'created_at DESC', 100);
  },

  usage(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'admin');
    return rows('model_usage', 'workspace_id = ?', [workspaceId], 'created_at DESC', 100);
  },

  registerCustomTool(userId: string, workspaceId: string, input: { name: string; description: string; webhook?: string }) {
    requireRole(workspaceId, userId, 'admin');
    if (getTool(input.name)) throw new BadRequestError('同名工具已存在');
    registerTool({
      name: input.name, description: input.description, category: 'custom',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '输入内容' } } },
      run: async (_ctx, args) => {
        if (!input.webhook) return `自定义工具 ${input.name} 收到：${String(args.query ?? '')}`;
        try {
          const response = await fetch(input.webhook, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args), signal: AbortSignal.timeout(8000),
          });
          return `Webhook 返回 ${response.status}：${(await response.text()).slice(0, 500)}`;
        } catch (error) { return `Webhook 调用失败：${error instanceof Error ? error.message : String(error)}`; }
      },
    });
    audit(workspaceId, userId, 'tool.register', input.name);
    return toolManifest().find((item) => item.name === input.name);
  },

  async mcp(userId: string, workspaceId: string, request: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }) {
    requireRole(workspaceId, userId, 'member');
    const id = request.id ?? 1;
    if (request.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: toolManifest().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) } };
    }
    if (request.method === 'tools/call') {
      const params = request.params ?? {};
      const output = await executeTool(String(params.name ?? ''), { userId, workspaceId }, (params.arguments ?? {}) as Record<string, unknown>);
      audit(workspaceId, userId, 'mcp.call', String(params.name ?? ''));
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: output }] } };
    }
    if (request.method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mirelth-desk', version: '1.0.0' } } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${request.method ?? ''}` } };
  },

  async mcpCall(userId: string, workspaceId: string, name: string, args: Record<string, unknown>) {
    requireRole(workspaceId, userId, 'member');
    const output = await executeTool(name, { userId, workspaceId }, args);
    audit(workspaceId, userId, 'mcp.call', name);
    return { content: [{ type: 'text', text: output }] };
  },
};
