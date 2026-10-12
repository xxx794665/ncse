import { expect } from 'vitest'
import { exports } from 'cloudflare:workers'

/**
 * API 集成测试共享请求助手（T1-08b 起从 practice-api.test.ts 抽出，判分/处置测试共用）：
 * worker 入口经 exports.default.fetch 走真实路由挂载（含 CORS、onError 错误信封）；
 * 字段断言助手在形状不符时先失败给出可读信息，避免后续 as 断言静默通过。
 */

/** 真实 worker 入口（src/index.ts 组合根；测试不直接调内部路由） */
const worker = exports.default

/**
 * 测试注册口令：每次测试运行随机生成（Web Crypto，test-only——运行结束即失效，
 * 运行外不可用，非硬编码值；注册即签发 token，后续全程用 token，口令无复用）。
 */
export const TEST_PASSWORD = `test-only-${crypto.randomUUID()}`

/** 请求 origin（与 worker.fetch 的 Request 一致；图片 URL 投影断言用） */
export const ORIGIN = 'http://localhost'

export interface JsonOutcome {
  status: number
  body: Record<string, unknown>
}

/** 发 JSON 请求并按 JSON 解析响应（成功 DTO 与错误信封统一走这里） */
export async function requestJson(path: string, init?: RequestInit): Promise<JsonOutcome> {
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init))
  const body = (await response.json()) as Record<string, unknown>
  return { status: response.status, body }
}

/** 无鉴权 POST 的 RequestInit（JSON 请求体） */
export function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** 带 Bearer token 的 POST RequestInit（JSON 请求体） */
export function bearerPost(token: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }
}

/** 带 Bearer token 的 GET RequestInit */
export function bearerGet(token: string): RequestInit {
  return { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
}

/** 取错误信封的 error 字段（形状不对时先在 toHaveProperty 上失败，给出可读断言） */
export function errorField(body: Record<string, unknown>): { code: string; message: string } {
  expect(body).toHaveProperty('error')
  return body.error as { code: string; message: string }
}

/** 从响应体取 number 字段（提前失败给出可读信息，避免后续 as 断言静默通过） */
export function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key]
  expect(typeof value).toBe('number')
  return value as number
}

/** 从响应体取 string 字段（同上） */
export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  expect(typeof value).toBe('string')
  return value as string
}

/** 会话详情响应的 questions 数组（形状不对先失败给出可读信息） */
export function questionList(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body.questions
  expect(Array.isArray(value)).toBe(true)
  return value as Record<string, unknown>[]
}

/** 注册拿 token（注册即签发，无需再登录；口令为本文件模块级随机值） */
export async function registerForToken(username: string): Promise<string> {
  const { status, body } = await requestJson('/api/auth/register', postJson({ username, password: TEST_PASSWORD }))
  expect(status).toBe(201)
  return stringField(body, 'token')
}
