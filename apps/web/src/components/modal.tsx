/**
 * Modal（设计规范 §4.3/§6.8：radius-xl、shadow-lg、z-overlay/z-modal）
 * PC（≥1024px）居中对话框；移动端底部 Sheet 形态（滑入、圆角仅上侧）。
 * Esc 与遮罩点击关闭；开启时锁定 body 滚动（disablePortal 演示场景除外）。
 */

import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import './modal.css'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** 底部操作区（建议放 Button 组） */
  footer?: ReactNode
  /** 演示/嵌套场景禁用 portal：跟随最近的 data-theme 祖先渲染（默认 false） */
  disablePortal?: boolean
}

export function Modal({ open, onClose, title, children, footer, disablePortal = false }: ModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)

  // 打开时初始聚焦对话框；Esc 关闭
  useEffect(() => {
    if (!open) return
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  // body 滚动锁定（portal 全屏遮罩场景）
  useEffect(() => {
    if (!open || disablePortal) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open, disablePortal])

  if (!open) return null

  const content = (
    <div className="ncse-modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="ncse-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ncse-modal__header">
          {title && (
            <h2 className="ncse-modal__title" id={titleId}>
              {title}
            </h2>
          )}
          <button type="button" className="ncse-modal__close" onClick={onClose} aria-label="关闭">
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="ncse-modal__body">{children}</div>
        {footer && <div className="ncse-modal__footer">{footer}</div>}
      </div>
    </div>
  )

  return disablePortal ? content : createPortal(content, document.body)
}
