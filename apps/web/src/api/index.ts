/** API 层出口（T1-16）：client（fetch 封装）+ token 存取 + 各功能域 API 函数 */
export { API_BASE_URL, ApiError, apiFetch, setUnauthorizedHandler } from './client'
export type { ApiFetchOptions, UnauthorizedHandler } from './client'
export { clearAuthToken, getAuthToken, setAuthToken } from './auth-token'
export { fetchMeApi, loginApi, registerApi } from './auth-api'
export {
  createPracticeSessionApi,
  fetchPracticeSessionApi,
  fetchPracticeSessionsApi,
  submitPracticeAnswerApi,
} from './practice-api'
export { disposeWrongBookApi, fetchWrongBookApi } from './wrong-book-api'
export { addFavoriteApi, fetchFavoritesApi, removeFavoriteApi } from './favorites-api'
export { fetchStatsSummaryApi } from './stats-api'
