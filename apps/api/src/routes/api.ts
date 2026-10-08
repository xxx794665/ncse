import { Hono } from 'hono'
import type { Env } from '../types'

/**
 * `/api` 业务域聚合路由（组合根 src/index.ts 挂载）。
 * 预留各业务域子路由挂载点，后续任务落地时逐个追加：
 * - T1-03 认证：authRoute → /api/auth/*（注册/登录、签发 JWT）；
 * - AI 代理（ADR-0005）：aiRoute → /api/ai/*（申论批改、AI 参考答案等 POST 转发）；
 * - 题库、做题记录等其余业务域：按任务进展追加。
 * 当前不挂任何业务子路由。
 */
export const apiRoute = new Hono<{ Bindings: Env }>()
