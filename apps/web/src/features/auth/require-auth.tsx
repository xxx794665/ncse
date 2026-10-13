/**
 * RequireAuth 受保护路由守卫（T1-16）
 * - restoring：最小加载态（不跳转，防闪烁）
 * - anonymous：Navigate /login（state.from 记录目标路径，登录成功原路返回）
 * - authenticated：渲染子路由
 * 挂载由 App.tsx 按 app-routes 注册表的 requiresAuth 标志执行（首个受保护路由 /practice）
 */

import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './auth-context'
import './auth.css'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'restoring') {
    return (
      <div className="ncse-auth-loading" role="status">
        正在验证登录状态…
      </div>
    )
  }
  if (status === 'anonymous') {
    const from = `${location.pathname}${location.search}`
    return <Navigate to="/login" replace state={{ from }} />
  }
  return <>{children}</>
}
