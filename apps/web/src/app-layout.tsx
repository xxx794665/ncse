/**
 * AppLayout 全站框架（T0-05，设计规范 §6.4）
 * - 响应式切换：PC（≥1024px）TopNav 吸顶；移动（<1024px）顶部品牌栏 + BottomTab
 *   （TopNav / BottomTab 组件自身 CSS 按断点控制显隐，此处始终挂载，无需 JS 断点判断）
 * - 主题三态控件：PC 位于 TopNav 右侧（组件内置 ThemeModeCycleButton）；移动位于品牌栏右侧
 * - 主题状态由 main.tsx 中位于路由之上的 ThemeProvider 持有，路由切换不丢失
 * - 认证态接线（T1-16）：TopNav 账号区（匿名登录链接 / 恢复中中性占位 / 已登录用户名+登出）、
 *   BottomTab「我的」href 认证态感知（匿名 → /login；已登录 → /settings）
 */

import { Link, Outlet } from 'react-router-dom'
import { BookOpen, CalendarCheck, ChartColumn, CircleX, LogOut, User } from 'lucide-react'
import { BottomTab, ThemeModeCycleButton, TopNav } from './components'
import type { BottomTabItem, TopNavItem } from './components'
import { useAuth } from './features/auth/auth-context'

/** PC 主导航（§6.4：刷题 / 模考 / 错题本 / 统计 / 计划） */
const TOP_NAV_ITEMS: TopNavItem[] = [
  { key: 'practice', label: '刷题', href: '/practice' },
  { key: 'mock', label: '模考', href: '/mock' },
  { key: 'review', label: '错题本', href: '/review' },
  { key: 'stats', label: '统计', href: '/stats' },
  { key: 'plan', label: '计划', href: '/plan' },
]

/** 移动底部 Tab（§6.4：刷题 / 错题 / 统计 / 计划 / 我的；图标约定见 §5）；「我的」href 认证态感知 */
function buildBottomTabItems(authenticated: boolean): BottomTabItem[] {
  return [
    { key: 'practice', label: '刷题', href: '/practice', icon: BookOpen },
    { key: 'review', label: '错题', href: '/review', icon: CircleX },
    { key: 'stats', label: '统计', href: '/stats', icon: ChartColumn },
    { key: 'plan', label: '计划', href: '/plan', icon: CalendarCheck },
    { key: 'me', label: '我的', href: authenticated ? '/settings' : '/login', icon: User },
  ]
}

/** TopNav 右侧账号区：匿名 → 登录链接；restoring → 中性图标占位（不闪烁跳转）；已登录 → 用户名 + 登出 */
function AccountSlot() {
  const { status, user, logout } = useAuth()

  if (status === 'restoring') {
    return (
      <span className="ncse-top-nav__account" aria-hidden="true">
        <User />
      </span>
    )
  }
  if (status === 'authenticated' && user !== null) {
    return (
      <>
        <span className="ncse-top-nav__username">{user.username}</span>
        <button
          type="button"
          className="ncse-top-nav__account"
          aria-label="退出登录"
          onClick={logout}
        >
          <LogOut aria-hidden="true" />
        </button>
      </>
    )
  }
  return (
    <Link to="/login" className="ncse-top-nav__account" aria-label="登录">
      <User aria-hidden="true" />
    </Link>
  )
}

export function AppLayout() {
  const { status } = useAuth()
  return (
    <div className="app-shell">
      <TopNav items={TOP_NAV_ITEMS} accountSlot={<AccountSlot />} />
      {/* 移动品牌栏：产品名 + 主题三态循环控件；≥1024px 隐藏（PC 由 TopNav 承担） */}
      <div className="app-shell__mobilebar">
        <Link to="/" className="app-shell__brand">
          ncse
        </Link>
        <ThemeModeCycleButton />
      </div>
      <main className="app-shell__main">
        <Outlet />
      </main>
      <BottomTab items={buildBottomTabItems(status === 'authenticated')} />
    </div>
  )
}
