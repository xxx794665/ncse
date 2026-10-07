/**
 * Input / Textarea（docs/design/设计规范.md §6.3）
 * 高 48（移动）/ 40（PC，≥1024px）；bg-base + border-default，hover border-strong，
 * focus 焦点环；占位 text-tertiary；错误态 danger 边框 + 13px danger-text 说明；
 * 禁用 bg-muted；标签在上方 14px medium
 */

import { useId } from 'react'
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import './input.css'

interface FieldShellProps {
  id: string
  label?: ReactNode
  error?: ReactNode
  children: ReactNode
}

/** 标签 + 控件 + 错误说明的外壳，Input/Textarea/Select 共用 */
function FieldShell({ id, label, error, children }: FieldShellProps) {
  const errorId = `${id}-error`
  return (
    <div className="ncse-field">
      {label && (
        <label className="ncse-field__label" htmlFor={id}>
          {label}
        </label>
      )}
      {children}
      {error && (
        <p className="ncse-field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode
  error?: ReactNode
}

export function Input({ label, error, id, className, ...rest }: InputProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <FieldShell id={fieldId} label={label} error={error}>
      <input
        id={fieldId}
        className={['ncse-input', error ? 'ncse-input--error' : '', className ?? '']
          .filter(Boolean)
          .join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        {...rest}
      />
    </FieldShell>
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode
  error?: ReactNode
}

export function Textarea({ label, error, id, className, rows = 4, ...rest }: TextareaProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <FieldShell id={fieldId} label={label} error={error}>
      <textarea
        id={fieldId}
        rows={rows}
        className={['ncse-input', 'ncse-textarea', error ? 'ncse-input--error' : '', className ?? '']
          .filter(Boolean)
          .join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        {...rest}
      />
    </FieldShell>
  )
}
