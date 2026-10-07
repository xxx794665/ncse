/**
 * StatChip 统计徽章（docs/design/设计规范.md §6.6 StatBadge）
 * 图标 16 + 数值（mono、semibold、tabular-nums）+ 标签（aux、text-tertiary）横向排列；
 * 高 32px、bg-muted + radius-full、px-12；语义着色仅用于图标，数值恒 text-primary
 */

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import './stat-chip.css'

export type StatChipTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export interface StatChipProps {
  icon: LucideIcon
  value: ReactNode
  label: ReactNode
  /** 仅控制图标语义着色，默认 default（text-tertiary 装饰色） */
  tone?: StatChipTone
}

export function StatChip({ icon: Icon, value, label, tone = 'default' }: StatChipProps) {
  return (
    <span className="ncse-stat-chip">
      <Icon className={`ncse-stat-chip__icon ncse-stat-chip__icon--${tone}`} aria-hidden="true" />
      <span className="ncse-stat-chip__value">{value}</span>
      <span className="ncse-stat-chip__label">{label}</span>
    </span>
  )
}
