/**
 * 注册页（T1-16，/register）
 * AppLayout 内居中窄卡片（--layout-max-auth）：用户名 + 口令 + 口令确认，前端校验与后端一致；
 * 提交中按钮 loading + 禁用；API 失败展示 ApiError.message（如 409 用户名已被注册）；
 * 注册成功即登录态，跳 '/'；已登录访问本页 → Navigate '/'（防重复注册）
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Button, Card, Input } from '../../components'
import { ApiError } from '../../api'
import { useAuth } from './auth-context'
import { validatePassword, validatePasswordConfirm, validateUsername } from './auth-validation'
import './auth.css'

/** 字段级错误（null = 无错误，直喂 Input error 态） */
interface RegisterFieldErrors {
  username: string | null
  password: string | null
  confirm: string | null
}

export function RegisterPage() {
  const { status, register } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [fieldErrors, setFieldErrors] = useState<RegisterFieldErrors>({
    username: null,
    password: null,
    confirm: null,
  })
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 已登录访问注册页 → 回首页（防重复注册）
  if (status === 'authenticated') {
    return <Navigate to="/" replace />
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return

    const errors: RegisterFieldErrors = {
      username: validateUsername(username),
      password: validatePassword(password),
      confirm: validatePasswordConfirm(password, confirm),
    }
    setFieldErrors(errors)
    if (errors.username !== null || errors.password !== null || errors.confirm !== null) return

    setFormError(null)
    setSubmitting(true)
    try {
      await register(username, password)
      navigate('/', { replace: true })
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : '注册失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="ncse-auth-page">
      <Card className="ncse-auth-card">
        <form className="ncse-auth-form" noValidate onSubmit={handleSubmit}>
          <h1 className="ncse-auth-form__title">注册</h1>
          {formError !== null && (
            <p className="ncse-auth-form__error" role="alert">
              {formError}
            </p>
          )}
          <Input
            label="用户名"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value)
              setFieldErrors((prev) => ({ ...prev, username: null }))
              setFormError(null)
            }}
            error={fieldErrors.username}
            placeholder="3-32 位字母、数字或下划线"
            autoComplete="username"
            disabled={submitting}
          />
          <Input
            label="密码"
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              setFieldErrors((prev) => ({ ...prev, password: null }))
              setFormError(null)
            }}
            error={fieldErrors.password}
            placeholder="至少 8 位"
            autoComplete="new-password"
            disabled={submitting}
          />
          <Input
            label="确认密码"
            type="password"
            value={confirm}
            onChange={(event) => {
              setConfirm(event.target.value)
              setFieldErrors((prev) => ({ ...prev, confirm: null }))
              setFormError(null)
            }}
            error={fieldErrors.confirm}
            placeholder="再次输入密码"
            autoComplete="new-password"
            disabled={submitting}
          />
          <Button
            type="submit"
            size="lg"
            loading={submitting}
            className="ncse-auth-form__submit"
          >
            注册
          </Button>
          <p className="ncse-auth-form__switch">
            已有账号？<Link to="/login">直接登录</Link>
          </p>
        </form>
      </Card>
    </div>
  )
}
