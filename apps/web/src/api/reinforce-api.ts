/**
 * 需加强清单域 API（M3/T3-01f）：后端 T3-01e 强化队列列表端点的前端封装
 * DTO 契约见 @ncse/shared（ReinforceEntrySummary）：stemPreview 服务端生成（≤80 字符）、
 * reason 汇入原因（wrong 答错 / timeout 超时，含答对但超时）、updatedAt 倒序（最近汇入在前）。
 * 全自动队列（汇入/出队由判分联动），无任何用户处置端点——与错题本的本质分工；
 * 建强化会话走 createPracticeSessionApi 的 reinforce 分支（practice-api.ts）
 * 错误统一经 apiFetch 抛 ApiError（401 登录态失效走全局回调等）
 */

import type { ReinforceEntrySummary, ReinforceStatus } from '@ncse/shared'
import { apiFetch } from './client'

/**
 * GET /api/reinforce?status=pending|resolved：当前用户强化队列条目列表（updatedAt 倒序，不包壳）
 * status 缺省 'pending'（待强化）；仅容 pending/resolved（白名单外 400）；本期前端只查 pending
 */
export function fetchReinforceApi(
  status: ReinforceStatus = 'pending',
): Promise<ReinforceEntrySummary[]> {
  return apiFetch<ReinforceEntrySummary[]>(`/api/reinforce?status=${status}`)
}
