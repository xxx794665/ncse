/**
 * 知识点树（M3/T3-01a，ADR-0013）：行测六模块的两级知识点体系（考点→知识点），
 * 与 D1 knowledge_points 表同构（module+code 为幂等种子入库依据）。
 * 单一权威常量：importer 种子 SQL（T3-01a）与打标映射键（T3-01b/c）均以此为准。
 * 树为自产知识资产入 Git（不属 ADR-0004 题库爬取数据）；code 定稿后不再改义。
 *
 * 状态：草稿待用户校对（2026-10-25 生成，域建模子代理基于 27,362 真题抽样与
 * 关键词频次核实；校对稿 .import-out/knowledge-tree-draft.md 不入库）。
 * 校对只改 name/增删节点，code 保持稳定；定稿后远端执行种子入库。
 * 本文件另承载树目录校验（validateKnowledgeTree，种子生成 fail-fast 前置）与
 * 树查询 DTO（GET /api/knowledge/tree 响应，前端 T3-01b 直接复用）。
 */
import type { XingceModuleCode } from './blueprint.js'

/** 知识点（叶子级，对应 knowledge_points 中 parent 非空的行） */
export interface KnowledgePointSeed {
  /** 稳定编码（`<考点code>.<slug>`，模块内全树唯一，幂等入库与打标映射的锚点） */
  code: string
  /** 知识点名称（人类可读，校对可改） */
  name: string
}

/** 考点（根级，对应 knowledge_points 中 parent 为空的行） */
export interface KnowledgeTopicSeed {
  /** 稳定编码（小写 kebab-case，模块内全树唯一） */
  code: string
  /** 考点名称（人类可读，校对可改） */
  name: string
  /** 考点下的知识点（2–8 个） */
  points: KnowledgePointSeed[]
}

/** 单模块知识点树（模块实体由 D1 modules 承载，此处只挂 code） */
export interface ModuleKnowledgeTree {
  /** 模块稳定 code（XingceModuleCode，六模块之一） */
  module: XingceModuleCode
  /** 模块内考点（5–12 个） */
  topics: KnowledgeTopicSeed[]
}

