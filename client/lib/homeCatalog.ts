import type { IconName } from './ui.tsx';

/** 首页一张任务卡：点一下只把 `prompt` 填进输入框，不直接发送。 */
export interface PromptCard {
  icon: IconName;
  title: string;
  description: string;
  prompt: string;
}

/** 一个分类带 3 套卡片，「换一换」在这 3 套之间循环，点位指示点到第几套。 */
export interface HomeCategory {
  id: string;
  label: string;
  icon: IconName;
  sets: PromptCard[][];
}

/**
 * 首页六个分类的提示词库。文案是产品内容而不是逻辑：改文案直接改这里，
 * 三套之间要真的不同（同一分类里不重复同一件事），否则「换一换」等于没换。
 */
export const HOME_CATEGORIES: HomeCategory[] = [
  {
    id: 'office',
    label: '日常办公',
    icon: 'dashboard',
    sets: [
      [
        { icon: 'calendar', title: '安排今天的工作', description: '把待办、会议与截止时间排成一天的顺序', prompt: '帮我安排今天的工作顺序：列出待办、会议和截止时间，指出先做哪三件' },
        { icon: 'mail', title: '回复堆积的邮件', description: '按紧急程度分档，给出每封的回复要点', prompt: '帮我回复堆积的邮件：先按紧急程度分档，再给我每封的回复要点' },
        { icon: 'check', title: '整理会议纪要', description: '结论、待办、负责人与时间点一次列清', prompt: '把这份会议记录整理成纪要：结论、待办、负责人和时间点，一条不漏' },
        { icon: 'file', title: '写一份周报', description: '本周进展、下周计划与风险，一次成稿', prompt: '帮我写本周工作周报，包含本周进展、下周计划和需要协调的风险' },
      ],
      [
        { icon: 'clock', title: '排一份项目排期', description: '按依赖关系排出阶段与关键节点', prompt: '帮我排一份项目排期：按依赖关系排出阶段、关键节点和缓冲时间' },
        { icon: 'edit', title: '起草一则通知', description: '时间、地点、对象与要求说得明白', prompt: '帮我起草一则内部通知，把时间、地点、参与对象和注意事项写清楚' },
        { icon: 'inbox', title: '理清待办优先级', description: '用影响与紧迫度排出处理顺序', prompt: '帮我把手上的待办按影响和紧迫度排序，说明为什么这样排' },
        { icon: 'chart', title: '写一份月总结', description: '量化产出、问题与下月重点', prompt: '帮我写本月工作总结，用数字说明产出，并列出问题和下月重点' },
      ],
      [
        { icon: 'layers', title: '汇总跨部门进展', description: '按部门归拢进度、卡点与依赖', prompt: '帮我把各部门的进展汇总成一份材料，标出各自的卡点和互相依赖' },
        { icon: 'save', title: '起草审批说明', description: '背景、必要性、影响与结论四段式', prompt: '帮我起草一份审批说明，按背景、必要性、影响和结论四段来写' },
        { icon: 'mic', title: '整理录音要点', description: '把口语记录压成可执行的结论', prompt: '把这段会议录音内容整理成要点，只留结论和明确的待办' },
        { icon: 'tag', title: '做一份汇报提纲', description: '结论先行，每页只讲一件事', prompt: '帮我做一份汇报提纲，结论先行，每页只讲一件事' },
      ],
    ],
  },
  {
    id: 'writing',
    label: '文档写作',
    icon: 'edit',
    sets: [
      [
        { icon: 'file', title: '写一份项目方案', description: '目标、范围、里程碑与风险一次写成', prompt: '帮我起草一份项目方案，包含目标、范围、里程碑、资源与风险' },
        { icon: 'layers', title: '写产品需求文档', description: '场景、流程、验收标准与边界', prompt: '帮我写一份产品需求文档，包含使用场景、主流程、验收标准和明确不做的部分' },
        { icon: 'mail', title: '起草正式邮件', description: '对象、诉求、时间与下一步', prompt: '帮我起草一封正式邮件，说清对象、诉求、时间要求和下一步' },
        { icon: 'wand', title: '润色这段文字', description: '去掉套话，句子压短，保留原意', prompt: '帮我润色这段文字：去掉套话、把句子压短，原意和事实不要改' },
      ],
      [
        { icon: 'shield', title: '提炼合同要点', description: '权利义务、期限与违约条款', prompt: '帮我提炼这份合同的要点：双方权利义务、期限、付款和违约条款' },
        { icon: 'check', title: '写一份操作流程', description: '分步骤、写出前置条件与检查点', prompt: '帮我写一份操作流程 SOP，分步骤写，标出前置条件和每步的检查点' },
        { icon: 'info', title: '写致歉或说明信', description: '先承认事实，再给补救与时间', prompt: '帮我写一封说明信：先承认事实，再给补救方案和明确的时间' },
        { icon: 'edit', title: '把长文压成三段', description: '留结论、依据与下一步', prompt: '把这段长文压缩成三段：结论、依据、下一步' },
      ],
      [
        { icon: 'clock', title: '写复盘结论文档', description: '事实、原因、改进与责任人', prompt: '帮我写一份复盘文档，按事实、原因、改进措施和责任人四块来写' },
        { icon: 'book', title: '写培训手册章节', description: '概念、步骤、常见错误与练习', prompt: '帮我写一章培训手册，包含概念说明、操作步骤、常见错误和练习' },
        { icon: 'external', title: '写对外介绍文案', description: '一句话说清价值与适用对象', prompt: '帮我写一段对外介绍文案，第一句话就要说清价值和适用对象' },
        { icon: 'arrow', title: '把要点扩成文章', description: '补例子与过渡，不注水', prompt: '把这些要点扩写成一篇完整文章，补例子和过渡，不要注水' },
      ],
    ],
  },
  {
    id: 'analytics',
    label: '数据分析',
    icon: 'chart',
    sets: [
      [
        { icon: 'chart', title: '分析这份销售表', description: '字段口径、趋势与异常点', prompt: '帮我分析这份销售数据：先说字段口径，再看趋势和异常点' },
        { icon: 'search', title: '找出门店差异', description: '分组对比，指出最大与最稳的店', prompt: '按区域对比门店数据，指出差异最大和最稳定的门店，并说明原因' },
        { icon: 'layers', title: '把数据做成图表', description: '选最适合讲这条结论的图形', prompt: '帮我把这组数据做成图表，选出最适合表达这条结论的图形' },
        { icon: 'file', title: '写分析报告', description: '结论先行，引用真实数字', prompt: '根据这份统计结果写分析报告：结论先行，只引用真实数字' },
      ],
      [
        { icon: 'clock', title: '算环比与同比', description: '给出计算口径与变化归因', prompt: '帮我算这份数据的环比和同比，写出计算口径并解释变化来源' },
        { icon: 'search', title: '找出离群值', description: '标出异常行并判断是否可信', prompt: '帮我找出数据里的离群值和异常行，判断是录入错误还是真实波动' },
        { icon: 'arrow', title: '预测下季度趋势', description: '说明假设，不编造精度', prompt: '根据历史数据预测下季度趋势，写清假设，不要编造精度' },
        { icon: 'dashboard', title: '做一张指标看板', description: '选 5 个能反映经营的指标', prompt: '帮我设计一张经营指标看板，选出 5 个最能反映问题的指标' },
      ],
      [
        { icon: 'upload', title: '清洗并说明口径', description: '缺失、重复与单位统一', prompt: '帮我把这份数据清洗一遍，说明缺失值、重复行的处理方式和单位口径' },
        { icon: 'check', title: '对比两个方案', description: '按同一组指标横向比', prompt: '用同一组指标横向对比这两个方案的效果，给出结论和不确定的地方' },
        { icon: 'layers', title: '拆解收入结构', description: '按产品、区域与客户分层', prompt: '帮我拆解收入结构，按产品线、区域和客户类型分层看贡献' },
        { icon: 'file', title: '写结论与建议', description: '数据支撑、动作明确', prompt: '根据这些数据写结论和建议，每条都要有数据支撑和明确动作' },
      ],
    ],
  },
  {
    id: 'research',
    label: '科学研究',
    icon: 'flask',
    sets: [
      [
        { icon: 'flask', title: '设计一个实验方案', description: '假设、变量、指标与风险', prompt: '帮我设计一个实验方案：假设、自变量、因变量、评价指标和风险' },
        { icon: 'book', title: '整理文献综述', description: '按主题聚类，输出脉络', prompt: '帮我整理这份文献综述：按主题聚类，输出研究脉络和结论分歧' },
        { icon: 'edit', title: '写研究假设与方法', description: '可验证、可复现', prompt: '帮我写研究假设与方法部分，要求假设可验证、方法可复现' },
        { icon: 'calendar', title: '生成研究计划', description: '阶段、里程碑与验收标准', prompt: '把研究目标拆成阶段任务和里程碑，每个阶段给出验收标准' },
      ],
      [
        { icon: 'chart', title: '解读实验结果', description: '先看效应量，再看显著性', prompt: '帮我解读这组实验结果，先看效应量，再看显著性和可能的混杂因素' },
        { icon: 'tag', title: '整理参考文献', description: '统一格式，标出缺项', prompt: '把这些参考文献统一成同一种引用格式，标出缺项的条目' },
        { icon: 'search', title: '找研究空白点', description: '从已有结论的矛盾处入手', prompt: '从这些文献的结论矛盾处入手，帮我找出还可以做的研究空白点' },
        { icon: 'file', title: '写论文摘要', description: '背景、方法、结果与结论', prompt: '帮我写论文摘要，按背景、方法、结果、结论四段写' },
      ],
      [
        { icon: 'layers', title: '设计对照组与变量', description: '控制混淆因素', prompt: '帮我设计对照组的设置与变量控制方案，指出可能被混淆的因素' },
        { icon: 'save', title: '做实验记录模板', description: '一次填完，事后可复现', prompt: '帮我做一份实验记录模板，字段要保证事后能完整复现' },
        { icon: 'shield', title: '评估研究风险', description: '伦理、数据与可行性', prompt: '帮我评估这个研究方案的伦理、数据和可行性风险，并给出规避办法' },
        { icon: 'check', title: '把结论写成要点', description: '每条都能指回证据', prompt: '把这段研究结论写成要点，每条都能指回具体证据' },
      ],
    ],
  },
  {
    id: 'life',
    label: '衣食出行',
    icon: 'tag',
    sets: [
      [
        { icon: 'calendar', title: '规划三日行程', description: '路线、时段与备选方案', prompt: '帮我规划一个三天的出行行程，包含路线、时段安排和下雨天的备选方案' },
        { icon: 'inbox', title: '列一周家常菜谱', description: '按季节、耗时与采购量配', prompt: '帮我列一周家常菜谱，按季节、做饭耗时和采购量来配，别重复菜品' },
        { icon: 'tag', title: '配一套通勤穿搭', description: '按预算与场合挑单品', prompt: '按我的预算和上班场合，配几套通勤穿搭，说明每套适合什么天气' },
        { icon: 'arrow', title: '比较三种交通方案', description: '时间、费用与舒适度', prompt: '帮我比较三种去目的地的交通方案，从时间、费用和舒适度三个角度给出建议' },
      ],
      [
        { icon: 'user', title: '安排一次家庭聚餐', description: '人数、菜单、预算与分工', prompt: '帮我安排一次家庭聚餐：按人数定菜单、算预算、列采购清单和分工' },
        { icon: 'layers', title: '整理换季衣橱', description: '留、收、补三栏清单', prompt: '帮我整理换季衣橱，分成要留的、要收起来的和需要补的清单' },
        { icon: 'calendar', title: '规划周末短途', description: '两小时车程内，含备选', prompt: '帮我规划一次周末短途，目的地控制在两小时车程内，给两个备选' },
        { icon: 'check', title: '列搬家准备清单', description: '按时间倒排，别漏断水电气', prompt: '帮我列一份搬家准备清单，按时间倒排，包含断水电气和地址变更' },
      ],
      [
        { icon: 'chart', title: '做月度开销计划', description: '按固定与弹性支出分层', prompt: '帮我做一份月度开销计划，把固定支出和弹性支出分开，给出可压缩项' },
        { icon: 'tag', title: '挑一份合适的礼物', description: '按关系、预算与场合选', prompt: '帮我挑一份合适的礼物，说明关系、预算和场合，给出三个候选' },
        { icon: 'arrow', title: '规划一次长途旅行', description: '签证、季节、预算与节奏', prompt: '帮我规划一次长途旅行，考虑签证、最佳季节、预算和每天节奏' },
        { icon: 'user', title: '安排假期活动', description: '按年龄与体力分天排', prompt: '帮我安排孩子假期的活动，按年龄和体力分天排，留出休息时间' },
      ],
    ],
  },
  {
    id: 'culture',
    label: '人文娱乐',
    icon: 'book',
    sets: [
      [
        { icon: 'book', title: '推荐五本入门书', description: '由浅入深，说清为什么读', prompt: '推荐五本这个主题的入门书，按由浅入深排，每本说清为什么现在读它' },
        { icon: 'eye', title: '写一份观影清单', description: '按心情与时长分组', prompt: '帮我写一份观影清单，按心情和片长分组，每部一句话说明看点' },
        { icon: 'calendar', title: '规划一次展览之行', description: '路线、时段与看点', prompt: '帮我规划一次看展行程：路线、参观时段、重点展品和一个周边去处' },
        { icon: 'info', title: '讲清一个历史事件', description: '起因、经过、影响与误传', prompt: '帮我讲清这个历史事件：起因、经过、影响，以及常见误传' },
      ],
      [
        { icon: 'headphones', title: '整理播客清单', description: '按通勤、做饭、睡前分', prompt: '帮我整理一份播客清单，按通勤、做饭和睡前三个场景分' },
        { icon: 'mic', title: '推荐通勤音乐', description: '按时长与节奏挑', prompt: '帮我推荐适合通勤的音乐，按单程时长和想要的节奏来挑' },
        { icon: 'edit', title: '写一段活动串词', description: '开场、过渡与收尾', prompt: '帮我写一段活动串词，包含开场、节目过渡和收尾' },
        { icon: 'user', title: '规划一次读书会', description: '主题、分工、讨论问题', prompt: '帮我规划一次读书会：主题、阅读范围、分工和五个讨论问题' },
      ],
      [
        { icon: 'book', title: '解读一首诗的意象', description: '逐句说意象与情绪', prompt: '帮我解读这首诗，逐句说清意象、转折和情绪落点' },
        { icon: 'wand', title: '设计亲子手工', description: '材料简单，步骤可跟做', prompt: '帮我设计一个亲子手工活动，材料家里就有，步骤要能照着做' },
        { icon: 'inbox', title: '写周末宅家清单', description: '休息、娱乐与收拾兼顾', prompt: '帮我写一份周末宅家清单，兼顾休息、娱乐和顺手收拾' },
        { icon: 'sparkles', title: '组织桌游局', description: '按人数与时长选游戏', prompt: '帮我组织一次桌游局：按人数和时长挑游戏，排出轮次和规则讲解顺序' },
      ],
    ],
  },
];
