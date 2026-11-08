import { get, run } from './database.ts';
import { now, newId } from './crypto.ts';
import { logger } from './logger.ts';
import { authService } from '../features/auth/auth.service.ts';

export function seedDemoData(): void {
  const user = get<{ id: string }>('SELECT id FROM users LIMIT 1');
  if (!user) return;
  const userId = user.id;
  if ((get<{ count: number }>('SELECT COUNT(*) AS count FROM documents WHERE user_id = ?', userId)?.count ?? 0) > 0) return;

  const ts = now();
  const insertDocument = (title: string, kind: string, content: string, tags: string[]): void => {
    run(
      `INSERT INTO documents (id, user_id, title, content, kind, template, tags, word_count, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('doc'), userId, title, content, kind, 'weekly', JSON.stringify(tags),
      content.replace(/\s/g, '').length, 'draft', ts, ts,
    );
  };

  insertDocument(
    '第 42 周工作周报', 'weekly',
    '# 第 42 周工作周报\n\n## 本周完成\n- 完成 Q4 产品线需求评审与优先级排期\n- 交付客户数据看板 v2，查询耗时下降 38%\n- 完成 3 篇相关文献的精读与笔记整理\n\n## 关键数据\n| 指标 | 本周 | 环比 |\n| --- | --- | --- |\n| 需求交付 | 12 项 | +20% |\n| 缺陷关闭 | 18 个 | +12% |\n\n## 下周计划\n1. 推进实验 A/B 分组与指标口径对齐\n2. 完成季度复盘材料初稿\n', ['周报', '产品'],
  );
  insertDocument(
    'Q4 产品路线图草案', 'proposal',
    '# Q4 产品路线图草案\n\n## 背景\n围绕智能办公场景，聚焦文档、数据与协作三条主线。\n\n## 目标\n- 提升文档产出效率 30%\n- 建立统一的数据分析口径\n- 打通邮件到任务的闭环\n\n## 里程碑\n| 阶段 | 时间 | 交付物 |\n| --- | --- | --- |\n| 探索 | 10 月 | 需求池与原型 |\n| 验证 | 11 月 | 灰度版本 |\n| 发布 | 12 月 | 正式版 + 复盘 |\n', ['方案', '路线图'],
  );
  insertDocument(
    '项目启动会纪要', 'minutes',
    '# 项目启动会纪要\n\n**时间**：周一 10:00–11:30  **主持**：产品负责人\n\n## 结论\n1. 一期范围锁定「文档 + 数据 + 邮件」三个模块。\n2. 数据口径由分析组在周五前给出定义。\n\n## 待办\n- [ ] 输出接口契约（后端，周三）\n- [ ] 完成视觉稿评审（设计，周四）\n', ['会议', '纪要'],
  );

  const columns = [
    { name: '月份', type: 'categorical' },
    { name: '产品线', type: 'categorical' },
    { name: '营收', type: 'numeric' },
    { name: '成本', type: 'numeric' },
    { name: '新客户', type: 'numeric' },
  ];
  const rows = [
    { 月份: '1月', 产品线: '文档', 营收: 128, 成本: 62, 新客户: 24 },
    { 月份: '1月', 产品线: '数据', 营收: 96, 成本: 51, 新客户: 17 },
    { 月份: '2月', 产品线: '文档', 营收: 142, 成本: 65, 新客户: 28 },
    { 月份: '2月', 产品线: '数据', 营收: 108, 成本: 53, 新客户: 21 },
    { 月份: '3月', 产品线: '文档', 营收: 151, 成本: 68, 新客户: 31 },
    { 月份: '3月', 产品线: '数据', 营收: 132, 成本: 57, 新客户: 26 },
    { 月份: '4月', 产品线: '文档', 营收: 168, 成本: 71, 新客户: 35 },
    { 月份: '4月', 产品线: '数据', 营收: 145, 成本: 60, 新客户: 29 },
    { 月份: '5月', 产品线: '文档', 营收: 176, 成本: 73, 新客户: 38 },
    { 月份: '5月', 产品线: '数据', 营收: 158, 成本: 63, 新客户: 33 },
    { 月份: '6月', 产品线: '文档', 营收: 193, 成本: 78, 新客户: 42 },
    { 月份: '6月', 产品线: '数据', 营收: 171, 成本: 66, 新客户: 36 },
  ];
  run(
    'INSERT INTO datasets (id, user_id, name, filename, columns, rows, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId('dst'), userId, '上半年经营数据', 'sales_h1.csv', JSON.stringify(columns), JSON.stringify(rows), rows.length, ts,
  );

  const papers = [
    ['Attention Is All You Need', 'Vaswani, A. et al.', 2017, 'NeurIPS', '10.48550/arXiv.1706.03762', 'Transformer 架构奠基工作，提出自注意力机制替代循环结构。', ['LLM', '架构'], 'read', 5],
    ['Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks', 'Lewis, P. et al.', 2020, 'NeurIPS', '10.48550/arXiv.2005.11401', '将参数化记忆与非参数化检索结合，缓解知识更新与幻觉问题。', ['RAG', '检索'], 'reading', 4],
    ['A Survey of Large Language Models', 'Zhao, W. X. et al.', 2023, 'arXiv', '10.48550/arXiv.2303.18223', '系统梳理大模型预训练、适配、评测与应用的研究脉络。', ['综述', 'LLM'], 'read', 5],
    ['Chain-of-Thought Prompting Elicits Reasoning in Large Language Models', 'Wei, J. et al.', 2022, 'NeurIPS', '10.48550/arXiv.2201.11903', '通过中间推理步骤示例显著提升复杂推理任务表现。', ['推理', '提示工程'], 'unread', 0],
  ] as const;
  for (const [title, authors, year, venue, doi, abstract, tags, status, rating] of papers) {
    run(
      `INSERT INTO papers (id, user_id, title, authors, year, venue, doi, url, abstract, tags, status, rating, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('pap'), userId, title, authors, year, venue, doi, `https://doi.org/${doi}`, abstract,
      JSON.stringify(tags), status, rating, '', ts, ts,
    );
  }

  const projectId = newId('prj');
  run(
    'INSERT INTO projects (id, user_id, name, description, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    projectId, userId, '智能文档生成效果评估', '评估不同提示策略对办公文档质量与效率的影响。',
    '验证结构化大纲 + 迭代润色相对一次性生成的质量增益。', 'active', ts, ts,
  );
  run(
    `INSERT INTO experiments (id, user_id, project_id, title, hypothesis, method, result, conclusion, status, metrics, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('exp'), userId, projectId, 'EXP-01 大纲引导生成', '先生成结构化大纲再逐节展开，可显著提升文档完整度。',
    '招募 12 名参与者，交叉使用两种生成策略，对产出做盲评（完整性/逻辑/可读性，各 5 分）。',
    '结构化策略平均总分 4.2，一次性生成 3.5；完整性差异最显著。', '大纲引导在长文档场景更稳定，建议纳入默认流程。', 'completed',
    JSON.stringify([{ name: '完整性', value: 4.4 }, { name: '逻辑性', value: 4.1 }, { name: '可读性', value: 4.0 }]), ts, ts,
  );
  run(
    `INSERT INTO experiments (id, user_id, project_id, title, hypothesis, method, result, conclusion, status, metrics, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('exp'), userId, projectId, 'EXP-02 检索增强事实校验', '引入资料检索可降低文档中的事实性错误。',
    '对 40 篇文档中的可核查陈述进行人工标注，比较开启/关闭检索的差错率。', '', '', 'running', '[]', ts, ts,
  );
  for (const [title, status, priority, due] of [
    ['整理评测问卷结果', 'doing', 'high', '2026-11-12'],
    ['补充 EXP-02 事实标注样本', 'todo', 'medium', '2026-11-15'],
    ['撰写阶段报告初稿', 'todo', 'low', '2026-11-20'],
  ] as const) {
    run(
      'INSERT INTO tasks (id, user_id, project_id, title, status, priority, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId('tsk'), userId, projectId, title, status, priority, due, ts,
    );
  }

  const mails = [
    ['inbox', '关于 Q4 路线图评审的时间确认', 'lin.wei@example.com', '你好，\n\n想确认一下 Q4 路线图评审会是否定在本周四下午 3 点？我们需要提前准备数据看板与成本测算，方便的话请在周三前给到材料清单。\n\n谢谢！\n林薇', 0],
    ['inbox', '论文综述初稿反馈', 'zhou.q@example.com', '团队好，\n\n综述初稿已读完，整体结构清晰。建议在「检索增强」章节补充最近两年的对比工作，并把引用格式统一为 APA。第二章的方法分类可以再细化一下。\n\n周琪', 0],
    ['inbox', '【系统】实验平台周报', 'platform@example.com', '本周实验平台完成 128 次任务调度，成功率 99.2%。新增指标导出功能已上线，详见附件说明。', 1],
    ['sent', 'Re: 数据口径对齐', 'data-team@example.com', '各位好，\n\n口径已按会议结论更新：营收以确认口径统计，新客户按首次签约去重。文档已同步到共享空间，请查收。', 1],
  ] as const;
  for (const [folder, subject, addr, body, read] of mails) {
    run(
      `INSERT INTO messages (id, user_id, account_id, folder, remote_id, subject, from_addr, to_addr, body_text, sent_at, is_read, ai_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('msg'), userId, null, folder, `demo-${subject}`, subject,
      folder === 'sent' ? '我 <me@local>' : addr, folder === 'sent' ? addr : '我 <me@local>',
      body, ts, read, '', ts,
    );
  }

  for (const [module, action, description] of [
    ['document', 'create', '创建文档「第 42 周工作周报」'],
    ['analytics', 'upload', '导入数据集「上半年经营数据」'],
    ['paper', 'create', '收录论文「A Survey of Large Language Models」'],
    ['research', 'update', '更新实验「EXP-01 大纲引导生成」结论'],
    ['mail', 'sync', '同步收件箱，新增 3 封邮件'],
    ['agent', 'chat', '生成季度复盘材料大纲'],
  ] as const) {
    run(
      'INSERT INTO activity (id, user_id, module, action, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId('act'), userId, module, action, description, ts,
    );
  }

  authService.cleanup();
  logger.info('database.seeded', { user_id: userId });
}

export function seedWorkspaceApps(): void {
  const user = get<{ id: string }>('SELECT id FROM users LIMIT 1');
  if (!user) return;
  const userId = user.id;
  const ts = now();
  const taskCount = get<{ count: number }>('SELECT COUNT(*) AS count FROM automation_tasks WHERE user_id = ?', userId)?.count ?? 0;
  if (taskCount === 0) {
    const samples = [
      ['每日邮件摘要', '为最新一封未读邮件生成并保存 AI 摘要', 'manual', 0, 'mail', 'mail.summary', 1],
      ['每周周报初稿', '生成工作周报并自动存入文档库', 'manual', 0, 'documents', 'document.draft', 1],
      ['每小时同步收件箱', 'IMAP 收件同步（需先配置邮箱账户）', 'interval', 60, 'mail', 'mail.sync', 0],
    ] as const;
    for (const [name, description, trigger, interval, module, action, enabled] of samples) {
      run(
        `INSERT INTO automation_tasks (id, user_id, name, description, trigger_type, interval_minutes, module, action,
         enabled, last_run_at, next_run_at, run_count, last_status, last_result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 'idle', '', ?, ?)`,
        newId('atm'), userId, name, description, trigger, interval, module, action, enabled, ts, ts,
      );
    }
  }
  const connectorCount = get<{ count: number }>('SELECT COUNT(*) AS count FROM connectors WHERE user_id = ?', userId)?.count ?? 0;
  if (connectorCount === 0) {
    run(
      `INSERT INTO connectors (id, user_id, name, kind, base_url, description, token_encrypted, status,
       enabled, last_checked_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', ?, ?)`,
      newId('con'), userId, '企业知识库 Webhook', 'webhook', 'https://example.com/hook',
      '示例连接器：可点击「测试连接」验证连通性，之后替换为真实服务地址', '', 'disconnected', 1, ts, ts,
    );
  }
}
