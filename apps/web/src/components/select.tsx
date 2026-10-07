/**
 * Select（设计规范 §6.3 输入族形态：与 Input 同高、同边框、同焦点环）
 * 原生 <select> 保证移动/PC 双端可用性，右侧 ChevronDown 仅装饰
 */

import { useId } from 'react'
import type { ReactNode, SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import './input.css'
import './select.css'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode
  error?: ReactNode
  children: ReactNode
}

export function Select({ label, error, id, className, children, ...rest }: SelectProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <div className="ncse-field">
      {label && (
        <label className="ncse-field__label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <div className="ncse-select">
        <select
          id={fieldId}
          className={['ncse-input', 'ncse-select__native', error ? 'ncse-input--error' : '', className ?? '']
            .filter(Boolean)
            .join(' ')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : undefined}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown className="ncse-select__chevron" aria-hidden="true" />
      </div>
      {error && (
        <p className="ncse-field__error" id={`${fieldId}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
