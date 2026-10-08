import { eq } from 'drizzle-orm'
import { sign } from 'hono/jwt'
import { beforeEach, describe, expect, it } from 'vitest'
import { env, exports } from 'cloudflare:workers'
import { createDb } from '../src/db'
import { users } from '../src/db/schema'
import { verifyPassword } from '../src/auth/password'
import { TEST_JWT_SECRET } from './test-secret'

/**
 * 认证域集成测试（T1-03）：经 exports.default.fetch 走真实 worker 入口
 * （含 CORS、路由挂载、onError 错误信封），D1 为 workerd 内的本地实例。
 */

const worker = exports.default

interface JsonOutcome {
  status: number
  body: Record<string, unknown>
}

/** 发 JSON 请求并按 JSON 解析响应（成功 DTO 与错误信封统一走这里） */
async function requestJson(path: string, init?: RequestInit): Promise<JsonOutcome> {
  const response = await worker.fetch(new Request(`http://localhost${path}`, init))
  const body = (await response.json()) as Record<string, unknown>
  return { status: response.status, body }
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function bearerGet(token: string): RequestInit {
  return { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
}

/** 取错误信封的 error 字段（形状不对时先在 toHaveProperty 上失败，给出可读断言） */
function errorField(body: Record<string, unknown>): { code: string; message: string } {
  expect(body).toHaveProperty('error')
  return body.error as { code: string; message: string }
}

/** 从响应体取 string 字段（提前失败给出可读信息，避免后续 as 断言静默通过） */
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  expect(typeof value).toBe('string')
  return value as string
}

/** 断言 user 视图形状（不含 password 等多余字段） */
function expectUserView(value: unknown, username: string): void {
  expect(value).toEqual({ id: expect.any(Number), username, role: 'user' })
}

beforeEach(async () => {
  // 每用例前清空 users（其余表均空表、无外键悬挂），用例之间互不依赖
  await createDb(env).delete(users)
})

describe('POST /api/auth/register', () => {
  it('注册成功：201，返回三段式 JWT token 与 user 视图', async () => {
    const { status, body } = await requestJson('/api/auth/register', postJson({ username: 'alice', password: 'password123' }))

    expect(status).toBe(201)
    const token = stringField(body, 'token')
    expect(token.split('.')).toHaveLength(3)
    expectUserView(body.user, 'alice')
  })

  it('数据库只存 pbkdf2 自描述哈希，绝不存明文，且可正确校验', async () => {
    await requestJson('/api/auth/register', postJson({ username: 'alice', password: 'password123' }))

    const rows = await createDb(env).select().from(users).where(eq(users.username, 'alice'))
    const stored = rows.at(0)?.passwordHash
    expect(stored).toBeDefined()
    // pbkdf2$<100000>$<16字节盐的Base64，24字符带==填充>$<32字节键的Base64，44字符带=填充>
    expect(stored).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/)
    expect(stored).not.toBe('password123')
    expect(await verifyPassword('password123', stored ?? '')).toBe(true)
    expect(await verifyPassword('password124', stored ?? '')).toBe(false)
  })

  it('重复用户名：409 + conflict 错误信封', async () => {
    await requestJson('/api/auth/register', postJson({ username: 'alice', password: 'password123' }))
    const { status, body } = await requestJson('/api/auth/register', postJson({ username: 'alice', password: 'password456' }))

    expect(status).toBe(409)
    const error = errorField(body)
    expect(error.code).toBe('conflict')
    expect(error.message).toContain('用户名已被注册')
  })

  it('并发注册同名：恰一个 201、一个 409（唯一索引兜底而非先查后插）', async () => {
    const outcomes = await Promise.all([
      requestJson('/api/auth/register', postJson({ username: 'bob', password: 'password123' })),
      requestJson('/api/auth/register', postJson({ username: 'bob', password: 'password456' })),
    ])
    expect(outcomes.map((o) => o.status).sort()).toEqual([201, 409])
  })

  it.each([
    { case: '过短', username: 'ab', password: 'password123' },
    { case: '非法字符', username: 'bad name!', password: 'password123' },
    { case: '超长', username: 'a'.repeat(33), password: 'password123' },
    { case: '弱密码', username: 'alice', password: 'short' },
  ])('入参不合法（$case）：400 + bad_request', async ({ username, password }) => {
    const { status, body } = await requestJson('/api/auth/register', postJson({ username, password }))
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
  })

  it.each([
    { case: '请求体不是 JSON', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' } },
    { case: '字段类型不是字符串', init: postJson({ username: 123, password: 'password123' }) },
  ])('请求体不合法（$case）：400 + bad_request', async ({ init }) => {
    const { status, body } = await requestJson('/api/auth/register', init)
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
  })
})

describe('POST /api/auth/login', () => {
  async function registerAlice(): Promise<void> {
    const { status } = await requestJson('/api/auth/register', postJson({ username: 'alice', password: 'password123' }))
    expect(status).toBe(201)
  }

  it('登录成功：200，返回 token 与 user 视图', async () => {
    await registerAlice()
    const { status, body } = await requestJson('/api/auth/login', postJson({ username: 'alice', password: 'password123' }))

    expect(status).toBe(200)
    expect(stringField(body, 'token').split('.')).toHaveLength(3)
    expectUserView(body.user, 'alice')
  })

  it('密码错误与用户不存在：同为 401 + unauthorized，且文案一致（不区分原因）', async () => {
    await registerAlice()
    const wrongPassword = await requestJson('/api/auth/login', postJson({ username: 'alice', password: 'password456' }))
    const unknownUser = await requestJson('/api/auth/login', postJson({ username: 'ghost', password: 'password123' }))

    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    const wrong = errorField(wrongPassword.body)
    const unknown = errorField(unknownUser.body)
    expect(wrong.code).toBe('unauthorized')
    expect(unknown.code).toBe('unauthorized')
    expect(wrong.message).toBe(unknown.message)
  })
})

describe('GET /api/auth/me（受保护路由示例）', () => {
  async function registerAndLogin(username: string, password: string): Promise<string> {
    await requestJson('/api/auth/register', postJson({ username, password }))
    const { status, body } = await requestJson('/api/auth/login', postJson({ username, password }))
    expect(status).toBe(200)
    return stringField(body, 'token')
  }

  it('带合法 token：200 返回当前用户', async () => {
    const token = await registerAndLogin('alice', 'password123')
    const { status, body } = await requestJson('/api/auth/me', bearerGet(token))

    expect(status).toBe(200)
    expectUserView(body.user, 'alice')
  })

  it('不带 Authorization 头：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson('/api/auth/me', { method: 'GET' })
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })

  it('token 非三段式垃圾值：401', async () => {
    const { status, body } = await requestJson('/api/auth/me', bearerGet('not-a-jwt'))
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })

  it('token 用错误密钥签发（签名伪造）：401', async () => {
    const now = Math.floor(Date.now() / 1000)
    const forged = await sign({ sub: '1', username: 'alice', role: 'user', iat: now, exp: now + 3600 }, 'definitely-not-the-real-secret')
    const { status } = await requestJson('/api/auth/me', bearerGet(forged))
    expect(status).toBe(401)
  })

  it('token 已过期（正确密钥签发但 exp 在过去）：401', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expired = await sign({ sub: '1', username: 'alice', role: 'user', iat: now - 7200, exp: now - 3600 }, TEST_JWT_SECRET)
    const { status } = await requestJson('/api/auth/me', bearerGet(expired))
    expect(status).toBe(401)
  })
})
