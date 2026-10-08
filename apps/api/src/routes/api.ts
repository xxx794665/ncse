import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { authRoute } from './auth'

/**
 * `/api` 业务域聚合路由（组合根 src/index.ts 挂载），子路由统一 `Hono<AppEnv>`。
 * 各业务域子路由挂载点，后续任务落地时逐个追加：
 * - T1-03（已落地）认证：authRoute → /api/auth/*（注册/登录、JWT 签发与校验）；
 * - AI 代理（ADR-0005）：aiRoute → /api/ai/*（申论批改、AI 参考答案等 POST 转发）；
 * - 题库、做题记录等其余业务域：按任务进展追加。
 */
export const apiRoute = new Hono<AppEnv>()

// 认证域：/register 与 /login 公开，/me 经 requireAuth 示范受保护路由的接入方式
apiRoute.route('/auth', authRoute)
