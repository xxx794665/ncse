/**
 * 统计域 API（T1-11b）：后端 T1-11a 汇总端点的前端封装
 * DTO 契约见 @ncse/shared（StatsSummaryResponse）：overall 全历史聚合 / modules 分模块聚合
 * （仅含有记录模块、moduleCode 升序）/ daily 近 STATS_TREND_DAYS 天北京时间日趋势
 * （零填空、升序、今日在末）；正确率与平均用时由前端派生（answered=0 除零兜底在前端）。
 * 错误统一经 apiFetch 抛 ApiError（401 登录态失效走全局回调等）
 */

import type { StatsSummaryResponse } from '@ncse/shared'
import { apiFetch } from './client'

/** GET /api/stats/summary：当前用户练习统计汇总（overall + modules + daily 三段同回，不包壳） */
export function fetchStatsSummaryApi(): Promise<StatsSummaryResponse> {
  return apiFetch<StatsSummaryResponse>('/api/stats/summary')
}
