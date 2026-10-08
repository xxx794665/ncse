import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { verify } from 'hono/jwt'
import type { AuthUser } from '@ncse/shared'
import type { AppEnv } from '../types'

/** Bearer 方案前缀（Authorization: Bearer <token>） */
const BEARER_PREFIX = 'Bearer '

/** 401 文案：缺失/格式错/签名不符/过期统一同一句，不向探测者泄露具体失败环节 */
const UNAUTHORIZED_MESSAGE = '未登录或登录已过期'

/**
 * 认证中间件：校验 Authorization: Bearer <JWT>（HS256；hono/jwt verify 默认校验 exp/iat），
 * 通过后把 { id, username, role } 注入 Variables.authUser 供后续处理器 c.get('authUser') 使用。
 * 任何失败抛 401 HTTPException，由组合根 onError 收敛为 ApiErrorBody（code=unauthorized）。
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization')
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    throw new HTTPException(401, { message: UNAUTHORIZED_MESSAGE })
  }
  const token = header.slice(BEARER_PREFIX.length).trim()
  if (token === '') {
    throw new HTTPException(401, { message: UNAUTHORIZED_MESSAGE })
  }

  let payload: unknown
  try {
    payload = await verify(token, c.env.JWT_SECRET, 'HS256')
  } catch {
    // 签名不符/结构损坏/已过期等一律按认证失败处理（不区分原因）
    throw new HTTPException(401, { message: UNAUTHORIZED_MESSAGE })
  }

  const authUser = toAuthUser(payload)
  if (authUser === null) {
    throw new HTTPException(401, { message: UNAUTHORIZED_MESSAGE })
  }
  c.set('authUser', authUser)
  await next()
})

/** 从 JWT payload 收窄出 AuthUser：sub 须为纯数字字符串，username 须为字符串，role 须为合法枚举值 */
function toAuthUser(payload: unknown): AuthUser | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const p = payload as Record<string, unknown>
  if (typeof p.sub !== 'string' || !/^\d+$/.test(p.sub)) {
    return null
  }
  if (typeof p.username !== 'string') {
    return null
  }
  if (p.role !== 'user' && p.role !== 'admin') {
    return null
  }
  return { id: Number(p.sub), username: p.username, role: p.role }
}
