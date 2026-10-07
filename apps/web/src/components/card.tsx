/**
 * Card（docs/design/设计规范.md §6.2）
 * bg-elevated + border-subtle + radius-lg + shadow-sm；
 * interactive 卡片 hover 升 shadow-md 并上移 2px（--duration-fast）；
 * 内边距移动 md / PC lg；标题 font-size-title + semibold
 */

import type { HTMLAttributes, ReactNode } from 'react'
import './card.css'

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 卡片标题（可选），右侧可挂 extra 操作区 */
  title?: ReactNode
  /** 标题行右侧操作区 */
  extra?: ReactNode
  /** 可点击卡片：hover 升阴影上移；onClick 场景使用 */
  interactive?: boolean
}

export function Card({
  title,
  extra,
  interactive = false,
  className,
  children,
  ...rest
}: CardProps) {
  const classNames = [
    'ncse-card',
    interactive ? 'ncse-card--interactive' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classNames} {...rest}>
      {(title || extra) && (
        <div className="ncse-card__header">
          {title && <h3 className="ncse-card__title">{title}</h3>}
          {extra && <div className="ncse-card__extra">{extra}</div>}
        </div>
      )}
      {children}
    </div>
  )
}
