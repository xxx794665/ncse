/**
 * Button（docs/design/设计规范.md §6.1）
 * 变体 primary/secondary/ghost/danger，尺寸 sm/md/lg；
 * 加载态左侧 16px 旋转图标（Loader2）、切换瞬间锁宽不抖动；
 * 禁用态透明度 0.5 + not-allowed；焦点环 2px border-focus + 2px 偏移（全控件统一）
 */

import { forwardRef, useLayoutEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Loader2 } from 'lucide-react'
import './button.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 变体，默认 primary */
  variant?: ButtonVariant
  /** 尺寸，默认 md */
  size?: ButtonSize
  /** 加载态：左侧旋转图标、禁用点击、宽度锁定 */
  loading?: boolean
  /** 前置图标节点（建议 lucide 图标，按钮内按尺寸阶梯渲染为 16/20px） */
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    icon,
    disabled,
    children,
    className,
    style,
    type = 'button',
    ...rest
  },
  forwardedRef: Ref<HTMLButtonElement>,
) {
  const innerRef = useRef<HTMLButtonElement | null>(null)
  const [lockedWidth, setLockedWidth] = useState<number | null>(null)

  // 进入加载态前量取当前宽度并锁定，退出时释放（§6.1 宽度锁定不抖动）
  useLayoutEffect(() => {
    if (loading) {
      if (innerRef.current) setLockedWidth(innerRef.current.offsetWidth)
    } else {
      setLockedWidth(null)
    }
  }, [loading])

  const setRefs = (node: HTMLButtonElement | null) => {
    innerRef.current = node
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }

  const classNames = [
    'ncse-button',
    `ncse-button--${variant}`,
    `ncse-button--${size}`,
    loading ? 'is-loading' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={setRefs}
      type={type}
      className={classNames}
      style={lockedWidth !== null ? { ...style, width: lockedWidth } : style}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 className="ncse-button__spinner" aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </button>
  )
})
