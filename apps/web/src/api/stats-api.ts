/**
 * 统计域 API（T1-11b / M3 T3-01f）：后端 T1-11a 汇总端点与 T3-01d 知识点掌握度端点的前端封装
 * DTO 契约见 @ncse/shared：
 * - StatsSummaryResponse：overall 全历史聚合 / modules 分模块聚合（仅含有记录模块、moduleCode 升序）/
 *   daily 近 STATS_TREND_DAYS 天北京时间日趋势（零填空、升序、今日在末）；
 *   正确率与平均用时由前端派生（answered=0 除零兜底在前端）
 * - KnowledgeMasteryResponse：分模块知识点掌握度（仅含有作答记录的知识点，模块序/点序服务端已排好）；
 *   mastery/needsReinforce 为服务端派生值（shared deriveMastery 口径），前端只展示勿重复计算
 * 错误统一经 apiFetch 抛 ApiError（401 登录态失效走全局回调等）
 */

import type { KnowledgeMasteryResponse, StatsSummaryResponse } from '@ncse/shared'
import { apiFetch } from './client'

/** GET /api/stats/summary：当前用户练习统计汇总（overall + modules + daily 三段同回，不包壳） */
export function fetchStatsSummaryApi(): Promise<StatsSummaryResponse> {
  return apiFetch<StatsSummaryResponse>('/api/stats/summary')
}

/**
 * GET /api/stats/knowledge（M3/T3-01d）：当前用户分模块知识点掌握度（直返不包壳）
 * 空态（无作答/无打标）返回 []；本人维度（mastery_stats.userId 隔离）
 */
export function fetchStatsKnowledgeApi(): Promise<KnowledgeMasteryResponse> {
  return apiFetch<KnowledgeMasteryResponse>('/api/stats/knowledge')
}
