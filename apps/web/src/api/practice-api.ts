/**
 * 练习域 API（T1-08f）：后端 T1-08b 练习会话端点的前端封装
 * DTO 契约见 @ncse/shared（CreatePracticeSessionRequest / PracticeSessionDetail / PracticeSessionSummary）；
 * 错误统一经 apiFetch 抛 ApiError（400 该模块暂无可用题目 / 401 登录态失效走全局回调等）
 */

import type {
  CreatePracticeSessionRequest,
  PracticeSessionDetail,
  PracticeSessionSummary,
  SubmitPracticeAnswerRequest,
  SubmitPracticeAnswerResponse,
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

/**
 * GET /api/practice/sessions/:id：会话详情（任意状态可取；不含正确答案与解析——服务端判分共识）
 * 404：会话不存在 / 非本人 / 非数字 id（后端同文案，防存在性探测）
 */
export function fetchPracticeSessionApi(id: number): Promise<PracticeSessionDetail> {
  return apiFetch<PracticeSessionDetail>(`/api/practice/sessions/${String(id)}`)
}

/**
 * POST /api/practice/sessions/:id/answers：提交作答并判分
 * 200 判分结果（correctAnswer / analysis 仅此处回发）；400 入参校验失败（questionId 不在会话、
 * answer 非选项键、durationMs 越界）；404 会话不存在
 */
export function submitPracticeAnswerApi(
  sessionId: number,
  body: SubmitPracticeAnswerRequest,
): Promise<SubmitPracticeAnswerResponse> {
  return apiFetch<SubmitPracticeAnswerResponse>(
    `/api/practice/sessions/${String(sessionId)}/answers`,
    { method: 'POST', body },
  )
}