/** 行测知识点树目录（两级深度由 validateKnowledgeTree 校验，见 ADR-0013） */
export const XINGCE_KNOWLEDGE_TREE: readonly ModuleKnowledgeTree[] = [
  {
    module: 'political_theory',
    topics: [
      {
        code: 'marxist-fundamentals',
        name: '马克思主义基本原理',
        points: [
          { code: 'marxist-fundamentals.marxist-philosophy', name: '马克思主义哲学（唯物论、辩证法、认识论、历史观）' },
          { code: 'marxist-fundamentals.political-economy', name: '政治经济学与科学社会主义' },
        ],
      },
      {
        code: 'mao-and-socialism-theory',
        name: '毛泽东思想与中国特色社会主义理论体系',
        points: [
          { code: 'mao-and-socialism-theory.mao-zedong-thought', name: '毛泽东思想' },
          { code: 'mao-and-socialism-theory.deng-and-critical-theory', name: '邓小平理论、“三个代表”与科学发展观' },
        ],
      },
      {
        code: 'new-era-thought',
        name: '习近平新时代中国特色社会主义思想',
        points: [
          { code: 'new-era-thought.theory-essentials', name: '思想体系与“两个确立”等核心论述' },
          { code: 'new-era-thought.new-development-concept', name: '新发展理念、新发展格局与高质量发展' },
          { code: 'new-era-thought.chinese-modernization', name: '中国式现代化与战略部署' },
        ],
      },
      {
        code: 'party-history-and-building',
        name: '党史与党的建设',
        points: [
          { code: 'party-history-and-building.party-history', name: '党史重大事件与统一战线' },
          { code: 'party-history-and-building.self-revolution', name: '全面从严治党与自我革命' },
        ],
      },
      {
        code: 'current-affairs',
        name: '时事政治',
        points: [
          { code: 'current-affairs.major-meetings', name: '中央重要会议与政策文件' },
          { code: 'current-affairs.speeches-and-diplomacy', name: '重要讲话、新年贺词与国际时政' },
        ],
      },
    ],
  },
  {
    module: 'common_sense',
    topics: [
      {
        code: 'political-commonsense',
        name: '政治常识',
        points: [
          { code: 'political-commonsense.state-institutions', name: '政治制度、国家机构与统一战线' },
          { code: 'political-commonsense.party-policies', name: '方针政策与时政常识' },
        ],
      },
      {
        code: 'law-commonsense',
        name: '法律常识',
        points: [
          { code: 'law-commonsense.constitution', name: '宪法原则与公民权利' },
          { code: 'law-commonsense.civil-law', name: '民法与婚姻家庭' },
          { code: 'law-commonsense.criminal-procedure', name: '刑法与诉讼法' },
          { code: 'law-commonsense.administrative-law', name: '行政法与公务员管理' },
          { code: 'law-commonsense.new-special-laws', name: '新法与专门法（消费者、环保、乡村振兴等）' },
        ],
      },
      {
        code: 'economics-commonsense',
        name: '经济常识',
        points: [
          { code: 'economics-commonsense.basic-concepts', name: '经济学基本概念' },
          { code: 'economics-commonsense.macro-finance', name: '宏观经济与财政金融' },
        ],
      },
      {
        code: 'science-tech',
        name: '科技常识',
        points: [
          { code: 'science-tech.physics-chemistry', name: '物理与化学' },
          { code: 'science-tech.biology-medicine', name: '生物与医学' },
          { code: 'science-tech.info-frontier', name: '信息技术与前沿科技' },
          { code: 'science-tech.achievements', name: '重要科技成就与工程' },
        ],
      },
      {
        code: 'humanities',
        name: '人文历史常识',
        points: [
          { code: 'humanities.history', name: '中外历史与典故' },
          { code: 'humanities.literature', name: '文学常识与诗词' },
          { code: 'humanities.culture-art', name: '传统文化与书画艺术' },
        ],
      },
      {
        code: 'geography-environment',
        name: '地理与环境常识',
        points: [
          { code: 'geography-environment.physical-geography', name: '自然地理' },
          { code: 'geography-environment.china-geography', name: '中国地理与国情' },
          { code: 'geography-environment.environment-resources', name: '环境与资源' },
        ],
      },
      {
        code: 'management',
        name: '公共管理与公文',
        points: [
          { code: 'management.public-admin', name: '行政管理与决策' },
          { code: 'management.official-documents', name: '公文写作与处理' },
        ],
      },
    ],
  },
  {
    module: 'verbal',
    topics: [
      {
        code: 'logical-fill',
        name: '逻辑填空',
        points: [
          { code: 'logical-fill.word-choice', name: '实词辨析' },
          { code: 'logical-fill.idiom-choice', name: '成语辨析' },
          { code: 'logical-fill.function-words', name: '虚词与关联词' },
          { code: 'logical-fill.word-substitution', name: '词语替换与运用' },
        ],
      },
      {
        code: 'gist-reading',
        name: '主旨意图与标题（片段阅读）',
        points: [
          { code: 'gist-reading.main-idea', name: '主旨概括' },
          { code: 'gist-reading.intent-judgment', name: '意图判断' },
          { code: 'gist-reading.title-selection', name: '标题选择' },
        ],
      },
      {
        code: 'detail-reading',
        name: '细节与词句理解（片段阅读）',
        points: [
          { code: 'detail-reading.detail-judgment', name: '细节理解与判断' },
          { code: 'detail-reading.word-sentence-comprehension', name: '词句理解与代词指代' },
        ],
      },
      {
        code: 'sentence-expression',
        name: '语句表达',
        points: [
          { code: 'sentence-expression.sentence-ordering', name: '语句排序' },
          { code: 'sentence-expression.sentence-blank', name: '语句填空' },
          { code: 'sentence-expression.continuation', name: '下文推断（接语选择）' },
          { code: 'sentence-expression.error-detection', name: '病句辨析' },
        ],
      },
      {
        code: 'article-reading',
        name: '篇章阅读',
        points: [
          { code: 'article-reading.detail-information', name: '文章细节与信息查找' },
          { code: 'article-reading.gist-inference', name: '文章主旨与推断' },
        ],
      },
    ],
  },
  {
    module: 'quantitative',
    topics: [
      {
        code: 'travel-problems',
        name: '行程问题',
        points: [
          { code: 'travel-problems.basic-travel', name: '基础行程与比例法' },
          { code: 'travel-problems.meeting-chasing', name: '相遇追及与流水行船' },
        ],
      },
      {
        code: 'work-problems',
        name: '工程问题',
        points: [
          { code: 'work-problems.cooperation', name: '多者合作与赋值效率' },
          { code: 'work-problems.efficiency-change', name: '效率变化与轮流做工' },
        ],
      },
      {
        code: 'profit-problems',
        name: '经济利润问题',
        points: [
          { code: 'profit-problems.cost-pricing', name: '成本、定价与折扣' },
          { code: 'profit-problems.profit-analysis', name: '利润率与收益理财' },
        ],
      },
      {
        code: 'counting-problems',
        name: '排列组合与概率',
        points: [
          { code: 'counting-problems.permutation-combination', name: '排列组合' },
          { code: 'counting-problems.probability', name: '概率问题' },
          { code: 'counting-problems.inclusion-exclusion', name: '容斥原理' },
        ],
      },
      {
        code: 'geometry-problems',
        name: '几何问题',
        points: [
          { code: 'geometry-problems.plane-geometry', name: '平面几何' },
          { code: 'geometry-problems.solid-geometry', name: '立体几何' },
        ],
      },
      {
        code: 'number-properties',
        name: '基础数论与方程',
        points: [
          { code: 'number-properties.divisibility', name: '整除、余数与约数倍数' },
          { code: 'number-properties.digits-equations', name: '尾数幂次与不定方程' },
        ],
      },
      {
        code: 'classic-applications',
        name: '典型应用题',
        points: [
          { code: 'classic-applications.concentration', name: '浓度与溶液混合' },
          { code: 'classic-applications.age-cycle', name: '年龄与周期问题' },
          { code: 'classic-applications.sequence-sum', name: '等差数列与平均数计算' },
          { code: 'classic-applications.extremum', name: '最值与统筹优化' },
        ],
      },
      {
        code: 'number-sequences',
        name: '数字推理',
        points: [
          { code: 'number-sequences.multistep', name: '多级数列（作差、作和、作商）' },
          { code: 'number-sequences.multiple-recursive', name: '多重、交叉与递推数列' },
        ],
      },
    ],
  },
  {
    module: 'judgement',
    topics: [
      {
        code: 'figure-reasoning',
        name: '图形推理',
        points: [
          { code: 'figure-reasoning.position-patterns', name: '位置规律（平移、旋转、翻转）' },
          { code: 'figure-reasoning.style-patterns', name: '样式规律（加减同异、黑白运算）' },
          { code: 'figure-reasoning.attribute-patterns', name: '属性规律（对称、曲直、开闭）' },
          { code: 'figure-reasoning.quantity-patterns', name: '数量规律（点、线、角、面、素）' },
          { code: 'figure-reasoning.function-elements', name: '功能元素与标记信息' },
          { code: 'figure-reasoning.spatial-patterns', name: '空间规律（折叠、截面、三视图）' },
        ],
      },
      {
        code: 'definition-judgement',
        name: '定义判断',
        points: [
          { code: 'definition-judgement.social-legal-definitions', name: '社会与法律类定义' },
          { code: 'definition-judgement.management-economic-definitions', name: '管理与经济类定义' },
          { code: 'definition-judgement.psychology-education-definitions', name: '心理与教育类定义' },
          { code: 'definition-judgement.science-tech-definitions', name: '科技与其他领域定义' },
        ],
      },
      {
        code: 'analogy-reasoning',
        name: '类比推理',
        points: [
          { code: 'analogy-reasoning.semantic-relations', name: '语义关系（近义、反义、象征）' },
          { code: 'analogy-reasoning.concept-relations', name: '概念关系（全同、并列、交叉、包含）' },
          { code: 'analogy-reasoning.correspondence-relations', name: '对应关系（功能、因果、场所等）' },
          { code: 'analogy-reasoning.grammar-relations', name: '语法关系与造句' },
        ],
      },
      {
        code: 'argumentation',
        name: '可能性推理（论证与解释）',
        points: [
          { code: 'argumentation.weakening', name: '削弱论证' },
          { code: 'argumentation.strengthening', name: '加强论证' },
          { code: 'argumentation.premise-assumption', name: '前提假设' },
          { code: 'argumentation.explanation-induction', name: '解释与归纳评价' },
        ],
      },
      {
        code: 'deductive-reasoning',
        name: '必然性推理（翻译与分析推理）',
        points: [
          { code: 'deductive-reasoning.translation-reasoning', name: '翻译推理（复合命题与规则推理）' },
          { code: 'deductive-reasoning.analytical-reasoning', name: '分析推理（排列与信息匹配）' },
        ],
      },
    ],
  },
  {
    module: 'data_analysis',
    topics: [
      {
        code: 'growth',
        name: '增长问题',
        points: [
          { code: 'growth.growth-rate', name: '增长率计算与比较' },
          { code: 'growth.growth-amount', name: '增长量计算与比较' },
          { code: 'growth.base-period', name: '基期量计算' },
          { code: 'growth.interval-growth', name: '间隔增长与间隔基期' },
        ],
      },
      {
        code: 'proportion',
        name: '比重问题',
        points: [
          { code: 'proportion.current-proportion', name: '现期比重（含混合比重）' },
          { code: 'proportion.base-period-proportion', name: '基期比重' },
          { code: 'proportion.two-period-proportion', name: '两期比重比较与计算' },
        ],
      },
      {
        code: 'average',
        name: '平均数问题',
        points: [
          { code: 'average.current-average', name: '现期平均数' },
          { code: 'average.base-period-average', name: '基期平均数与平均数增长率' },
        ],
      },
      {
        code: 'multiples',
        name: '倍数与比值',
        points: [
          { code: 'multiples.current-multiples', name: '现期倍数' },
          { code: 'multiples.base-period-ratio', name: '基期倍数与比值换算' },
        ],
      },
      {
        code: 'simple-calculation',
        name: '简单计算与比较',
        points: [
          { code: 'simple-calculation.direct-comparison', name: '直接计算与大小比较' },
          { code: 'simple-calculation.data-lookup', name: '简单查找与加减计算' },
        ],
      },
      {
        code: 'comprehensive-analysis',
        name: '综合分析',
        points: [
          { code: 'comprehensive-analysis.truth-verification', name: '正误判断综合分析' },
          { code: 'comprehensive-analysis.chart-reading', name: '图形判读与趋势分析' },
        ],
      },
    ],
  },
]

