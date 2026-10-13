/**
 * AuthProvider 与 useAuth（T1-16，认证态单一权威来源）
 * - 状态机：restoring（启动恢复中）→ authenticated / anonymous；restoring 期间守卫与账号区不闪烁跳转
 * - 启动恢复：token 存在 → GET /api/auth/me 恢复 user；401 → 清 token 落 anonymous；
 *   其他失败（网络等）保留 token 落 anonymous（下次启动自动重试）
 * - login/register 成功：存 token + 置 authenticated（注册成功即登录态）；logout：清 token + user
 * - 401 全局回调（注入 api client，client 不 import router）：清 token/user；
 *   恢复期外且当前不在 /login、/register 时跳 /login（防循环）；恢复期内不跳（交守卫接管）
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { AuthUser } from '@ncse/shared'
import {
  ApiError,
  clearAuthToken,
  fetchMeApi,
  getAuthToken,
  loginApi,
  registerApi,
  setAuthToken,
  setUnauthorizedHandler,
} from '../../api'

/** 认证状态机：restoring = 启动恢复中 */
export type AuthStatus = 'restoring' | 'authenticated' | 'anonymous'

export interface AuthContextValue {
  /** 当前登录用户（anonymous/restoring 时为 null） */
  user: AuthUser | null
  status: AuthStatus
  /** 登录：成功写 token + user；失败抛 ApiError 由表单展示 */
  login: (username: string, password: string) => Promise<void>
  /** 注册：成功即登录态（写 token + user）；失败抛 ApiError 由表单展示 */
  register: (username: string, password: string) => Promise<void>
  /** 登出：清 token + user（JWT 无吊销，客户端丢弃即登出）；受保护页由守卫自动重定向 */
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [status, setStatus] = useState<AuthStatus>(() =>
    getAuthToken() === null ? 'anonymous' : 'restoring',
  )
  // 恢复期间 401 只清登录态不跳转（避免打开公共页被弹去登录页）；恢复完成后由守卫接管
  const restoringRef = useRef(status === 'restoring')
  // 401 回调注册一次，经 ref 取最新路径判断是否已在认证页（防循环）
  const pathnameRef = useRef(location.pathname)
  useEffect(() => {
    pathnameRef.current = location.pathname
  }, [location.pathname])

  // 启动恢复（仅挂载一次）：token 存在 → /me 换 user；失败按 token 有效性分流
  useEffect(() => {
    if (getAuthToken() === null) return
    let cancelled = false
    fetchMeApi()
      .then((me) => {
        if (cancelled) return
        setUser(me.user)
        setStatus('authenticated')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // 401（token 失效/伪造）→ 清 token；网络等其他失败 → 保留 token，下次启动重试
        if (error instanceof ApiError && error.status === 401) {
          clearAuthToken()
        }
        setUser(null)
        setStatus('anonymous')
      })
      .finally(() => {
        // StrictMode 双挂载时首个（已取消的）恢复请求先落定，不应提前结束恢复期
        if (!cancelled) restoringRef.current = false
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 登录态失效全局回调：注册到 api client（回调注入，保持 client 不依赖 router）
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearAuthToken()
      setUser(null)
      setStatus('anonymous')
      if (restoringRef.current) return
      const path = pathnameRef.current
      if (path !== '/login' && path !== '/register') {
        navigate('/login', { replace: true })
      }
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate])

  const login = useCallback(async (username: string, password: string) => {
    const res = await loginApi({ username, password })
    setAuthToken(res.token)
    setUser(res.user)
    setStatus('authenticated')
  }, [])

  const register = useCallback(async (username: string, password: string) => {
    const res = await registerApi({ username, password })
    setAuthToken(res.token)
    setUser(res.user)
    setStatus('authenticated')
  }, [])

  const logout = useCallback(() => {
    clearAuthToken()
    setUser(null)
    setStatus('anonymous')
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, register, logout }),
    [user, status, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** 读取认证态与登录/注册/登出动作；必须在 <AuthProvider> 内使用 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth 必须在 <AuthProvider> 内使用')
  }
  return ctx
}
