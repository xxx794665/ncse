/**
 * Tag 标签（设计规范 §7.4④ ghost 徽章、§2.2 语义色成对规则）
 * muted 用 bg-muted + text-secondary（§2.2：muted 底至少 secondary）；
 * 语义色调用 soft 底 + soft-text 成对组合；传 onClick 时渲染为可点击按钮
 */

import type { HTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import './tag.css'

export type TagTone = 'muted' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export interface TagProps extends HTMLAttributes<HTMLElement> {
  tone?: TagTone
  /** 16px 行内图标（§5），随文字着色 */
  icon?: LucideIcon
  /** 提供时渲染为 <button>（如知识点跳转） */
  onClick?: () => void
  children: ReactNode
}

export function Tag({ tone = 'muted', icon: Icon, onClick, className, children, ...rest }: TagProps) {
  const classNames = ['ncse-tag', `ncse-tag--${tone}`, onClick ? 'ncse-tag--clickable' : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  const body = (
    <>
      {Icon && <Icon className="ncse-tag__icon" aria-hidden="true" />}
      {children}
    </>
  )

  if (onClick) {
    return (
      <button type="button" className={classNames} onClick={onClick} {...rest}>
        {body}
      </button>
    )
  }
  return (
    <span className={classNames} {...rest}>
      {body}
    </span>
  )
}
