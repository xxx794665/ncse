/**
 * 登录态 token 存取（T1-16，架构设计 §2）
 * - Bearer JWT 存 localStorage，键 ncse-auth-token；JWT 30 天有效、无吊销，登出 = 客户端丢弃
 * - 全站 token 读写只经本模块，勿散落各处
 * - localStorage 不可用（隐私模式等）时降级：读 null、写告警、清除静默
 */

/** token 的 localStorage 持久化键 */
const AUTH_TOKEN_STORAGE_KEY = 'ncse-auth-token'

/** 读取持久化 token；未写入/localStorage 不可用时返回 null */
export function getAuthToken(): string | null {
  try {
    return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

/** 持久化 token；localStorage 不可用时降级为仅告警（登录态仅本次会话内存有效） */
export function setAuthToken(token: string): void {
  try {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token)
  } catch (error) {
    console.warn('[auth] localStorage 不可用，登录态无法持久化', error)
  }
}

/** 清除持久化 token（登出 / 登录态失效时调用） */
export function clearAuthToken(): void {
  try {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  } catch {
    // localStorage 不可用：本就无持久化内容，无需处理
  }
}
