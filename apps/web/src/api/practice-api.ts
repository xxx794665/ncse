/**
 * 练习域 API（T1-08f）：后端 T1-08b 练习会话端点的前端封装
 * DTO 契约见 @ncse/shared（CreatePracticeSessionRequest / PracticeSessionDetail / PracticeSessionSummary）；
 * 错误统一经 apiFetch 抛 ApiError（400 该模块暂无可用题目 / 401 登录态失效走全局回调等）
 */

import type {
  CreatePracticeSessionRequest,
  PracticeSessionDetail,
  PracticeSessionSummary,
} from '@ncse/shared'
import { apiFetch } from './client'

/**
 * POST /api/practice/sessions：按模块建练习会话
 * 201 返回会话详情（模块可用题目不足 count 时按实际数建会话；为 0 时 400）
 */
export function createPracticeSessionApi(
  body: CreatePracticeSessionRequest,
): Promise<PracticeSessionDetail> {
  return apiFetch<PracticeSessionDetail>('/api/practice/sessions', { method: 'POST', body })
}

/** GET /api/practice/sessions：当前用户进行中（in_progress）会话列表，createdAt 倒序 */
export function fetchPracticeSessionsApi(): Promise<PracticeSessionSummary[]> {
  return apiFetch<PracticeSessionSummary[]>('/api/practice/sessions')
}
