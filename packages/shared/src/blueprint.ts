/**
 * 考试蓝图（T1-07）：常见省考卷型的模块构成、题量与时长建模，及每题时限推导。
 * 与 apps/api 的 blueprints / blueprint_modules 表同构（code 为幂等导入依据；
 * 整卷总时长不入库，由模块明细汇总推导——本模块是该推导的唯一权威实现）。
 * 消费方：T1-09 专项刷题每题倒计时（秒）、T2-01 整卷模考总时长（分钟）。
 */

/** 行测六模块稳定 code（与 D1 modules 表 code 及 tools/importer 的 ModuleCode 对齐，两端勿单方扩值） */
export type XingceModuleCode =
  | 'political_theory'
  | 'common_sense'
  | 'verbal'
  | 'quantitative'
  | 'judgement'
  | 'data_analysis'

/** 蓝图模块明细：卷内单个模块的题量与时长（与 blueprint_modules 表列同构） */
export interface BlueprintModulePlan {
  /** 模块稳定 code */
  module: XingceModuleCode
  /** 该模块题量（≥ 1） */
  questionCount: number
  /** 该模块在整卷中的时长上限（分钟，≥ 1；整卷总时长由明细汇总推导） */
  timeLimitMinutes: number
}

/** 考试蓝图：某套卷型的模块构成、题量与总时长（与 blueprints 表行同构） */
export interface ExamBlueprint {
  /** 稳定编码（蓝图配置幂等导入的依据，对应 blueprints.code） */
  code: string
  /** 卷型名称（人类可读） */
  name: string
  /** 整卷总时长（分钟；必须等于 modules 时限汇总——由 deriveTotalMinutes 推导、validateBlueprint 校验） */
  totalMinutes: number
  /** 模块明细（卷内模块不重复，顺序即卷面作答顺序） */
  modules: BlueprintModulePlan[]
}

/**
 * 常见省考卷型目录。数字为参考值：按常见联考卷归纳，真实卷以当次公告为准；
 * 自用可调（调整后须保持 totalMinutes === modules 时限汇总与题量自洽，validateBlueprint 会校验）。
 */
export const XINGCE_BLUEPRINTS: readonly ExamBlueprint[] = [
  {
    code: 'province_joint_std',
    name: '省考联考·标准卷',
    totalMinutes: 120,
    modules: [
      { module: 'political_theory', questionCount: 15, timeLimitMinutes: 10 },
      { module: 'common_sense', questionCount: 15, timeLimitMinutes: 10 },
      { module: 'verbal', questionCount: 30, timeLimitMinutes: 25 },
      { module: 'quantitative', questionCount: 10, timeLimitMinutes: 15 },
      { module: 'judgement', questionCount: 30, timeLimitMinutes: 30 },
      { module: 'data_analysis', questionCount: 20, timeLimitMinutes: 30 },
    ],
  },
  {
    code: 'province_joint_compact',
    name: '省考联考·紧凑卷',
    totalMinutes: 100,
    modules: [
      { module: 'political_theory', questionCount: 10, timeLimitMinutes: 8 },
      { module: 'common_sense', questionCount: 10, timeLimitMinutes: 7 },
      { module: 'verbal', questionCount: 25, timeLimitMinutes: 20 },
      { module: 'quantitative', questionCount: 10, timeLimitMinutes: 15 },
      { module: 'judgement', questionCount: 25, timeLimitMinutes: 25 },
      { module: 'data_analysis', questionCount: 20, timeLimitMinutes: 25 },
    ],
  },
]

/**
 * 默认蓝图编码：省考联考·标准卷。服务端判分（isTimeout，T1-08c）与前端每题倒计时（T1-09）
 * 共用同一默认卷锚点——单一来源防两端各写一份字面量后漂移；蓝图选择器属后续扩展点
 * （会话表加列 / 请求携带），落地前两端固定按默认卷推导。
 */
export const DEFAULT_BLUEPRINT_CODE = 'province_joint_std'

/** 默认蓝图条目；目录缺该 code 属代码级配置错误（同仓演进，fail fast） */
export const DEFAULT_BLUEPRINT: ExamBlueprint = (() => {
  const blueprint = XINGCE_BLUEPRINTS.find((item) => item.code === DEFAULT_BLUEPRINT_CODE)
  if (blueprint === undefined) {
    throw new Error(`shared 蓝图目录缺少 code=${DEFAULT_BLUEPRINT_CODE} 的条目`)
  }
  return blueprint
})()

/** 整卷总时长（分钟）＝ 模块明细时限汇总。blueprints 表不设总时长列，调用方须以本推导为准（T1-07）。 */
export function deriveTotalMinutes(blueprint: ExamBlueprint): number {
  return blueprint.modules.reduce((sum, plan) => sum + plan.timeLimitMinutes, 0)
}

/**
 * 指定模块的每题时限（秒）＝ floor(模块时长 × 60 / 题量)，下限钳 1（防极短模块整除出 0）。
 * 卷型未含该模块返回 undefined，T1-09 消费方自行决定回退策略。
 */
export function deriveQuestionTimeLimit(
  blueprint: ExamBlueprint,
  module: XingceModuleCode,
): number | undefined {
  const plan = blueprint.modules.find((item) => item.module === module)
  return plan === undefined ? undefined : secondsPerQuestion(plan)
}

/**
 * 全模块每题时限映射（秒，值同 deriveQuestionTimeLimit）。
 * 仅含卷内模块；键序 = blueprint.modules 序（对象非数值键按插入序，消费方勿依赖排序时以本序为准）。
 */
export function deriveQuestionTimeLimits(
  blueprint: ExamBlueprint,
): Partial<Record<XingceModuleCode, number>> {
  const limits: Partial<Record<XingceModuleCode, number>> = {}
  for (const plan of blueprint.modules) {
    limits[plan.module] = secondsPerQuestion(plan)
  }
  return limits
}

/**
 * 目录/导入数据质量校验，返回问题清单（空数组 = 合格）。
 * 消息为确定性中文文本（含模块 code，便于导入日志定位问题明细）。
 */
export function validateBlueprint(blueprint: ExamBlueprint): string[] {
  const problems: string[] = []
  if (blueprint.code.trim().length === 0) {
    problems.push('code 不能为空')
  }
  if (blueprint.name.trim().length === 0) {
    problems.push('name 不能为空')
  }
  if (blueprint.modules.length === 0) {
    problems.push('modules 至少需要 1 条明细')
  }
  const seen = new Set<XingceModuleCode>()
  for (const plan of blueprint.modules) {
    if (seen.has(plan.module)) {
      problems.push(`模块重复：${plan.module}`)
    }
    seen.add(plan.module)
    if (plan.questionCount < 1) {
      problems.push(`${plan.module} 的 questionCount 必须 ≥ 1`)
    }
    if (plan.timeLimitMinutes < 1) {
      problems.push(`${plan.module} 的 timeLimitMinutes 必须 ≥ 1`)
    }
  }
  const derivedTotal = deriveTotalMinutes(blueprint)
  if (blueprint.totalMinutes !== derivedTotal) {
    problems.push(`totalMinutes(${blueprint.totalMinutes}) 与模块时限汇总(${derivedTotal})不一致`)
  }
  return problems
}

/** 单模块每题秒数：floor(分钟 × 60 / 题量)，下限钳 1 */
function secondsPerQuestion(plan: BlueprintModulePlan): number {
  return Math.max(1, Math.floor((plan.timeLimitMinutes * 60) / plan.questionCount))
}
