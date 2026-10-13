/**
 * API client（T1-16）：全站唯一 fetch 封装
 * - base URL 取自 import.meta.env.VITE_API_BASE_URL（空串 = 同源相对路径；本地开发见 .env.development），
 *   末尾斜杠规范化，拼接不产生双斜杠
 * - 请求：body 非 undefined 时 JSON 序列化并补 Content-Type: application/json；
 *   token 存在时附 Authorization: Bearer <token>
 * - 响应：2xx 解析 JSON 返回 DTO；非 2xx 解析统一错误信封（ApiErrorBody）抛 ApiError；
 *   网络失败/错误体不可解析时回落 internal_error 形态的 ApiError
 * - 401 全局规则：仅「携带了 Authorization」的请求（登录态失效语义）触发 onUnauthorized 回调，
 *   之后照常抛 ApiError；未带 token 的 401（如登录口令错误）不触发，由表单展示
 * - 分层：本模块不 import router，跳转逻辑由 AuthProvider 注入的回调完成
 */

import { API_ERROR_CODES } from '@ncse/shared'
import type { ApiErrorBody } from '@ncse/shared'
import { getAuthToken } from './auth-token'

/** API 基址：规范化为无末尾斜杠（缺省/空串 = 同源相对路径） */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')

/** API 调用失败的 typed 错误（含 HTTP 状态、稳定语义错误码与面向用户的消息） */
export class ApiError extends Error {
  /** HTTP 状态码；0 = 网络层失败（未拿到响应） */
  readonly status: number
  /** 稳定语义错误码（取值见 API_ERROR_CODES；未知码原样保留，客户端不得依赖 status 文本） */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** 登录态失效（带 token 的 401）回调；由 AuthProvider 启动时注册、卸载时注销 */
export type UnauthorizedHandler = () => void

let unauthorizedHandler: UnauthorizedHandler | null = null

/** 注册/注销 401 全局回调（同时仅保留一个，后注册覆盖先注册） */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  /** 请求体（非 undefined 时 JSON 序列化，并自动补 Content-Type: application/json） */
  body?: unknown
}

/** 判断未知响应体是否符合统一错误信封（ApiErrorBody） */
function isApiErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== 'object' || body === null) return false
  const { error } = body as Partial<ApiErrorBody>
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof error.code === 'string' &&
    typeof error.message === 'string'
  )
}

/** 解析非 2xx 响应的错误信封；体不可解析/非 JSON 时回落 internal_error 通用形态 */
async function readErrorBody(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body: unknown = await res.json()
    if (isApiErrorBody(body)) return body.error
  } catch {
    // 错误体非 JSON：走下方通用回落
  }
  return {
    code: API_ERROR_CODES.internal_error,
    message: `请求失败（HTTP ${String(res.status)}），请稍后重试`,
  }
}

/**
 * 发起 API 请求并解析响应 DTO。
 * @param path 站内路径（如 /api/auth/login；自动拼到 base URL 之后，前导斜杠缺省自动补）
 * @param options 同 RequestInit；body 以对象字面量传入即可（自动 JSON 序列化）
 * @throws {ApiError} 非 2xx / 网络失败 / 成功响应非 JSON
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options
  const token = getAuthToken()

  const finalHeaders = new Headers(headers)
  if (body !== undefined && !finalHeaders.has('Content-Type')) {
    finalHeaders.set('Content-Type', 'application/json')
  }
  if (token !== null) {
    finalHeaders.set('Authorization', `Bearer ${token}`)
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}${normalizedPath}`, {
      ...rest,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, API_ERROR_CODES.internal_error, '网络连接失败，请检查网络后重试')
  }

  if (!res.ok) {
    const errorBody = await readErrorBody(res)
    // 401 全局规则：仅携带了 Authorization 的请求视为登录态失效（token 过期/伪造），
    // 触发注入回调后照常抛错；未带 token 的 401（登录口令错误等）不触发
    if (res.status === 401 && token !== null) {
      unauthorizedHandler?.()
    }
    throw new ApiError(res.status, errorBody.code, errorBody.message)
  }

  // 成功响应：当前端点均为 JSON；空体（如未来的 204 端点）按 undefined 处理
  const text = await res.text()
  if (text === '') return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(res.status, API_ERROR_CODES.internal_error, '响应格式异常，请稍后重试')
  }
}
