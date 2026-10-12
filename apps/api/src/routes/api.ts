import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { authRoute } from './auth'
import { practiceRoute } from './practice'
import { wrongBookRoute } from './wrong-book'

/**
 * `/api` 业务域聚合路由（组合根 src/index.ts 挂载），子路由统一 `Hono<AppEnv>`。
 * 各业务域子路由挂载点，后续任务落地时逐个追加：
 * - T1-03（已落地）认证：authRoute → /api/auth/*（注册/登录、JWT 签发与校验）；
 * - T1-08b（已落地）专项刷题·练习会话：practiceRoute → /api/practice/*
 *   （建会话/详情/列表/判分，全路由 requireAuth）；
 * - T1-08c（已落地）错题本处置：wrongBookRoute → /api/wrong-book/*
 *   （在册条目移除/归难点本，ADR-0010，全路由 requireAuth）；
 * - AI 代理（ADR-0005）：aiRoute → /api/ai/*（申论批改、AI 参考答案等 POST 转发）；
 * - 题库、做题记录等其余业务域：按任务进展追加。
 */
export const apiRoute = new Hono<AppEnv>()

// 认证域：/register 与 /login 公开，/me 经 requireAuth 示范受保护路由的接入方式
apiRoute.route('/auth', authRoute)

// 专项刷题会话域：全端点 requireAuth（子路由内部 use），抽题与判分共识见 ADR-0009
apiRoute.route('/practice', practiceRoute)

// 错题本处置域：全端点 requireAuth（子路由内部 use），处置语义见 ADR-0010
apiRoute.route('/wrong-book', wrongBookRoute)
