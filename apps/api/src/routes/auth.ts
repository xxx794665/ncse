import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { eq } from 'drizzle-orm'
import type { AuthResponse, AuthUser, MeResponse } from '@ncse/shared'
import { createDb } from '../db'
import { users } from '../db/schema'
import { signAuthToken } from '../auth/jwt'
import { hashPassword, verifyPassword } from '../auth/password'
import { requireAuth } from '../auth/middleware'
import type { AppEnv } from '../types'

/**
 * 认证域路由（T1-03，挂载于 /api/auth，见 src/routes/api.ts）：
 * - POST /register：注册并签发 token（201 { token, user }）；
 * - POST /login：登录签发 token（200 { token, user }）；
 * - GET /me：受保护路由示例，验证 requireAuth 中间件（200 { user } / 401）。
 * 业务错误一律抛 HTTPException（中文 message），由组合根 onError 统一收敛为 ApiErrorBody。
 */

/** 用户名规则：3–32 位 [A-Za-z0-9_] */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/
/** 口令最小长度 */
const PASSWORD_MIN_LENGTH = 8
/** 口令最大长度：防超大输入拖垮 PBKDF2 派生与内存（真实口令远达不到） */
const PASSWORD_MAX_LENGTH = 1024

/** 解析 JSON 请求体；不可解析（非 JSON / 非法编码）抛 400 */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new HTTPException(400, { message: '请求体必须是合法 JSON' })
  }
}

/** 从请求体提取 { username, password } 字符串对；形状不对抛 400（注册/登录共用） */
function requireCredentials(body: unknown): { username: string; password: string } {
  if (typeof body !== 'object' || body === null) {
    throw new HTTPException(400, { message: '请求体须为 JSON 对象，且含 username 与 password 字符串字段' })
  }
  const { username, password } = body as Record<string, unknown>
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new HTTPException(400, { message: 'username 与 password 必须是字符串' })
  }
  return { username, password }
}

/** 注册入参校验：用户名规则 + 口令长度；不合法抛 400 */
function validateRegisterInput(username: string, password: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new HTTPException(400, { message: '用户名须为 3-32 位字母、数字或下划线' })
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new HTTPException(400, { message: '密码长度至少 8 位' })
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new HTTPException(400, { message: `密码长度不能超过 ${PASSWORD_MAX_LENGTH} 位` })
  }
}

/** 识别 SQLite 唯一索引冲突：D1 会把底层错误包装后抛出，消息含
 *  "UNIQUE constraint failed"（可能带 D1_ERROR: 前缀），沿 cause 链逐层找以兼容驱动包装 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err
  while (current instanceof Error) {
    if (current.message.includes('UNIQUE constraint failed')) {
      return true
    }
    current = current.cause
  }
  return false
}

/** 登录失败的统一文案：用户不存在与密码错误不区分（防按用户名枚举注册状态） */
const LOGIN_FAILED_MESSAGE = '用户名或密码不正确'

/**
 * 时序均衡诱饵哈希：用户不存在时也完整跑一次 PBKDF2，令响应耗时与「密码错误」路径一致。
 * 该哈希不对应任何可登录口令，非秘密，按 isolate 缓存即可。
 */
let dummyHashPromise: Promise<string> | undefined
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('ncse-timing-equalization-dummy-password')
  return dummyHashPromise
}

/** 行记录 → 对外 AuthUser 视图（不含 password_hash 等敏感列） */
function toAuthUser(row: { id: number; username: string; role: 'user' | 'admin' }): AuthUser {
  return { id: row.id, username: row.username, role: row.role }
}

export const authRoute = new Hono<AppEnv>()

authRoute.post('/register', async (c) => {
  const { username, password } = requireCredentials(await readJsonBody(c))
  validateRegisterInput(username, password)

  const db = createDb(c.env)
  const passwordHash = await hashPassword(password)
  let created: { id: number; username: string; role: 'user' | 'admin' }
  try {
    // 唯一冲突不做先查后插（有并发窗口），直接依赖 users_username_uq 索引兜底
    const rows = await db
      .insert(users)
      .values({ username, passwordHash })
      .returning({ id: users.id, username: users.username, role: users.role })
    created = rows[0]
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HTTPException(409, { message: '用户名已被注册' })
    }
    throw err
  }

  const user = toAuthUser(created)
  const token = await signAuthToken(user, c.env.JWT_SECRET)
  const body: AuthResponse = { token, user }
  return c.json(body, 201)
})

authRoute.post('/login', async (c) => {
  const { username, password } = requireCredentials(await readJsonBody(c))
  // 超长口令直接 400：与注册同规则，且避免对注定失败的输入做 PBKDF2
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new HTTPException(400, { message: `密码长度不能超过 ${PASSWORD_MAX_LENGTH} 位` })
  }

  const db = createDb(c.env)
  const rows = await db.select().from(users).where(eq(users.username, username))
  const user = rows.at(0)
  // 用户不存在时对诱饵哈希做一次同代价校验，消除时序侧信道；结果恒为 false
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()))
  if (user === undefined || !passwordOk) {
    throw new HTTPException(401, { message: LOGIN_FAILED_MESSAGE })
  }

  const authUser = toAuthUser(user)
  const token = await signAuthToken(authUser, c.env.JWT_SECRET)
  const body: AuthResponse = { token, user: authUser }
  return c.json(body, 200)
})

authRoute.get('/me', requireAuth, (c) => {
  // 受保护路由示例：身份取自中间件注入的 authUser（token claims），不再查库
  const body: MeResponse = { user: c.get('authUser') }
  return c.json(body, 200)
})
