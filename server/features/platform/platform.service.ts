import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../shared/config.ts';
import { all, get } from '../../shared/database.ts';
import { newId, now } from '../../shared/crypto.ts';
import { BadRequestError, NotFoundError } from '../../shared/errors.ts';
import { aiStatus } from '../../ai/provider.ts';
import { documentsService } from '../documents/documents.service.ts';
import { workspaceService } from '../workspace/workspace.service.ts';
import { embedPending, indexChunk, indexSize, reindex, removeSource, searchHybrid, semanticSize } from './rag.ts';
import { memoriesService, MEMORY_LAYERS, type MemoryLayer } from './memories.ts';
import { audit, count, defaultWorkspace, deleteRows, insertRow, requireRole, row, rows, updateRows, ROLE_LEVEL } from './store.ts';
import { allTools, builtinToolNames, executeTool, getTool, toolManifest } from './tools.ts';
import { pluginsService } from './plugins.ts';
import { buildIndex, dropIndex, indexStats } from './vector-index.ts';

const DAILY_LIMIT = config.ai.dailyLimit;

function filesDir(): string {
  return path.join(config.root, '.data', 'files');
}

export const platformService = {
  async status(userId: string) {
    const workspace = defaultWorkspace(userId);
    const today = new Date().toISOString().slice(0, 10);
    return {
      ...aiStatus(),
      workspace,
      tools: (await allTools(workspace.id)).length,
      knowledgeChunks: indexSize(workspace.id),
      conversations: count('conversations', 'workspace_id = ?', [workspace.id]),
      runs: count('agent_runs', 'workspace_id = ?', [workspace.id]),
      members: count('memberships', 'workspace_id = ?', [workspace.id]),
      quota: {
        limit: DAILY_LIMIT,
        used: count('model_usage', 'user_id = ? AND created_at LIKE ?', [userId, `${today}%`]),
      },
      retrieval: {
        mode: semanticSize(workspace.id) > 0 ? 'hybrid' : 'lexical',
        semanticChunks: semanticSize(workspace.id),
        embeddingModel: config.llm.embeddingEnabled ? config.llm.embeddingModel : '',
        vectorIndex: config.llm.embeddingEnabled
          ? indexStats(workspace.id, config.llm.embeddingModel)
          : null,
      },
      memories: memoriesService.count(workspace.id, userId),
      memoryLayers: memoriesService.layerStatus(workspace.id, userId),
      planning: {
        planner: config.agent.plannerEnabled,
        reflect: config.agent.reflectEnabled,
        maxSteps: config.agent.maxSteps,
        defaultSteps: config.agent.defaultSteps,
        maxRevisions: config.agent.maxRevisions,
        runTimeoutMs: config.agent.runTimeoutMs,
      },
      plugins: pluginsService.status(workspace.id),
      features: ['tool_calls', 'rag_hybrid', 'conversations', 'memory', 'workspaces', 'shares',
        'comments', 'versions', 'files', 'events', 'audit', 'quota', 'workflows', 'mcp',
        'pdf_import', 'ocr', 'browser_automation', 'planner', 'reflection', 'plugins', 'vector_index', 'memory_layers'],
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
      model: input.model ?? '', max_steps: input.maxSteps ?? config.agent.defaultSteps, updated_at: now(),
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
    audit(workspaceId, userId, 'agent.update', id, String(patch.name ?? ''));
    return id;
  },

  deleteAgent(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'admin');
    deleteRows('agent_definitions', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    audit(workspaceId, userId, 'agent.delete', id);
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
    return rows<{
      id: string; status: string; input: string; output: string; steps_count: number;
      tokens_estimate: number; duration_ms: number; created_at: string;
      plan_origin: string; revisions: number; stopped_reason: string;
    }>(
      'agent_runs', 'workspace_id = ?', [workspaceId], 'created_at DESC', 50,
    );
  },

  run(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'viewer');
    const found = row<{
      id: string; status: string; input: string; output: string; created_at: string;
      plan_json: string; plan_origin: string; revisions: number; stopped_reason: string;
    }>(
      'agent_runs', 'id = ? AND workspace_id = ?', [id, workspaceId],
    );
    if (!found) throw new NotFoundError('运行记录', id);
    // plan_json 解析失败不影响详情可读：计划只是附加信息。
    let plan: unknown = null;
    try { plan = found.plan_json ? JSON.parse(found.plan_json) : null; } catch { plan = null; }
    return { ...found, plan, steps: rows('agent_run_steps', 'run_id = ?', [id], 'step_index ASC') };
  },

  async searchKnowledge(userId: string, workspaceId: string, query: string) {
    requireRole(workspaceId, userId, 'viewer');
    const { hits } = await searchHybrid(workspaceId, query, 8);
    return hits;
  },

  async addKnowledge(userId: string, workspaceId: string, input: { title: string; content: string; sourceType?: string }) {
    requireRole(workspaceId, userId, 'member');
    indexChunk(workspaceId, input.sourceType ?? 'manual', newId('knw'), input.title, input.content);
    await embedPending(workspaceId, 64);
    audit(workspaceId, userId, 'knowledge.add', '', input.title);
    return { chunks: indexSize(workspaceId), semanticChunks: semanticSize(workspaceId) };
  },

  async reindex(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'admin');
    const chunks = await reindex(workspaceId, userId);
    return { chunks, semanticChunks: semanticSize(workspaceId) };
  },

  /** 只补语义向量，不重建词法索引——配好嵌入模型后用它把存量内容向量化。 */
  async embedKnowledge(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'admin');
    const embedded = await embedPending(workspaceId, 1024);
    return { embedded, semanticChunks: semanticSize(workspaceId) };
  },

  /**
   * 建/重建向量索引。未配嵌入模型时如实报错而非静默成功——
   * 没有向量就没有可索引的东西，返回「已建索引 0 条」会误导用户。
   */
  buildVectorIndex(userId: string, workspaceId: string, force = false) {
    requireRole(workspaceId, userId, 'admin');
    const model = config.llm.embeddingEnabled ? config.llm.embeddingModel : '';
    if (!model) {
      throw new BadRequestError('未配置 LLM_EMBEDDING_MODEL，没有语义向量可索引。请先配置嵌入模型并执行向量化');
    }
    const built = buildIndex(workspaceId, model, { force });
    if (!built) {
      throw new BadRequestError('当前没有已向量化的知识片段。请先调用 /knowledge/embed 生成向量');
    }
    audit(workspaceId, userId, 'vector.index', built.centroidId, `${built.buckets} 桶 / ${built.assigned} 片段`);
    return { ...built, stats: indexStats(workspaceId, model) };
  },

  vectorIndexStatus(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    const model = config.llm.embeddingEnabled ? config.llm.embeddingModel : '';
    const stats = model ? indexStats(workspaceId, model) : null;
    return {
      embeddingModel: model,
      config: {
        mode: config.vector.mode,
        autoThreshold: config.vector.autoThreshold,
        buckets: config.vector.buckets,
        probes: config.vector.probes,
      },
      stats,
      note: !model
        ? '未配置嵌入模型，检索走词法路径，无需向量索引。'
        : stats?.indexed
          ? `已建索引：${stats.buckets} 桶、${stats.assigned} 片段已归桶；本次检索将走${stats.mode === 'index' ? '索引裁剪' : '全扫（规模未达阈值）'}。`
          : '尚未建索引，检索走全扫。片段数超过阈值后建议建索引。',
    };
  },

  dropVectorIndex(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'admin');
    dropIndex(workspaceId);
    audit(workspaceId, userId, 'vector.index_drop', workspaceId);
    return { ok: true };
  },

  memories(userId: string, workspaceId: string, layer?: string) {
    requireRole(workspaceId, userId, 'viewer');
    const safeLayer = MEMORY_LAYERS.includes(layer as MemoryLayer) ? layer as MemoryLayer : undefined;
    return memoriesService.list(workspaceId, userId, safeLayer);
  },

  memoryLayers(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'viewer');
    return memoriesService.layerStatus(workspaceId, userId);
  },

  clearMemoryLayer(userId: string, workspaceId: string, layer: string) {
    requireRole(workspaceId, userId, 'member');
    if (!MEMORY_LAYERS.includes(layer as MemoryLayer)) throw new BadRequestError('未知的记忆层');
    const removed = memoriesService.clearLayer(workspaceId, userId, layer as MemoryLayer);
    audit(workspaceId, userId, 'memory.clear_layer', layer, `${removed} 条`);
    return { removed };
  },

  purgeMemories(userId: string, workspaceId: string) {
    requireRole(workspaceId, userId, 'member');
    const removed = memoriesService.purgeExpired(workspaceId, userId);
    audit(workspaceId, userId, 'memory.purge', '', `${removed} 条过期`);
    return { removed };
  },

  addMemory(userId: string, workspaceId: string, input: { content: string; kind?: string }) {
    requireRole(workspaceId, userId, 'member');
    const created = memoriesService.save(workspaceId, userId, input.content, input.kind ?? 'preference', 'manual');
    audit(workspaceId, userId, 'memory.add', created.id, input.content.slice(0, 80));
    return created;
  },

  async removeMemory(userId: string, workspaceId: string, id: string) {
    requireRole(workspaceId, userId, 'member');
    memoriesService.remove(workspaceId, userId, id);
    audit(workspaceId, userId, 'memory.remove', id);
    return { ok: true };
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
    // 只回给界面用得上的列：`path` 是本机绝对路径，不该出服务端。
    return rows<{ id: string; filename: string; mime: string; size: number; created_at: string }>(
      'files', 'workspace_id = ?', [workspaceId], 'created_at DESC', 100,
    ).map((item) => ({ id: item.id, filename: item.filename, mime: item.mime, size: item.size, created_at: item.created_at }));
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
    // 文本类附件索引正文（此前只索引文件名，内容搜不到）；二进制留给 PDF/OCR 流程。
    const textual = /\.(txt|md|csv|json|log|tsv|html?)$/i.test(safeName) || /^(text\/|application\/(json|csv))/.test(input.mime ?? '');
    const body = textual ? `${safeName}\n${buffer.toString('utf8').slice(0, 20_000)}` : safeName;
    indexChunk(workspaceId, 'file', id, safeName, body);
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
    removeSource(workspaceId, 'file', id);
    deleteRows('files', 'id = ? AND workspace_id = ?', [id, workspaceId]);
    audit(workspaceId, userId, 'file.delete', id);
  },

  async emitEvent(userId: string, workspaceId: string, eventKey: string, payload: Record<string, unknown>) {
    requireRole(workspaceId, userId, 'member');
    const eventId = insertRow('automation_events', { workspace_id: workspaceId, event_key: eventKey, payload: JSON.stringify(payload), status: 'pending' });
    const tasks = all<{ id: string }>(
      // 按 `user_id` 而不是 `workspace_id` 匹配：自动化任务在创建时不带工作区（`workspace_id` 为 NULL），
      // 而事件总是发生在某个工作区里——按工作区匹配会让 `matched` 恒为 0。
      "SELECT id FROM automation_tasks WHERE user_id = ? AND trigger_type = 'event' AND event_key = ? AND enabled = 1",
      userId, eventKey,
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
    if (input.id) { updateRows('workflows', fields, 'id = ? AND workspace_id = ?', [input.id, workspaceId]); audit(workspaceId, userId, 'workflow.update', input.id, input.name); return input.id; }
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

  /**
   * 旧「注册自定义工具」入口，保留兼容但**改为落库的插件**。
   *
   * 旧实现有三个问题，都在此收口：内存 Map 重启即丢、跨工作区可见、
   * webhook 地址无任何限制且请求体是模型可控参数。现在统一走 pluginsService：
   * 落库 + 工作区隔离 + 出站闸门（白名单默认空即拒全部）。
   *
   * 无 webhook 的「回声工具」不再支持——它没有真实用途，却占用一个工具名。
   */
  async registerCustomTool(userId: string, workspaceId: string, input: { name: string; description: string; webhook?: string }) {
    if (!input.webhook) {
      throw new BadRequestError('请提供 webhook 地址；自定义工具现在作为插件落库，需指向真实可调用的端点');
    }
    const created = pluginsService.create(userId, workspaceId, {
      name: input.name, description: input.description, endpoint: input.webhook,
      parameters: { query: { type: 'string', description: '输入内容', required: true } },
    }, builtinToolNames());
    return (await toolManifest(workspaceId)).find((item) => item.name === created.name);
  },

  async mcp(userId: string, workspaceId: string, request: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }) {
    requireRole(workspaceId, userId, 'member');
    const id = request.id ?? 1;
    if (request.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: (await toolManifest(workspaceId)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) } };
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
