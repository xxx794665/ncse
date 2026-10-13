/**
 * 登录页（T1-16，/login）
 * AppLayout 内居中窄卡片（--layout-max-auth）：用户名 + 口令，前端校验与后端一致；
 * 提交中按钮 loading + 禁用；API 失败展示 ApiError.message（如 401 用户名或密码不正确）；
 * 成功跳 state.from（守卫记录的来源路径）或 '/'；已登录访问本页 → 直接跳走（防重复登录）
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Button, Card, Input } from '../../components'
import { ApiError } from '../../api'
import { useAuth } from './auth-context'
import { validatePassword, validateUsername } from './auth-validation'
import './auth.css'

/** 字段级错误（null = 无错误，直喂 Input error 态） */
interface LoginFieldErrors {
  username: string | null
  password: string | null
}

/** 登录成功后的落点：守卫 state.from（仅接受站内路径，防开放重定向）或首页 */
function resolveRedirectTarget(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from
  return typeof from === 'string' && from.startsWith('/') ? from : '/'
}

export function LoginPage() {
  const { status, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({ username: null, password: null })
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 已登录访问登录页 → 去来源页/首页（防重复登录；也兜底登录成功后的重渲染）
  if (status === 'authenticated') {
    return <Navigate to={resolveRedirectTarget(location.state)} replace />
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return

    const errors: LoginFieldErrors = {
      username: validateUsername(username),
      password: validatePassword(password),
    }
    setFieldErrors(errors)
    if (errors.username !== null || errors.password !== null) return

    setFormError(null)
    setSubmitting(true)
    try {
      await login(username, password)
      navigate(resolveRedirectTarget(location.state), { replace: true })
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : '登录失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="ncse-auth-page">
      <Card className="ncse-auth-card">
        <form className="ncse-auth-form" noValidate onSubmit={handleSubmit}>
          <h1 className="ncse-auth-form__title">登录</h1>
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
            autoComplete="current-password"
            disabled={submitting}
          />
          <Button
            type="submit"
            size="lg"
            loading={submitting}
            className="ncse-auth-form__submit"
          >
            登录
          </Button>
          <p className="ncse-auth-form__switch">
            还没有账号？<Link to="/register">立即注册</Link>
          </p>
        </form>
      </Card>
    </div>
  )
}
