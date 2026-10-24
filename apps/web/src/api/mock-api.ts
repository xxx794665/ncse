/**
 * 整卷模考域 API（T2-01c）：后端 T2-01b 试卷目录与模考会话端点的前端封装
 * DTO 契约见 @ncse/shared（PaperSummary / MockSessionSummary / CreateMockSessionRequest / MockSessionDetail）；
 * 错误统一经 apiFetch 抛 ApiError（400 totalMinutes 越界或 paperId 非法 / 404 试卷不存在 /
 * 401 登录态失效走全局回调）
 */

import type {
  CreateMockSessionRequest,
  MockSessionDetail,
  MockSessionSummary,
  PaperSummary,
} from '@ncse/shared'
import { apiFetch } from './client'

/** GET /api/papers：全量卷目录（服务端定序 year DESC → questionCount DESC → name ASC，自用规模一次下发不分页） */
export function fetchPapersApi(): Promise<PaperSummary[]> {
  return apiFetch<PaperSummary[]>('/api/papers')
}

/** GET /api/mock/sessions：当前用户进行中（in_progress）模考会话列表，createdAt 倒序 */
export function fetchMockSessionsApi(): Promise<MockSessionSummary[]> {
  return apiFetch<MockSessionSummary[]>('/api/mock/sessions')
}

/**
 * POST /api/mock/sessions：开考建会话
 * - totalMinutes 省缺时服务端按题数推导（D3：1 题/分钟向上取整到 5 分钟）；显式值须整数
 *   [MOCK_TOTAL_MINUTES_MIN, MOCK_TOTAL_MINUTES_MAX]，开考即固化
 * - 201 返回会话详情（id 为跳转作答页所需）；400 入参校验失败 / 404 试卷不存在
 */
export function createMockSessionApi(
  body: CreateMockSessionRequest,
): Promise<MockSessionDetail> {
  return apiFetch<MockSessionDetail>('/api/mock/sessions', { method: 'POST', body })
}
