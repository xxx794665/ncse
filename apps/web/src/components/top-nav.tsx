/**
 * TopNav PC 顶栏（docs/design/设计规范.md §6.4）
 * ≥1024px 显示：高 64px、bg-elevated + 底边 border-subtle、吸顶后 shadow-xl；
 * 左：产品名 + 主导航；右：主题三态循环按钮 + 账号入口；
 * 当前页导航项 primary-text + 底部 2px primary 指示条
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { User } from 'lucide-react'
import { ThemeModeCycleButton } from './theme-mode-button'
import './top-nav.css'

export interface TopNavItem {
  key: string
  label: string
  href: string
  /** NavLink end 匹配（如首页） */
  end?: boolean
}

export interface TopNavProps {
  items: TopNavItem[]
  /** 右侧账号区插槽；缺省渲染账号图标占位按钮 */
  accountSlot?: ReactNode
}

export function TopNav({ items, accountSlot }: TopNavProps) {
  const [stuck, setStuck] = useState(false)

  // 吸顶浮起：页面滚动后加 shadow-xl（§6.4）
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 0)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className="ncse-top-nav" data-stuck={stuck || undefined}>
      <div className="ncse-top-nav__inner">
        <NavLink to="/" className="ncse-top-nav__brand">
          ncse
        </NavLink>
        <nav className="ncse-top-nav__nav" aria-label="主导航">
          {items.map((item) => (
            <NavLink
              key={item.key}
              to={item.href}
              end={item.end}
              className={({ isActive }) =>
                ['ncse-top-nav__item', isActive ? 'is-active' : ''].filter(Boolean).join(' ')
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="ncse-top-nav__actions">
          <ThemeModeCycleButton />
          {accountSlot ?? (
            <button type="button" className="ncse-top-nav__account" aria-label="账号">
              <User aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
