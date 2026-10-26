import type { XingceModuleCode } from './blueprint.js'

/**
 * 掌握度推导与查询 DTO（M3/T3-01d，前后端同锚）：
 * - 常量：需加强阈值（mastery 低于该值的知识点进需加强视野，T3-01e 前端筛选共用）；
 * - 纯函数：deriveMastery 由「正确率 + 平均用时相对时限的紧裕度」加权派生掌握度，
 *   needsReinforce 按阈值判需加强——推导口径以本文件为唯一权威，
 *   服务端（stats 查询端点）与前端（掌握度页展示口径）勿单方另写公式；
 * - DTO：GET /api/stats/knowledge 的分模块知识点掌握度响应（原始计数 + 服务端派生值一并下发）。
 * 模块级掌握度不走本推导（D4 决策：模块级由查询端点现算/不落行，当前仅知识点颗粒落库）。
 */

/** 需加强阈值：mastery 严格小于该值判「需加强」（两端同锚，勿单方改值） */
export const MASTERY_REINFORCE_THRESHOLD = 0.6

/** 正确率权重（掌握度 = 正确率权重×正确率 + 用时权重×用时得分） */
const ACCURACY_WEIGHT = 0.7
/** 用时得分权重 */
const TIME_SCORE_WEIGHT = 0.3

/**
 * 掌握度纯函数：ACCURACY_WEIGHT×正确率 + TIME_SCORE_WEIGHT×用时得分。
 * 用时得分 = clamp(1 − avgDurationMs/(timeLimitSec×1000), 0, 1)——平均用时相对每题时限的
 * 紧裕度：0ms 得 1 分、恰达时限得 0 分、超时限钳 0。
 * 防御行为（调用方应保证入参合法，此处兜底防 NaN/±Infinity 出域，返回值恒 [0,1]）：
 * - accuracy 非有限（NaN/±Infinity）按 0 计，正常值钳 [0,1]；
 * - avgDurationMs 非有限或为负按「达时限」计（用时得分 0——脏数据不奖励满分）；
 * - timeLimitSec ≤ 0 或非有限：紧裕度无定义，按卷外模块同口径处理（用时得分 0），
 *   掌握度退化为 ACCURACY_WEIGHT×正确率。
 */
export function deriveMastery(
  accuracy: number,
  avgDurationMs: number,
  timeLimitSec: number,
): number {
  const safeAccuracy = Number.isFinite(accuracy) ? Math.min(Math.max(accuracy, 0), 1) : 0
  const timeLimitMs = Number.isFinite(timeLimitSec) && timeLimitSec > 0 ? timeLimitSec * 1000 : null
  let timeScore = 0
  if (timeLimitMs !== null && Number.isFinite(avgDurationMs) && avgDurationMs >= 0) {
    timeScore = Math.min(Math.max(1 - avgDurationMs / timeLimitMs, 0), 1)
  }
  return ACCURACY_WEIGHT * safeAccuracy + TIME_SCORE_WEIGHT * timeScore
}

/** 是否需加强：mastery 严格小于 MASTERY_REINFORCE_THRESHOLD（等于阈值不算，恰好达标） */
export function needsReinforce(mastery: number): boolean {
  return mastery < MASTERY_REINFORCE_THRESHOLD
}

/* ============ 知识点掌握度查询 DTO（M3/T3-01d 定稿，前端 T3-01f 直接复用） ============ */

/**
 * 单知识点掌握度快照（GET /api/stats/knowledge 模块内逐点项，M3/T3-01d）。
 * 原始计数（totalCount/correctCount/accuracy/avgDurationMs）与派生值（mastery/needsReinforce）
 * 一并下发：mastery 由服务端经 shared deriveMastery 派生，前端不重复计算口径。
 */
export interface KnowledgeMasteryPoint {
  /** 知识点 id（knowledge_points.id，即 mastery_stats 的 target_id 锚点，勿以 code 代替） */
  knowledgePointId: number
  /** 知识点稳定编码（knowledge_points.code） */
  code: string
  /** 知识点名称（knowledge_points.name） */
  name: string
  /** 累计作答次数（打标在该知识点下的题目作答数，mastery_stats.total_count） */
  totalCount: number
  /** 累计答对次数（mastery_stats.correct_count） */
  correctCount: number
  /** 正确率（0–1，correctCount/totalCount 的冗余存储值） */
  accuracy: number
  /** 平均用时（毫秒，mastery_stats.avg_duration_ms） */
  avgDurationMs: number
  /** 掌握度（0–1，服务端经 deriveMastery 派生：0.7×正确率 + 0.3×用时得分） */
  mastery: number
  /** 是否需加强（mastery < MASTERY_REINFORCE_THRESHOLD，与强化队列口径同锚） */
  needsReinforce: boolean
}

/**
 * 分模块知识点掌握度（GET /api/stats/knowledge 数组项，M3/T3-01d）。
 * 仅含有 mastery_stats 行的知识点（无作答记录的知识点不出现，前端零填空）；
 * 序：模块序 = modules.sort_order，模块内知识点序 = sort_order + id 并列稳定。
 */
export interface KnowledgeMasteryModule {
  /** 行测模块编码（知识点所属模块） */
  module: XingceModuleCode
  /**
   * 每题时限秒数（DEFAULT_BLUEPRINT 经 shared deriveQuestionTimeLimit 推导）。
   * 卷外模块为 null——该模块各点 mastery 的用时得分按 0 处理（见 deriveMastery 防御口径），
   * 掌握度退化为 0.7×正确率。
   */
  timeLimitSec: number | null
  /** 模块内知识点列表（序 = knowledge_points.sort_order + id） */
  points: KnowledgeMasteryPoint[]
}

/**
 * GET /api/stats/knowledge 响应体（M3/T3-01d，直接返回不包壳）。
 * 空态（无作答/无打标）返回 []；本人维度（mastery_stats.userId 隔离）。
 */
export type KnowledgeMasteryResponse = KnowledgeMasteryModule[]