/** 行测六模块 code 全集（与 blueprint.ts 的 XingceModuleCode 联合类型对齐——两端勿单方扩值；validateKnowledgeTree 的完整性基准） */
const XINGCE_MODULE_CODES: readonly XingceModuleCode[] = [
  'political_theory',
  'common_sense',
  'verbal',
  'quantitative',
  'judgement',
  'data_analysis',
]

/** 编码段格式：小写字母/数字段，多段以连字符相连（考点 code 与知识点 code 的 slug 段共用） */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 知识点树目录校验（M3/T3-01a），返回问题清单（空数组 = 合格）。
 * 校验项：六模块各一条（无缺失无重复，序不限）；考点/知识点 code 格式（小写
 * kebab-case，知识点须以「<所属考点code>.」为前缀）；name 非空白；模块内 code
 * 跨层级唯一（考点与知识点同一命名空间）；每考点至少 1 个知识点（两级深度由
 * 结构承载，不校验具体数量上下界）。消息为确定性中文文本（含模块/节点 code，
 * 种子导入 fail-fast 时便于定位）。importer 生成种子 SQL 前逐树调用。
 */
export function validateKnowledgeTree(tree: readonly ModuleKnowledgeTree[]): string[] {
  const problems: string[] = []
  // 六模块各一条：重复与缺失分别点名（序不限，不校验顺序）
  const seenModules = new Set<XingceModuleCode>()
  for (const entry of tree) {
    if (seenModules.has(entry.module)) {
      problems.push(`模块重复：${entry.module}`)
    }
    seenModules.add(entry.module)
  }
  for (const module of XINGCE_MODULE_CODES) {
    if (!seenModules.has(module)) {
      problems.push(`模块缺失：${module}`)
    }
  }
  // 逐模块：考点/知识点编码与名称、跨层级唯一、每考点至少 1 个知识点
  for (const entry of tree) {
    const seenCodes = new Set<string>()
    for (const topic of entry.topics) {
      if (!SLUG_PATTERN.test(topic.code)) {
        problems.push(`${entry.module} 考点 code 格式非法（应为小写 kebab-case）：${topic.code}`)
      }
      if (topic.name.trim().length === 0) {
        problems.push(`${entry.module} 考点 name 不能为空：${topic.code}`)
      }
      if (seenCodes.has(topic.code)) {
        problems.push(`${entry.module} code 重复（考点与知识点同一命名空间）：${topic.code}`)
      }
      seenCodes.add(topic.code)
      if (topic.points.length === 0) {
        problems.push(`${entry.module} 考点至少需要 1 个知识点：${topic.code}`)
      }
      for (const point of topic.points) {
        if (!point.code.startsWith(`${topic.code}.`)) {
          problems.push(`${entry.module} 知识点 code 须以「${topic.code}.」为前缀：${point.code}`)
        } else if (!SLUG_PATTERN.test(point.code.slice(topic.code.length + 1))) {
          problems.push(
            `${entry.module} 知识点 code 格式非法（应为「${topic.code}.<slug>」）：${point.code}`,
          )
        }
        if (point.name.trim().length === 0) {
          problems.push(`${entry.module} 知识点 name 不能为空：${point.code}`)
        }
        if (seenCodes.has(point.code)) {
          problems.push(`${entry.module} code 重复（考点与知识点同一命名空间）：${point.code}`)
        }
        seenCodes.add(point.code)
      }
    }
  }
  return problems
}

