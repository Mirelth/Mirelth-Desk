import type { AiInput, TaskKind } from './prompts.ts';

type Dict = Record<string, unknown>;

function text(input: AiInput, key: string, fallback = ''): string {
  const value = input[key];
  return typeof value === 'string' ? value : fallback;
}

function number(input: AiInput, key: string, fallback = 0): number {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function items<T = Dict>(input: AiInput, key: string): T[] {
  const value = input[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function clip(value: string, max = 90): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function bulletLines(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}

interface ColumnStat { name: string; type: string; missing?: number; mean?: number; min?: number; max?: number; std?: number }
interface GroupStat { label: string; value: number; count?: number }
interface TrendPoint { label: string; value: number }

function analyticsInsights(input: AiInput): string {
  const name = text(input, 'datasetName', '当前数据集');
  const rowCount = number(input, 'rowCount');
  const columns = items<ColumnStat>(input, 'columns');
  const groups = items<GroupStat>(input, 'groups');
  const trend = items<TrendPoint>(input, 'trend');
  const numeric = columns.filter((column) => column.type === 'numeric');
  const categorical = columns.filter((column) => column.type === 'categorical');
  const lines: string[] = [`## ${name} · 数据洞察`, '', '### 1. 数据概览',
    `- 样本量：${rowCount} 行，共 ${columns.length} 个字段（数值型 ${numeric.length} 个、类别型 ${categorical.length} 个）。`];
  const missing = columns.filter((column) => (column.missing ?? 0) > 0);
  lines.push(missing.length
    ? `- 数据质量：${missing.map((c) => `${c.name} 缺失 ${c.missing} 条`).join('、')}，建议在正式结论前补齐或标注剔除规则。`
    : '- 数据质量：本次统计未发现缺失值，字段完整。');

  lines.push('', '### 2. 关键发现');
  if (trend.length >= 2) {
    const first = trend[0];
    const last = trend[trend.length - 1];
    const delta = first.value === 0 ? 0 : ((last.value - first.value) / Math.abs(first.value)) * 100;
    const direction = delta >= 0 ? '增长' : '下降';
    lines.push(`- **整体趋势**：从 ${first.label} 的 ${first.value} 到 ${last.label} 的 ${last.value}，累计${direction} ${Math.abs(delta).toFixed(1)}%。`);
    const peak = trend.reduce((best, point) => (point.value > best.value ? point : best), trend[0]);
    lines.push(`- **峰值**：${peak.label} 达到 ${peak.value}，为区间最高点。`);
  }
  for (const column of numeric.slice(0, 3)) {
    if (column.mean === undefined) continue;
    const spread = column.mean !== 0 && column.std !== undefined ? `，变异系数 ${(Math.abs(column.std / column.mean) * 100).toFixed(1)}%` : '';
    lines.push(`- **${column.name}**：均值 ${column.mean}，区间 [${column.min ?? '-'}, ${column.max ?? '-'}]${spread}。`);
  }
  if (groups.length >= 2) {
    const ranked = [...groups].sort((a, b) => b.value - a.value);
    lines.push(`- **分组对比**：${ranked[0].label} 最高（${ranked[0].value}），${ranked[ranked.length - 1].label} 最低（${ranked[ranked.length - 1].value}），差距 ${(ranked[0].value - ranked[ranked.length - 1].value).toFixed(1)}。`);
  }
  if (!trend.length && !numeric.length) lines.push('- 当前字段缺少可用于统计推断的数值信息，建议补充度量指标后再做趋势分析。');

  lines.push('', '### 3. 建议动作', bulletLines([
    '把本期变化拆解到分组维度，确认增长来自普遍提升还是单一分组拉动。',
    '对高波动指标补充同比/环比基线，并标记异常点对应的业务事件。',
    '将以上结论与原始数据一起归档，形成可复现的分析记录与图表快照。',
  ]), '', '### 4. 局限性',
  '- 以上结论基于当前导入样本的描述性统计，相关性不等于因果；如需推断性结论，请补充对照组与显著性检验。');
  return lines.join('\n');
}

function documentOutline(input: AiInput): string {
  const title = text(input, 'title', '未命名文档');
  const kind = text(input, 'template', '通用文档');
  const points = items<string>(input, 'points').filter((p) => typeof p === 'string');
  return [
    `# 《${title}》写作大纲`, '', `> 类型：${kind} ｜ 用途：先在下方确认骨架，再逐节展开正文。`, '',
    '## 一、背景与目标', '- 写作提示：交代缘起、受众与本文档希望解决的一个核心问题。',
    '## 二、现状与关键事实', '- 写作提示：只放可核验的数据与事实，注明来源和时间口径。',
    '## 三、主体内容',
    '### 3.1 核心方案', '- 写作提示：给出 2–3 个可选方案与取舍依据。',
    '### 3.2 实施路径', '- 写作提示：按阶段列出里程碑、责任人与交付物。',
    '## 四、数据与证据', '- 写作提示：用表格承载关键指标，避免文字堆砌数字。',
    '## 五、风险与应对', '- 写作提示：列出主要风险、影响面与缓解措施。',
    '## 六、结论与行动项', '- 写作提示：一句话结论 + 编号待办（含截止时间）。',
    ...(points.length ? ['', '## 需要覆盖的要点', bulletLines(points.map(clip))] : []),
  ].join('\n');
}

function documentDraft(input: AiInput): string {
  const title = text(input, 'title', '工作文档');
  const kind = text(input, 'template', '通用文档');
  const points = items<string>(input, 'points').filter((p) => typeof p === 'string');
  const bodyPoints = points.length ? points.map(clip) : ['明确本次工作的目标与范围', '梳理现状与关键约束', '给出可执行的推进方案'];
  return [
    `# ${title}`, '', `> 文档类型：${kind} ｜ 状态：初稿（请补充具体数据与责任人）`, '',
    '## 一、背景与目标',
    `本文档面向${kind}场景，围绕「${title}」梳理当前进展、关键判断与后续安排，目标是让相关方在同一事实基础上做出决策。`, '',
    '## 二、关键要点', bulletLines(bodyPoints.map((point, index) => `${index + 1}. ${point}`)), '',
    '## 三、推进方案',
    '| 阶段 | 关键动作 | 交付物 | 建议时间 |', '| --- | --- | --- | --- |',
    '| 准备 | 明确口径与数据范围 | 数据清单 / 需求说明 | 第 1 周 |',
    '| 执行 | 按方案落地并记录偏差 | 阶段产出 / 过程记录 | 第 2–3 周 |',
    '| 复盘 | 对照目标评估效果 | 复盘报告 / 改进项 | 第 4 周 |', '',
    '## 四、风险与应对',
    '- **口径不一致**：在分析开始前冻结指标定义，变更需记录版本。',
    '- **信息缺失**：缺项统一标注「待补充」，不以推测替代事实。',
    '- **排期延误**：按周检查里程碑，遇阻及时升级并缩范围。', '',
    '## 五、结论与行动项',
    `综上，建议以「${title}」为主线推进，先完成口径与范围确认，再进入执行与复盘。`, '',
    '1. 明确负责人与截止时间（待补充）。', '2. 补齐关键数据与佐证材料（待补充）。', '3. 约定下一次同步节点（待补充）。',
  ].join('\n');
}

function documentPolish(input: AiInput): string {
  const source = text(input, 'content');
  const replacements: Array<[RegExp, string]> = [
    [/非常/g, '显著'], [/搞定|弄好/g, '完成'], [/很多/g, '较多'], [/大概|可能吧/g, '据现有信息'],
    [/我觉得|我认为/g, '综合判断'], [/首先，?/g, '第一，'], [/然后，?/g, '其次，'], [/但是/g, '但'],
    [/【/g, '「'], [/】/g, '」'],
  ];
  let polished = source;
  const applied: string[] = [];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(polished)) {
      applied.push(`将「${pattern.source.replace(/[\\^$*+?.()|[\]{}]/g, '')}」统一为「${replacement}」`);
      polished = polished.replace(pattern, replacement);
    }
  }
  const headingCount = (source.match(/^#{1,6}\s/gm) ?? []).length;
  return [
    '## 润色后的正文', '', polished.trim() || '（原文为空，请先输入内容）', '',
    '## 修改要点', '',
    bulletLines([
      ...applied.slice(0, 6),
      headingCount === 0 ? '建议补充层级标题，让长文更易扫读；当前正文没有小标题。' : `保留原有 ${headingCount} 处标题层级，维持文档结构。`,
      '统一了口语化表达与标点，事实、数字与专有名词未作改动。',
    ]), '',
    '> 提示：如需更强的风格改写（正式汇报 / 简洁邮件 / 学术论文），可在模型接入后通过提示词指定。',
  ].join('\n');
}

function documentContinue(input: AiInput): string {
  const source = text(input, 'content');
  const lastLines = source.split('\n').filter((line) => line.trim()).slice(-3).map(clip);
  return [
    '## 续写内容', '',
    '在现有工作基础上，建议进一步明确衡量口径：把目标拆解为可观测的指标，并为每个指标指定数据来源与复核人。这样既能保证阶段结论可验证，也便于在复盘时定位偏差来源。', '',
    '执行层面可以按「先小范围验证、再逐步扩展」的节奏推进。首个验证周期只保留最关键的 2–3 个变量，降低干扰；确认方向有效后，再补充样本与分组，形成完整结论。过程中出现的异常点应单独记录，不直接剔除。', '',
    '最后，将结论、原始数据与决策依据一并归档，并在下一次同步时列出未解决问题与责任人。', '',
    '### 衔接提示', bulletLines(lastLines.length ? lastLines.map((line) => `承接上文：「${line}」`) : ['上文为空，以上为通用续写']),
  ].join('\n');
}

function paperSynthesis(input: AiInput, mode: 'summary' | 'review' | 'synthesize'): string {
  const papers = items<Dict>(input, 'papers');
  const rows = papers.map((paper) => ({
    title: String(paper.title ?? '未命名文献'),
    authors: String(paper.authors ?? ''),
    year: Number(paper.year ?? 0),
    venue: String(paper.venue ?? ''),
    tags: Array.isArray(paper.tags) ? (paper.tags as string[]) : [],
    abstract: String(paper.abstract ?? ''),
    status: String(paper.status ?? ''),
  }));
  const tags = [...new Set(rows.flatMap((row) => row.tags))];
  const years = rows.map((row) => row.year).filter(Boolean).sort((a, b) => a - b);
  const byTag = tags.map((tag) => ({ tag, papers: rows.filter((row) => row.tags.includes(tag)) })).filter((group) => group.papers.length);
  const head = mode === 'review' ? '文献综述大纲' : mode === 'synthesize' ? '文献综述初稿' : '文献整理与脉络分析';
  const lines: string[] = [`## ${head}`, '', `> 覆盖 ${rows.length} 篇文献${years.length ? `，时间跨度 ${years[0]}–${years[years.length - 1]}` : ''}。`, '',
    '### 1. 主题聚类'];
  if (byTag.length) {
    for (const group of byTag) {
      lines.push(`**${group.tag}**（${group.papers.length} 篇）`, bulletLines(group.papers.map((paper) => `${paper.title}（${paper.year || '年份待补充'}，${paper.venue || '出处待补充'}）`)), '');
    }
  } else lines.push('- 当前文献尚未标注主题标签，建议先按「方法 / 应用 / 评测」分类。', '');

  lines.push('### 2. 研究脉络');
  if (rows.length) {
    for (const paper of [...rows].sort((a, b) => a.year - b.year)) {
      lines.push(`- **${paper.year || '待补充'}**｜${paper.title}${paper.abstract ? `：${clip(paper.abstract, 110)}` : '（摘要待补充）'}`);
    }
  } else lines.push('- 文献库为空，请先在「论文整理」中添加文献。', '');

  lines.push('', '### 3. 共识、分歧与空白',
    '- **共识**：现有工作普遍认同结构化流程与可验证评测的重要性（基于已录入摘要归纳）。',
    '- **分歧**：不同工作在效果评估口径、数据集与基线选择上并不一致，横向比较需谨慎。',
    '- **空白**：缺少统一的对比实验与长期效果追踪；建议作为后续选题方向。', '',
    '### 4. 阅读与引用建议',
    bulletLines([
      `优先精读 ${rows.filter((r) => r.status === 'unread').length} 篇未读文献，并按主题补齐笔记。`,
      '对每篇文献记录「研究问题 / 方法 / 关键结论 / 可复用之处」四要素，方便综述直接取用。',
      '导出引用前核对 DOI、作者与年份，避免参考文献格式错误。',
    ]));
  if (mode === 'review') {
    lines.push('', '### 5. 建议章节结构',
      '1. 引言：问题定义与研究意义', '2. 方法分类：按主题聚类分节', '3. 评测与对比：口径、数据集、指标',
      '4. 开放问题：分歧与空白', '5. 结论与展望');
  }
  return lines.join('\n');
}

function researchDesign(input: AiInput): string {
  const title = text(input, 'title', '未命名实验');
  const objective = text(input, 'objective') || text(input, 'hypothesis') || '验证方案是否带来可观测的改进';
  return [
    `## 实验设计 · ${title}`, '', '### 1. 研究假设',
    `- **H1**：${clip(objective, 120)}`,
    '- **H0**：方案与基线在核心指标上无显著差异。', '',
    '### 2. 变量定义',
    '| 类型 | 内容 | 测量方式 |', '| --- | --- | --- |',
    '| 自变量 | 是否启用新方案（对照组 / 实验组） | 分组标记 |',
    '| 因变量 | 质量评分、完成耗时、事实差错率 | 盲评 + 系统日志 |',
    '| 控制变量 | 任务难度、样本来源、执行时长 | 分层随机化 |', '',
    '### 3. 方法与步骤',
    '1. 明确纳入/排除标准，冻结指标口径与评分细则。',
    '2. 按分层随机将样本分为对照组与实验组，记录分组依据。',
    '3. 双盲评分（至少 2 名评审），计算一致性系数后再取均值。',
    '4. 预先确定样本量与停止规则，避免中途反复查看结果。', '',
    '### 4. 评价指标', '- 主指标：质量总分（1–5 分）；副指标：完成耗时、差错率、修订轮次。',
    '- 判定标准：同时满足效应量达到预设阈值且置信区间不跨零，方认为支持 H1。', '',
    '### 5. 风险与伦理',
    '- 混杂因素：任务难度不均、评审主观偏差 → 采用分层随机与盲评缓解。',
    '- 数据合规：只保留脱敏后的评分与日志记录，注明保存期限。', '',
    '### 6. 交付物', '- 实验方案文档、原始记录表、分析脚本、结论与复现说明。',
  ].join('\n');
}

function researchInterpret(input: AiInput): string {
  const title = text(input, 'title', '实验结果');
  const result = text(input, 'result');
  const metrics = items<{ name: string; value: number }>(input, 'metrics');
  return [
    `## 结果解读 · ${title}`, '', '### 1. 数据支持的结论',
    result ? `- ${clip(result, 200)}` : '- 尚未录入结果数据，当前只能给出解读框架，不能下结论。',
    ...(metrics.length ? [bulletLines(metrics.map((metric) => `${metric.name}：${metric.value}`))] : []), '',
    '### 2. 推测（需进一步验证）',
    '- 观察到的差异可能来自方案本身，也可能来自样本难度分布或评审偏好，暂不能作因果解释。', '',
    '### 3. 局限性', '- 样本量与分组信息待补充；缺少置信区间与显著性检验；单次实验尚未复现。', '',
    '### 4. 下一步', bulletLines([
      '补齐样本量、分组与方差数据，计算效应量与置信区间。',
      '在另一批样本上复现，检查结论方向是否稳定。',
      '按指标拆分结果，定位改进主要来自哪个维度。',
    ]),
  ].join('\n');
}

function mailReply(input: AiInput): string {
  const subject = text(input, 'subject', '（无主题）');
  const from = text(input, 'from', '对方');
  const body = text(input, 'body');
  const tone = text(input, 'tone', '专业礼貌');
  const requests = body.split('\n').map((line) => line.trim())
    .filter((line) => line.length > 3 && /[?？]|请|需要|建议|确认|补充|统一|准备|评审/.test(line))
    .slice(0, 4).map(clip);
  const name = from.includes('<') ? from.split('<')[0].trim() : from.split('@')[0] || '您好';
  return [
    `**主题**：Re: ${subject}`, '', `${name} 你好，`, '',
    `感谢来信，已收到关于「${subject}」的内容。${tone === '简洁' ? '简要回复如下：' : '我梳理了其中的关键事项，逐项回复如下：'}`,
    '', ...(requests.length
      ? requests.map((request, index) => `${index + 1}. 关于「${request}」：我们会按现有安排核对相关材料，并在确认后同步具体时间与清单。`)
      : ['1. 已了解邮件中的主要诉求，我们会尽快核对相关材料并给出明确反馈。']), '',
    '下一步：',
    '- 由我负责汇总需确认的材料与数据口径；',
    '- 确认后第一时间回复时间节点与参与人；',
    '- 如有需要，可另约一次简短对齐会。', '',
    '如有遗漏或优先级调整，请随时告知。', '', '祝好，', '我',
  ].join('\n');
}

function mailSummary(input: AiInput): string {
  const body = text(input, 'body');
  const sentences = body.split(/[\n。！？!?]/).map((part) => part.trim()).filter((part) => part.length > 4);
  const keywords = sentences.filter((sentence) => /请|需要|建议|确认|补充|统一|准备|上线|评审|时间/.test(sentence));
  return [
    '## 邮件摘要', '',
    `- **一句话**：${clip(sentences[0] ?? text(input, 'subject', '邮件内容待补充'), 100)}`,
    `- **主题**：${text(input, 'subject', '（无主题）')}`,
    `- **发件人**：${text(input, 'from', '未知')}`, '',
    '### 关键信息', bulletLines((sentences.slice(0, 3).length ? sentences.slice(0, 3) : ['正文暂无可提取信息']).map(clip)), '',
    '### 待执行动作', bulletLines((keywords.length ? keywords : ['无需明确动作，建议归档留存']).slice(0, 4).map(clip)),
  ].join('\n');
}

function mailCompose(input: AiInput): string {
  const subject = text(input, 'subject', '工作沟通');
  const to = text(input, 'to', '相关同事');
  const points = items<string>(input, 'points').filter((point) => typeof point === 'string');
  return [
    `**收件人**：${to}`, `**主题**：${subject}`, '', '各位好，', '',
    `就「${subject}」同步一下当前进展与需要确认的事项，便于后续对齐排期。`, '',
    '### 主要内容', bulletLines(points.length ? points.map(clip) : ['当前进展与关键结论（待补充）', '需要协同确认的事项（待补充）']), '',
    '### 需要确认', '1. 上述口径与范围是否准确；', '2. 时间节点与责任人是否可行。', '',
    '如无异议，我们将按此推进；也欢迎直接回复补充意见。', '', '谢谢！', '我',
  ].join('\n');
}

function agentChat(input: AiInput): string {
  const message = text(input, 'message');
  const stats = (input.workspace ?? {}) as Dict;
  const routes: Array<[RegExp, string, string]> = [
    [/周报|月报|纪要|文档|写作|润色|方案|大纲|总结/, '文档写作', '可以基于模板生成大纲与初稿，再逐节润色；也可以把已有内容粘贴进来做风格改写。'],
    [/数据|csv|表格|图表|统计|分析|报表|指标/, '数据分析', '先导入 CSV，工作台会自动推断字段类型、计算描述性统计并出图，再生成数据洞察报告。'],
    [/论文|文献|引用|综述|参考文献|bib|doi/i, '论文整理', '可按主题/年份管理文献，导出 BibTeX、RIS 与 APA 引用，并生成综述大纲。'],
    [/实验|研究|假设|课题|科研|复现/, '科学研究', '可记录假设、方法、结果与结论，生成实验设计和结果解读框架。'],
    [/邮件|邮箱|回复|收件|发信|smtp|imap/i, '邮箱', '同步收件箱后可一键生成邮件摘要与回复草稿，支持 SMTP 发送。'],
  ];
  const matched = routes.find(([pattern]) => pattern.test(message));
  const counts = [
    `文档 ${Number(stats.documents ?? 0)} 篇`, `数据集 ${Number(stats.datasets ?? 0)} 个`,
    `文献 ${Number(stats.papers ?? 0)} 篇`, `实验 ${Number(stats.experiments ?? 0)} 项`,
    `未读邮件 ${Number(stats.unreadMail ?? 0)} 封`,
  ].join(' · ');
  if (matched) {
    const [, module, description] = matched;
    return [
      `## 已为你规划到「${module}」`, '', `> 当前工作台：${counts}`, '',
      description, '', '### 建议的下一步',
      '1. 在左侧切换到对应模块，补充必要的事实材料（原文、CSV、文献元数据或邮件正文）。',
      '2. 点击模块内的智能生成按钮，我会基于材料直接产出可用初稿。',
      '3. 人工核对数字、时间与责任人后归档或发送。', '',
      `### 关于「${clip(message, 60)}」`,
      '如果你希望现在就看到初稿，可以直接在该模块使用「生成」能力；我不会替你编造缺失的数据。',
    ].join('\n');
  }
  return [
    '## 我可以帮你处理这些工作', '', `> 当前工作台：${counts}`, '',
    '| 模块 | 典型任务 |', '| --- | --- |',
    '| 文档写作 | 大纲、初稿、润色、续写、摘要 |',
    '| 数据分析 | CSV 导入、统计、图表、洞察报告 |',
    '| 论文整理 | 文献库、标签、引用导出、综述大纲 |',
    '| 科学研究 | 项目管理、实验记录、设计与解读 |',
    '| 邮箱 | 收件同步、摘要、回复起草、发送 |', '',
    `你的问题「${clip(message, 60)}」我暂时没有匹配到具体任务。可以试着说：**帮我写本周周报**、**分析销售数据**、**整理 LLM 文献综述**、**设计 A/B 实验**或**回复最新邮件**。`,
  ].join('\n');
}

export function offlineGenerate(kind: TaskKind, input: AiInput): string {
  switch (kind) {
    case 'document.outline': return documentOutline(input);
    case 'document.draft': return documentDraft(input);
    case 'document.polish': return documentPolish(input);
    case 'document.continue': return documentContinue(input);
    case 'document.summarize': return mailSummary({ subject: text(input, 'title'), body: text(input, 'content'), from: '文档' });
    case 'analytics.insights': return analyticsInsights(input);
    case 'analytics.report': return analyticsInsights(input).replace('## ', '## 分析报告 · ');
    case 'paper.summary': return paperSynthesis(input, 'summary');
    case 'paper.review': return paperSynthesis(input, 'review');
    case 'paper.synthesize': return paperSynthesis(input, 'synthesize');
    case 'research.design': return researchDesign(input);
    case 'research.interpret': return researchInterpret(input);
    case 'research.plan': return researchDesign(input).replace('## 实验设计 ·', '## 研究计划 ·');
    case 'mail.reply': return mailReply(input);
    case 'mail.summary': return mailSummary(input);
    case 'mail.compose': return mailCompose(input);
    case 'agent.chat': return agentChat(input);
    default: return '## 暂无法处理该任务\n\n请检查任务类型后重试。';
  }
}
