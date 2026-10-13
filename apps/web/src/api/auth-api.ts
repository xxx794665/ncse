/**
 * 认证域 API（T1-16）：后端 T1-03 三端点的前端封装
 * DTO 契约见 @ncse/shared（RegisterRequest / LoginRequest / AuthResponse / MeResponse）；
 * 错误统一经 apiFetch 抛 ApiError（401 口令错误 / 409 用户名冲突 / 400 校验失败等）
 */

import type { AuthResponse, LoginRequest, MeResponse, RegisterRequest } from '@ncse/shared'
import { apiFetch } from './client'

/** POST /api/auth/register：注册成功即登录态（201 返回 token + user；409 用户名已被注册） */
export function registerApi(body: RegisterRequest): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/api/auth/register', { method: 'POST', body })
}

/** POST /api/auth/login：登录签发 token（200；401 用户名或密码不正确，不触发全局登出回调） */
export function loginApi(body: LoginRequest): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/api/auth/login', { method: 'POST', body })
}

/** GET /api/auth/me：携带 token 的受保护端点（启动恢复登录态用；401 = token 失效） */
export function fetchMeApi(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/api/auth/me')
}
