import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { API_ERROR_CODES, type ApiErrorBody, type ApiErrorCode } from '@ncse/shared'
import { isAllowedOrigin } from './cors'
import type { Env } from './types'
import { healthzRoute } from './routes/healthz'
import { apiRoute } from './routes/api'

const app = new Hono<{ Bindings: Env }>()

// CORS 雏形：仅白名单 Origin（占位值见 src/cors.ts）放行跨域。
app.use(
  '*',
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : undefined),
    allowHeaders: ['Authorization', 'Content-Type'],
  }),
)

// 路由挂载：healthz 为根路径 liveness 探活；业务域统一挂 /api 前缀（子路由见 src/routes/api.ts）。
app.route('/', healthzRoute)
app.route('/api', apiRoute)

/**
 * HTTPException 状态码 → 稳定语义错误码（不随 message 波动，客户端据此分支）。
 * T1-03 已扩充认证域：400 → bad_request、401 → unauthorized、409 → conflict。
 */
function errorCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return API_ERROR_CODES.bad_request
    case 401:
      return API_ERROR_CODES.unauthorized
    case 404:
      return API_ERROR_CODES.not_found
    case 409:
      return API_ERROR_CODES.conflict
    default:
      return API_ERROR_CODES.internal_error
  }
}

// 统一错误处理：所有异常在此收敛为 ApiErrorBody 信封（工程规范 §3：不吞错、不裸 catch）。
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    // 主动抛出的 HTTPException：透传其 status 与 message，错误码取稳定语义值。
    const body: ApiErrorBody = {
      error: { code: errorCodeForStatus(err.status), message: err.message },
    }
    return c.json(body, err.status)
  }
  // 未预期异常：完整信息仅记入 Workers 日志（console.error 供观测），客户端只回通用消息，不回显内部细节。
  console.error(
    '未处理异常：',
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  )
  const body: ApiErrorBody = {
    error: { code: API_ERROR_CODES.internal_error, message: '服务器内部错误，请稍后重试' },
  }
  return c.json(body, 500)
})

// 未命中任何路由：404 + ApiErrorBody（错误信封与前端共用 @ncse/shared 类型）。
app.notFound((c) => {
  const body: ApiErrorBody = {
    error: { code: API_ERROR_CODES.not_found, message: '请求的资源不存在' },
  }
  return c.json(body, 404)
})

export default app
