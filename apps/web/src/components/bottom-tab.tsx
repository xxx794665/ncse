/**
 * BottomTab 移动底部导航（docs/design/设计规范.md §6.4）
 * <1024px 显示：高 56px + 安全区，bg-elevated + 顶边 border-subtle；
 * 激活态图标+文字 primary-text，未激活 text-tertiary；
 * 图标约定（§5）：刷题 BookOpen / 错题 CircleX / 统计 ChartColumn / 计划 CalendarCheck / 我的 User
 */

import { NavLink } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import './bottom-tab.css'

export interface BottomTabItem {
  key: string
  label: string
  href: string
  icon: LucideIcon
  end?: boolean
}

export interface BottomTabProps {
  items: BottomTabItem[]
}

export function BottomTab({ items }: BottomTabProps) {
  return (
    <nav className="ncse-bottom-tab" aria-label="底部导航">
      {items.map((item) => {
        const Icon = item.icon
        return (
          <NavLink
            key={item.key}
            to={item.href}
            end={item.end}
            className={({ isActive }) =>
              ['ncse-bottom-tab__item', isActive ? 'is-active' : ''].filter(Boolean).join(' ')
            }
          >
            <Icon className="ncse-bottom-tab__icon" aria-hidden="true" />
            <span className="ncse-bottom-tab__label">{item.label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}
