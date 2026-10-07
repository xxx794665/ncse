/**
 * EmptyPlaceholder 未实现功能占位（docs/design/设计规范.md §6.7、ADR-0006）
 * 垂直居中：Construction 48px text-tertiary + 标题 + 「未完成」说明 + 所属里程碑徽章
 * + 可选 secondary 按钮（默认文案「返回首页」）；不写死预计上线时间
 */

import type { ReactNode } from 'react'
import { Construction } from 'lucide-react'
import { Button } from './button'
import { Tag } from './tag'
import './empty-placeholder.css'

export interface EmptyPlaceholderProps {
  /** 标题，默认「功能建设中」 */
  title?: ReactNode
  /** 「未完成」说明文案 */
  description?: ReactNode
  /** 所属里程碑（如 "M2"），渲染为徽章 */
  milestone?: string
  /** 按钮文案，默认「返回首页」；onAction 缺省时不渲染按钮 */
  actionLabel?: ReactNode
  onAction?: () => void
}

export function EmptyPlaceholder({
  title = '功能建设中',
  description,
  milestone,
  actionLabel = '返回首页',
  onAction,
}: EmptyPlaceholderProps) {
  return (
    <div className="ncse-empty">
      <Construction className="ncse-empty__icon" aria-hidden="true" />
      <h1 className="ncse-empty__title">{title}</h1>
      {description && <p className="ncse-empty__desc">{description}</p>}
      {milestone && <Tag tone="muted">里程碑 {milestone} · 未完成</Tag>}
      {onAction && (
        <Button variant="secondary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
