export type TaskKind =
  | 'document.outline' | 'document.draft' | 'document.polish' | 'document.continue' | 'document.summarize'
  | 'analytics.insights' | 'analytics.report'
  | 'paper.summary' | 'paper.review' | 'paper.synthesize'
  | 'research.design' | 'research.interpret' | 'research.plan'
  | 'mail.reply' | 'mail.summary' | 'mail.compose'
  | 'agent.chat';

export type AiInput = Record<string, unknown>;

export const TASK_LABELS: Record<TaskKind, string> = {
  'document.outline': '生成文档大纲',
  'document.draft': '起草文档',
  'document.polish': '润色文档',
  'document.continue': '续写文档',
  'document.summarize': '文档摘要',
  'analytics.insights': '数据洞察',
  'analytics.report': '分析报告',
  'paper.summary': '文献摘要',
  'paper.review': '综述大纲',
  'paper.synthesize': '文献综述',
  'research.design': '实验设计',
  'research.interpret': '结果解读',
  'research.plan': '研究计划',
  'mail.reply': '起草回复',
  'mail.summary': '邮件摘要',
  'mail.compose': '撰写邮件',
  'agent.chat': '智能体对话',
};

const BASE_PROMPT = `你是 Mirelth Desk 办公智能体的写作与分析助手。要求：
1. 一律使用简体中文，输出结构化 Markdown（标题、列表、必要时表格）。
2. 严格基于用户提供的事实与数据，不编造数字、文献、实验结果或引用。
3. 内容务实、可直接用于办公场景；避免空泛套话，给出明确动作项。
4. 若信息不足，用「待补充」标注，而不是臆测。`;

const TASK_PROMPTS: Record<TaskKind, string> = {
  'document.outline': '任务：为文档生成清晰的层级大纲。按「背景 / 目标 / 主体章节 / 数据与证据 / 结论与行动项」组织，每个章节附 1 句写作提示。',
  'document.draft': '任务：起草完整文档正文。包含标题、概述、主体分节、必要的表格与清单、风险或待办、下一步。长度适中，段落完整。',
  'document.polish': '任务：润色用户文档。给出「润色后的完整正文」以及「修改要点」清单；只优化表达、结构与一致性，不改变事实与数据。',
  'document.continue': '任务：承接原文风格继续写 2–3 个段落，保持术语、语气与格式一致。',
  'document.summarize': '任务：提炼文档摘要，输出一句话结论、3–5 个要点、以及可执行的后续事项。',
  'analytics.insights': '任务：基于给定统计结果做数据分析。说明数据规模与质量、关键趋势、分组差异、异常或风险，并给出 3 条可执行的建议。所有数值必须来自提供的统计结果。',
  'analytics.report': '任务：撰写数据分析报告，含「分析目标 / 数据概览 / 主要发现 / 结论与建议 / 局限性」。',
  'paper.summary': '任务：基于给定文献元数据，按主题聚类梳理研究脉络，指出共识、分歧与研究空白，并给出阅读优先级建议。',
  'paper.review': '任务：生成文献综述大纲，包含章节结构、每章要引用的文献、论证逻辑与待补充方向。',
  'paper.synthesize': '任务：撰写一版简短的文献综述初稿，严格引用给定文献的标题与年份，不虚构文献。',
  'research.design': '任务：设计可验证的实验方案，包含研究假设、自变量/因变量/控制变量、方法步骤、样本与分组、评价指标、潜在混杂因素与伦理/风险考量。',
  'research.interpret': '任务：解读实验结果，区分「数据支持的结论」与「推测」，说明局限性并给出复现或后续实验建议。',
  'research.plan': '任务：把研究目标拆成阶段里程碑、关键任务、交付物与验收标准。',
  'mail.reply': '任务：撰写专业、得体的邮件回复。回应对方全部诉求，明确时间/责任人/下一步，语气按指定风格，不虚构承诺。',
  'mail.summary': '任务：总结邮件要点，输出一句话摘要、关键信息与需要执行的动作项。',
  'mail.compose': '任务：根据主题与要点撰写邮件正文，包含称呼、背景、主体、明确请求与落款。',
  'agent.chat': '任务：理解用户的办公需求，判断应落到哪个模块（文档/数据/论文/研究/邮箱），给出简明可执行的答复与建议的后续步骤。若用户要求生成内容，直接给出可用初稿。',
};

export function buildMessages(kind: TaskKind, input: AiInput): Array<{ role: 'system' | 'user'; content: string }> {
  const context = Object.keys(input).length
    ? `\n\n以下是用户提供的数据（JSON）：\n\`\`\`json\n${JSON.stringify(input, null, 2).slice(0, 24_000)}\n\`\`\``
    : '';
  return [
    { role: 'system', content: `${BASE_PROMPT}\n\n${TASK_PROMPTS[kind]}` },
    { role: 'user', content: `任务类型：${TASK_LABELS[kind]}${context}\n\n请开始输出。` },
  ];
}
