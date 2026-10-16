import { describe, expect, it } from 'vitest'
import { exports } from 'cloudflare:workers'
import { errorField, requestJson, stringField } from './api-helpers'

/**
 * 组合根集成测试（T1-12）：经 exports.default.fetch 走真实组合根链路——
 * CORS 中间件 → healthz/api 路由挂载 → onError/notFound 错误信封全在链路上
 * （T1-01 手工冒烟项首次自动化）。本文件只测组合根行为：不触数据表
 * （无需 DB 夹具与 beforeEach 清库）、无需鉴权。
 */

/** 真实 worker 入口（src/index.ts 组合根；测试不直接调内部路由） */
const worker = exports.default

/** CORS 白名单 Origin（与 src/cors.ts ALLOWED_ORIGINS 两项一一对应：本地 dev + 部署占位域名） */
const LOCAL_DEV_ORIGIN = 'http://localhost:5173'
const DEPLOY_ORIGIN = 'https://tiku.example.com'

/**
 * 发 CORS 预检 OPTIONS 请求（浏览器对 POST 端点预检的真实形态：
 * Origin + Access-Control-Request-Method；路径取真实存在的 POST 端点）。
 */
function preflight(origin: string): Promise<Response> {
  return worker.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    }),
  )
}

/** 断言预检响应放行头：ACAO 回显该 Origin，ACAH 含 Authorization 与 Content-Type */
function expectPreflightAllowed(response: Response, origin: string): void {
  // Headers.get 大小写不敏感，头名按小写读取即可
  expect(response.headers.get('access-control-allow-origin')).toBe(origin)
  const allowHeaders = response.headers.get('access-control-allow-headers') ?? ''
  expect(allowHeaders).toContain('Authorization')
  expect(allowHeaders).toContain('Content-Type')
}

describe('GET /healthz（根路径 liveness 探活，组合根路由挂载）', () => {
  it('200：body 形状 { status: "ok", service, time }，service 为实际值，time 可被 Date.parse 解析', async () => {
    const { status, body } = await requestJson('/healthz')

    expect(status).toBe(200)
    // 整形状断言：status/service 精确值（service 为 healthz.ts 实际值），time 为字符串且无多余字段
    expect(body).toEqual({ status: 'ok', service: 'ncse-api', time: expect.any(String) })
    // time 须为可被 Date.parse 解析的时间字符串（ISO 时间戳，NaN 即失败）
    expect(Number.isNaN(Date.parse(stringField(body, 'time')))).toBe(false)
  })
})

describe('CORS 中间件（白名单 Origin 放行、非白名单拒绝）', () => {
  it('预检放行：OPTIONS 带白名单 Origin（vite dev server）→ ACAO 回显该 Origin，ACAH 含 Authorization 与 Content-Type', async () => {
    const response = await preflight(LOCAL_DEV_ORIGIN)

    expectPreflightAllowed(response, LOCAL_DEV_ORIGIN)
  })

  it('预检放行（白名单第二项）：Origin 为部署占位域名，同样放行并回显', async () => {
    const response = await preflight(DEPLOY_ORIGIN)

    expectPreflightAllowed(response, DEPLOY_ORIGIN)
  })

  it('预检拒绝：OPTIONS 带非白名单 Origin → 响应不带 access-control-allow-origin 头', async () => {
    const response = await preflight('https://evil.example.com')

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('简单请求回显：GET /healthz 带白名单 Origin → 响应带 ACAO 回显（非预检也生效）', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/healthz', { headers: { Origin: LOCAL_DEV_ORIGIN } }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(LOCAL_DEV_ORIGIN)
  })

  it('无 Origin 头：GET /healthz 不带 Origin → 响应不带 access-control-allow-origin', async () => {
    const response = await worker.fetch(new Request('http://localhost/healthz'))

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('未命中路由（组合根 notFound 信封）', () => {
  it('未知 /api 路径：GET /api/nope → 404 + ApiErrorBody（not_found，文案与 index.ts notFound 一致）', async () => {
    const { status, body } = await requestJson('/api/nope')

    expect(status).toBe(404)
    const error = errorField(body)
    expect(error.code).toBe('not_found')
    expect(error.message).toBe('请求的资源不存在')
  })

  it('根级未知路径：GET /nope → 同 404 not_found 信封', async () => {
    const { status, body } = await requestJson('/nope')

    expect(status).toBe(404)
    const error = errorField(body)
    expect(error.code).toBe('not_found')
    expect(error.message).toBe('请求的资源不存在')
  })
})
