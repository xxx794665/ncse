/**
 * 错题本域 API（T1-08g）：后端 T1-08c 错题处置端点的前端封装
 * DTO 契约见 @ncse/shared（WrongBookDisposeRequest / WrongBookDisposeResponse）；
 * 语义见 ADR-0010：remove → eliminated 软移除保计数 / to_hard → 归难点本；处置只翻状态。
 * 错误统一经 apiFetch 抛 ApiError（404 该题不在错题本 / 401 登录态失效走全局回调等）
 */

import type { WrongBookDisposeRequest, WrongBookDisposeResponse } from '@ncse/shared'
import { apiFetch } from './client'

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
