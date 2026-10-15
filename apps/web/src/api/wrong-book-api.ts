/**
 * 错题本域 API（T1-08g 处置 / T1-10b 列表）：后端 T1-08c 处置端点与 T1-10a 列表端点的前端封装
 * DTO 契约见 @ncse/shared（WrongBookEntrySummary / WrongBookDisposeRequest / WrongBookDisposeResponse）；
 * 语义见 ADR-0010：remove → eliminated 软移除保计数 / to_hard → 归难点本；处置只翻状态。
 * 错误统一经 apiFetch 抛 ApiError（404 该题不在错题本 / 401 登录态失效走全局回调等）
 */

import type {
  WrongBookDisposeRequest,
  WrongBookDisposeResponse,
  WrongBookEntrySummary,
} from '@ncse/shared'
import { apiFetch } from './client'

/**
 * GET /api/wrong-book?status=active|hard：当前用户错题本/难点本条目列表（updatedAt 倒序）
 * status 仅容在册两态（active 错题本 / hard 难点本）；eliminated 软移除条目永不列出（ADR-0010）
 */
export function fetchWrongBookApi(status: 'active' | 'hard'): Promise<WrongBookEntrySummary[]> {
  return apiFetch<WrongBookEntrySummary[]>(`/api/wrong-book?status=${status}`)
}

/** POST /api/wrong-book/:questionId/disposal：处置在册错题条目（200 处置后状态与计数） */
export function disposeWrongBookApi(
  questionId: number,
  body: WrongBookDisposeRequest,
): Promise<WrongBookDisposeResponse> {
  return apiFetch<WrongBookDisposeResponse>(`/api/wrong-book/${String(questionId)}/disposal`, {
    method: 'POST',
    body,
  })
}
