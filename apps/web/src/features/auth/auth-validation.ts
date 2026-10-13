/**
 * 认证表单前端校验（T1-16）：规则与后端 apps/api/src/routes/auth.ts 一致
 * （用户名 3–32 位字母/数字/下划线，口令 ≥ 8 位），错误文案与后端 400 message 对齐
 */

/** 用户名规则：3–32 位 [A-Za-z0-9_]（同后端 USERNAME_PATTERN） */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/

/** 口令最小长度（同后端 PASSWORD_MIN_LENGTH） */
export const PASSWORD_MIN_LENGTH = 8

/** 校验用户名；合法返回 null，否则返回中文错误提示（Input error 态展示） */
export function validateUsername(username: string): string | null {
  if (username === '') return '请输入用户名'
  if (!USERNAME_PATTERN.test(username)) return '用户名须为 3-32 位字母、数字或下划线'
  return null
}

/** 校验口令；合法返回 null，否则返回中文错误提示（Input error 态展示） */
export function validatePassword(password: string): string | null {
  if (password === '') return '请输入密码'
  if (password.length < PASSWORD_MIN_LENGTH) return '密码长度至少 8 位'
  return null
}

/** 校验口令确认（注册页）；合法返回 null，否则返回中文错误提示 */
export function validatePasswordConfirm(password: string, confirm: string): string | null {
  if (confirm === '') return '请再次输入密码'
  if (confirm !== password) return '两次输入的密码不一致'
  return null
}
