import { sign } from 'hono/jwt'
import type { AuthUser } from '@ncse/shared'

/**
 * 认证 JWT（T1-03 定稿）：hono/jwt 自带实现，HS256，零新增运行时依赖。
 * 密钥来自 env.JWT_SECRET（生产 `wrangler secret put`，本地 .dev.vars）。
 */

/** Token 有效期：30 天（自用站点免频繁重登；SaaS 化时缩短并引入 refresh 机制） */
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * 认证 JWT payload 契约。sub 存字符串化的 users.id（JWT sub 惯例为字符串），
 * username/role 顺带进 claims 供 /api/auth/me 免查库返回；
 * iat/exp 为 Unix 秒，exp 由 hono/jwt verify 默认校验（过期即拒绝）。
 */
export type AuthJwtPayload = {
  sub: string
  username: string
  role: AuthUser['role']
  iat: number
  exp: number
}

/** 签发认证 JWT（HS256 默认算法；密钥只从调用方传入的 env.JWT_SECRET 来） */
export async function signAuthToken(user: AuthUser, secret: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000)
  const payload: AuthJwtPayload = {
    sub: String(user.id),
    username: user.username,
    role: user.role,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
  }
  return sign(payload, secret)
}
