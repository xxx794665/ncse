import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { and, desc, eq } from 'drizzle-orm'
import type { WrongBookDisposeAction, WrongBookDisposeResponse, WrongBookEntrySummary, XingceModuleCode } from '@ncse/shared'
import { createDb } from '../db'
import { modules, questions, wrongBook } from '../db/schema'
import { requireAuth } from '../auth/middleware'
import { buildStemPreview } from './stem-preview'
import type { AppEnv } from '../types'

/**
 * 错题本域路由（T1-08c/T1-10a，挂载于 /api/wrong-book，见 src/routes/api.ts）：
 * - GET /：错题本/难点本列表（?status=active|hard，缺省 active，eliminated 软移除永不列出），
 *   join questions（悬空题行整条跳过）+ modules 取 code，updatedAt 倒序、id 倒序并列稳定；
 * - POST /:questionId/disposal：处置当前用户在册条目（remove → eliminated 软移除保计数 /
 *   to_hard → hard 难点本，ADR-0010——消灭由用户处置取代自动连对）；幂等，任意在册状态
 *   （active/hard/eliminated）均可跨状态处置（用户自主管理）。
 * 全端点 requireAuth；业务错误一律抛 HTTPException（中文 message），
 * 由组合根 onError 统一收敛为 ApiErrorBody（沿用既有错误码，不新增）。
 */

/** 条目 404 文案：不存在与他人条目同一句（防存在性探测） */
const ENTRY_NOT_FOUND_MESSAGE = '错题本条目不存在'

/** 处置动作白名单（与 shared WrongBookDisposeAction 对齐，两端勿单方扩值） */
const DISPOSE_ACTIONS: readonly WrongBookDisposeAction[] = ['remove', 'to_hard']

/** 列表可查状态白名单（eliminated 软移除语义永不列出，勿单方扩值） */
const LISTABLE_STATUSES: readonly ('active' | 'hard')[] = ['active', 'hard']

/** 解析 JSON 请求体；不可解析（非 JSON / 非法编码）抛 400（与 auth.ts 同构） */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new HTTPException(400, { message: '请求体必须是合法 JSON' })
  }
}

/** action 值收窄：是否为两个处置动作之一 */
function isDisposeAction(value: string): value is WrongBookDisposeAction {
  return (DISPOSE_ACTIONS as readonly string[]).includes(value)
}

/** status 查询参数收窄：是否为可列出的两态之一（active/hard） */
function isListableStatus(value: string): value is 'active' | 'hard' {
  return (LISTABLE_STATUSES as readonly string[]).includes(value)
}

export const wrongBookRoute = new Hono<AppEnv>()

// 本域无公开端点：列表与处置一律经 requireAuth（401 由组合根收敛为 unauthorized 信封）
wrongBookRoute.use(requireAuth)

wrongBookRoute.get('/', async (c) => {
  // status 缺省 active；仅容 active/hard（其余 400）；eliminated 软移除条目永不进入查询
  const statusParam = c.req.query('status') ?? 'active'
  if (!isListableStatus(statusParam)) {
    throw new HTTPException(400, { message: `status 必须是 ${LISTABLE_STATUSES.join(' 或 ')}（字符串）` })
  }

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // inner join：题目行悬空（内容重删的罕见态）整条跳过；模块行随题目级联删除，同理由跳过
  const rows = await db
    .select({
      questionId: wrongBook.questionId,
      wrongCount: wrongBook.wrongCount,
      redoCount: wrongBook.redoCount,
      status: wrongBook.status,
      updatedAt: wrongBook.updatedAt,
      stem: questions.stem,
      moduleCode: modules.code,
    })
    .from(wrongBook)
    .innerJoin(questions, eq(questions.id, wrongBook.questionId))
    .innerJoin(modules, eq(modules.id, questions.moduleId))
    .where(and(eq(wrongBook.userId, authUser.id), eq(wrongBook.status, statusParam)))
    // updatedAt 倒序（最近变化在前）；id 倒序兜底：同毫秒行保持稳定序
    .orderBy(desc(wrongBook.updatedAt), desc(wrongBook.id))

  const body: WrongBookEntrySummary[] = rows.map((row) => ({
    questionId: row.questionId,
    // modules.code 库层为无域类型的 TEXT（M1 内容域即行测模块编码），读取处按域值断言
    //（与 practice_sessions.moduleCode 的 $type<XingceModuleCode> 同一约定）
    moduleCode: row.moduleCode as XingceModuleCode,
    stemPreview: buildStemPreview(row.stem),
    wrongCount: row.wrongCount,
    redoCount: row.redoCount,
    status: row.status,
    updatedAt: row.updatedAt,
  }))
  return c.json(body, 200)
})

wrongBookRoute.post('/:questionId/disposal', async (c) => {
  // 非数字 id 一律 404（与「不存在」同文案，不区分原因）
  const questionIdParam = c.req.param('questionId')
  if (!/^\d+$/.test(questionIdParam)) {
    throw new HTTPException(404, { message: ENTRY_NOT_FOUND_MESSAGE })
  }

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 归属条件并入查询：不存在与不属于当前用户同回 404（防存在性探测）；一次按 userId+questionId 取整行
  const entryRows = await db
    .select()
    .from(wrongBook)
    .where(and(eq(wrongBook.userId, authUser.id), eq(wrongBook.questionId, Number(questionIdParam))))
  const entry = entryRows[0]
  if (entry === undefined) {
    throw new HTTPException(404, { message: ENTRY_NOT_FOUND_MESSAGE })
  }

  const requestBody = await readJsonBody(c)
  if (typeof requestBody !== 'object' || requestBody === null) {
    throw new HTTPException(400, { message: '请求体须为 JSON 对象，且含 action 字符串字段' })
  }
  const { action } = requestBody as Record<string, unknown>
  if (typeof action !== 'string' || !isDisposeAction(action)) {
    throw new HTTPException(400, { message: `action 必须是 ${DISPOSE_ACTIONS.join(' 或 ')}（字符串）` })
  }

  // 动作 → 目标状态：remove → eliminated（软移除，计数保留）；to_hard → hard（难点本）
  const targetStatus = action === 'remove' ? 'eliminated' : 'hard'

  // 处置只翻转 status（计数不动——计数随作答演进，ADR-0010）；updatedAt 显式给值（不依赖 $onUpdate）
  await db
    .update(wrongBook)
    .set({ status: targetStatus, updatedAt: new Date().toISOString() })
    .where(eq(wrongBook.id, entry.id))

  const responseBody: WrongBookDisposeResponse = {
    questionId: entry.questionId,
    status: targetStatus,
    wrongCount: entry.wrongCount,
    redoCount: entry.redoCount,
    consecutiveCorrect: entry.consecutiveCorrect,
  }
  return c.json(responseBody, 200)
})