/* ============ 树查询 DTO（T3-01a 定稿，GET /api/knowledge/tree 响应，前端 T3-01f 直接复用） ============ */

/**
 * 知识点节点（叶子级，树响应 points 数组条目）。
 * id 为 knowledge_points.id——前端掌握度面板（T3-01d）后续作 mastery_stats 的
 * target_id 引用锚点（知识点颗粒），勿以 code 代替（code 仅导入幂等键）。
 */
export interface KnowledgeTreeNode {
  /** knowledge_points.id（掌握度统计的 target_id 锚点） */
  id: number
  /** 稳定编码（模块内唯一） */
  code: string
  /** 知识点名称 */
  name: string
}

/** 考点节点（根级，树响应 topics 数组条目；id 同为 knowledge_points.id，parent 为空行） */
export interface KnowledgeTopicNode {
  /** knowledge_points.id（parent 为空的考点行） */
  id: number
  /** 稳定编码（模块内唯一，小写 kebab-case） */
  code: string
  /** 考点名称 */
  name: string
  /** 考点下的知识点（序 = 种子 sort_order，并列以 id 稳定） */
  points: KnowledgeTreeNode[]
}

/** 模块节点（树响应顶层条目；模块序 = modules.sort_order） */
export interface KnowledgeModuleNode {
  /** 行测模块稳定 code */
  module: XingceModuleCode
  /** 模块展示名（modules.name） */
  moduleName: string
  /** 模块内考点（序 = 种子 sort_order，并列以 id 稳定；空表/未种子模块不出现） */
  topics: KnowledgeTopicNode[]
}

/**
 * GET /api/knowledge/tree 响应体（直接返回不包壳）。
 * 树为全局内容（无用户数据维度）；打标前树先入库、掌握度空态可用——空表返回空数组。
 */
export type KnowledgeTreeResponse = KnowledgeModuleNode[]
