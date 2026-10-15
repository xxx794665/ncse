/**
 * 收藏域 API（T1-10b）：后端 T1-10a 收藏端点的前端封装
 * DTO 契约见 @ncse/shared（FavoriteSummary / FavoriteToggleResponse）；
 * 收藏/取消均幂等恒 200（响应 favorited 为操作后语义值：POST 恒 true、DELETE 恒 false）；
 * 题目不存在（或非数字 id）404「题目不存在」；取消收藏即删行，列表只反映在册行。
 * 错误统一经 apiFetch 抛 ApiError（401 登录态失效走全局回调等）
 */

import type { FavoriteSummary, FavoriteToggleResponse } from '@ncse/shared'
import { apiFetch } from './client'

/** GET /api/favorites：当前用户收藏列表（createdAt 倒序，最近收藏在前） */
export function fetchFavoritesApi(): Promise<FavoriteSummary[]> {
  return apiFetch<FavoriteSummary[]>('/api/favorites')
}

/** POST /api/favorites/:questionId：收藏题目（幂等，重复收藏恒 200 favorited=true） */
export function addFavoriteApi(questionId: number): Promise<FavoriteToggleResponse> {
  return apiFetch<FavoriteToggleResponse>(`/api/favorites/${String(questionId)}`, {
    method: 'POST',
  })
}

/** DELETE /api/favorites/:questionId：取消收藏（幂等，未收藏调用恒 200 favorited=false） */
export function removeFavoriteApi(questionId: number): Promise<FavoriteToggleResponse> {
  return apiFetch<FavoriteToggleResponse>(`/api/favorites/${String(questionId)}`, {
    method: 'DELETE',
  })
}
