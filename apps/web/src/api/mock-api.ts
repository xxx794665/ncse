/**
 * 整卷模考域 API（T2-01c/T2-01d/T2-01e）：后端 T2-01b 试卷目录与模考会话端点的前端封装
 * DTO 契约见 @ncse/shared（PaperSummary / MockSessionSummary / CreateMockSessionRequest /
 * MockSessionDetail / SubmitMockAnswerRequest / UpdateMockTimerRequest / MockSessionReport /
 * MockHistoryItem）；
 * 错误统一经 apiFetch 抛 ApiError（400 入参校验失败 / 404 试卷或会话不存在 /
 * 401 登录态失效走全局回调）
 */

import type {
  CreateMockSessionRequest,
  MockHistoryItem,
  MockSessionDetail,
  MockSessionReport,
  MockSessionSummary,
  PaperSummary,
  SubmitMockAnswerRequest,
  SubmitMockAnswerResponse,
  UpdateMockTimerRequest,
  UpdateMockTimerResponse,
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

/**
 * GET /api/mock/sessions/:id：会话详情（任意状态可取——进行中续考 / 交卷后回看）
 * - 作答中不下发答案与解析（D4：交卷统一判分）；题目序 = 开考快照序
 * - 404：会话不存在 / 非本人 / 非数字 id（防存在性探测）
 */
export function fetchMockSessionApi(id: number): Promise<MockSessionDetail> {
  return apiFetch<MockSessionDetail>(`/api/mock/sessions/${String(id)}`)
}

/**
 * POST /api/mock/sessions/:id/answers：逐题作答（upsert，可改答案；作答中不判分不回发答案，D4）
 * - durationMs 为该题停留用时累计的绝对值，服务端对既有行取 max 防回退（乱序/重复上报安全）
 * - 400：questionId 不在快照清单 / answer 非选项键 / durationMs 越界 / 会话已交卷；404 会话不存在
 */
export function submitMockAnswerApi(
  sessionId: number,
  body: SubmitMockAnswerRequest,
): Promise<SubmitMockAnswerResponse> {
  return apiFetch<SubmitMockAnswerResponse>(
    `/api/mock/sessions/${String(sessionId)}/answers`,
    { method: 'POST', body },
  )
}

/**
 * POST /api/mock/sessions/:id/timer：计时上报（D6 累计绝对值口径：前端权威累计，服务端 max 防回退）
 * - 响应为 max 防回退后的落库值；中断容忍——上报失败下次进入按服务端基线续考
 * - keepalive：页面卸载（pagehide）场景尽力上报，请求可在页面销毁后继续完成
 * - 400：elapsedMs 越界 / 会话已交卷；404 会话不存在
 */
export function updateMockTimerApi(
  sessionId: number,
  elapsedMs: number,
  options?: { keepalive?: boolean },
): Promise<UpdateMockTimerResponse> {
  const body: UpdateMockTimerRequest = { elapsedMs }
  return apiFetch<UpdateMockTimerResponse>(`/api/mock/sessions/${String(sessionId)}/timer`, {
    method: 'POST',
    body,
    keepalive: options?.keepalive,
  })
}

/**
 * POST /api/mock/sessions/:id/submit：交卷（无入参；交卷即定卷，服务端统一判分）
 * - 200 回成绩单 MockSessionReport（summary/modules/questions；T2-01e 成绩单页消费同型 GET /report）
 * - 400：会话非 in_progress（重复交卷拒绝）；404 会话不存在
 */
export function submitMockSessionApi(sessionId: number): Promise<MockSessionReport> {
  return apiFetch<MockSessionReport>(`/api/mock/sessions/${String(sessionId)}/submit`, {
    method: 'POST',
  })
}

/**
 * GET /api/mock/sessions/:id/report：成绩单回看（T2-01e；与交卷响应同型，全部从库重算）
 * - submitted/abandoned 均可取；in_progress 400「会话未交卷」（成绩单只对已定卷会话有意义）
 * - 404：会话不存在 / 非本人（防存在性探测）
 */
export function fetchMockReportApi(sessionId: number): Promise<MockSessionReport> {
  return apiFetch<MockSessionReport>(`/api/mock/sessions/${String(sessionId)}/report`)
}

/**
 * GET /api/mock/history：本人全部已交卷会话的概要列表（T2-01e，F2-4 历次成绩与纵向对比）
 * - submittedAt 倒序（最近交卷在前）；abandoned 不入历史（未判分无成绩）
 * - summary 六数口径与 MockSessionReport.summary 一致（已答 = 已判分行）
 */
export function fetchMockHistoryApi(): Promise<MockHistoryItem[]> {
  return apiFetch<MockHistoryItem[]>('/api/mock/history')
}
