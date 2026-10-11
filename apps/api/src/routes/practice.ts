import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { and, asc, countDistinct, desc, eq, inArray, notExists, sql } from 'drizzle-orm'
import type {
  CreatePracticeSessionRequest,
  PracticeQuestionDto,
  PracticeSessionDetail,
  PracticeSessionSummary,
  QuestionKind,
  QuestionOption,
  RichContent,
  XingceModuleCode,
} from '@ncse/shared'
import { createDb, type DbClient } from '../db'
import { modules, practiceRecords, practiceSessions, questions } from '../db/schema'
import { requireAuth } from '../auth/middleware'
import type { AppEnv } from '../types'

/**
 * 专项刷题·练习会话域路由（T1-08b，挂载于 /api/practice，见 src/routes/api.ts）：
 * - POST /sessions：按模块建会话（抽题：未做过优先、不足按最近作答最旧补齐），201 返回会话详情；
 * - GET /sessions/:id：会话详情（题目富片段不含答案/解析——服务端判分共识；图片段投影 /api/img URL）；
 * - GET /sessions：当前用户活动会话列表（只列 in_progress，createdAt 倒序）。
 * 全端点 requireAuth；业务错误一律抛 HTTPException（中文 message），
 * 由组合根 onError 统一收敛为 ApiErrorBody（沿用既有错误码，不新增）。
 */

/** 行测六模块 code 白名单（与 shared XingceModuleCode 对齐，两端勿单方扩值） */
const XINGCE_MODULE_CODES: readonly XingceModuleCode[] = [
  'political_theory',
  'common_sense',
  'verbal',
  'quantitative',
  'judgement',
  'data_analysis',
]

/** 建会话题数选项（与前端模块选择页一致，缺省 DEFAULT_QUESTION_COUNT） */
const ALLOWED_QUESTION_COUNTS: readonly number[] = [5, 10, 20, 30]
/** 缺省题数（前端不传 count 时） */
const DEFAULT_QUESTION_COUNT = 10

/**
 * R2 图片内容寻址键形态（ADR-0007：img/<源字节 sha256 64hex>.webp|.gif）。
 * 仅该形态才投影为 /api/img URL；其余（源仓库相对路径等历史数据）原样保留，防误构造。
 * /api/img 端点本身属 T1-08d，本域只定 URL 约定。
 */
const IMAGE_KEY_PATTERN = /^img\/[0-9a-f]{64}\.(webp|gif)$/

/** 会话 404 文案：不存在与不属于当前用户同一句（防存在性探测） */
const SESSION_NOT_FOUND_MESSAGE = '会话不存在'

/** 解析 JSON 请求体；不可解析（非 JSON / 非法编码）抛 400（与 auth.ts 同构） */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new HTTPException(400, { message: '请求体必须是合法 JSON' })
  }
}

/** module 值收窄：是否为六模块 code 之一 */
function isXingceModuleCode(value: string): value is XingceModuleCode {
  return (XINGCE_MODULE_CODES as readonly string[]).includes(value)
}

/** 建会话入参校验：module 六选一、count（如传）四选一；不合法抛 400（返回值 count 已定缺省） */
function parseCreateRequest(body: unknown): Required<CreatePracticeSessionRequest> {
  if (typeof body !== 'object' || body === null) {
    throw new HTTPException(400, { message: '请求体须为 JSON 对象，且含 module 字符串字段' })
  }
  const { module, count } = body as Record<string, unknown>
  if (typeof module !== 'string' || !isXingceModuleCode(module)) {
    throw new HTTPException(400, { message: `module 必须是行测六模块编码之一（${XINGCE_MODULE_CODES.join('/')}）` })
  }
  if (count !== undefined) {
    if (typeof count !== 'number' || !ALLOWED_QUESTION_COUNTS.includes(count)) {
      throw new HTTPException(400, { message: `count 必须是 ${ALLOWED_QUESTION_COUNTS.join('/')} 之一` })
    }
  }
  return { module, count: count ?? DEFAULT_QUESTION_COUNT }
}

/**
 * 抽题（T1-08 共识策略，两条查询实现，题目序 = 抽取序——未做过的在前）：
 * 1. 未做过优先：该模块题目中 NOT EXISTS 该用户 practice_records，随机取 count 道；
 * 2. 不足补齐：shortfall = count - 已取数，再取「做过」的题，
 *    按最近作答时间最旧优先（MAX(practice_records.created_at) ASC）随机并列。
 */
async function selectQuestionIds(
  db: DbClient,
  userId: number,
  moduleIds: number[],
  count: number,
): Promise<number[]> {
  const freshRows = await db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        inArray(questions.moduleId, moduleIds),
        notExists(
          db
            .select({ one: sql`1` })
            .from(practiceRecords)
            .where(and(eq(practiceRecords.userId, userId), eq(practiceRecords.questionId, questions.id))),
        ),
      ),
    )
    .orderBy(sql`RANDOM()`)
    .limit(count)
  const selected = freshRows.map((row) => row.id)

  const shortfall = count - selected.length
  if (shortfall > 0) {
    const doneRows = await db
      .select({ id: questions.id })
      .from(questions)
      .innerJoin(
        practiceRecords,
        and(eq(practiceRecords.questionId, questions.id), eq(practiceRecords.userId, userId)),
      )
      .where(inArray(questions.moduleId, moduleIds))
      .groupBy(questions.id)
      .orderBy(asc(sql`MAX(${practiceRecords.createdAt})`), sql`RANDOM()`)
      .limit(shortfall)
    selected.push(...doneRows.map((row) => row.id))
  }
  return selected
}

/** 题目行的对外投影输入（GET/POST 共用；answer/analysis 刻意不取——服务端判分共识） */
interface QuestionRow {
  id: number
  kind: QuestionKind
  stem: RichContent
  options: QuestionOption[]
}

/** 按 questionIds 批量取题目行，映射 id → 行（缺失的悬空 id 由调用方跳过） */
async function fetchQuestionRows(db: DbClient, questionIds: number[]): Promise<Map<number, QuestionRow>> {
  if (questionIds.length === 0) {
    return new Map()
  }
  const rows = await db
    .select({ id: questions.id, kind: questions.kind, stem: questions.stem, options: questions.options })
    .from(questions)
    .where(inArray(questions.id, questionIds))
  return new Map(rows.map((row) => [row.id, row]))
}

/** 会话内已答回显投影（PracticeAnsweredInfo 的库侧形状） */
interface AnsweredRecord {
  answer: string
  isCorrect: boolean
  isTimeout: boolean
  durationMs: number
}

/**
 * 取会话内各题的最近一条作答记录（append-only 表，同题多次作答取 created_at/id 最大者），
 * 映射 questionId → 记录；判分端点（T1-08c）落库，本域只读既有行做续做回显。
 */
async function fetchLatestRecordsByQuestion(
  db: DbClient,
  userId: number,
  sessionId: number,
  questionIds: number[],
): Promise<Map<number, AnsweredRecord>> {
  const map = new Map<number, AnsweredRecord>()
  if (questionIds.length === 0) {
    return map
  }
  const rows = await db
    .select({
      questionId: practiceRecords.questionId,
      answer: practiceRecords.answer,
      isCorrect: practiceRecords.isCorrect,
      isTimeout: practiceRecords.isTimeout,
      durationMs: practiceRecords.durationMs,
    })
    .from(practiceRecords)
    .where(
      and(
        eq(practiceRecords.userId, userId),
        // practice_records.session_id 挂 practice_sessions.id 的字符串形式（ADR-0009 两表衔接形态）
        eq(practiceRecords.sessionId, String(sessionId)),
        inArray(practiceRecords.questionId, questionIds),
      ),
    )
    .orderBy(asc(practiceRecords.createdAt), asc(practiceRecords.id))
  // 升序遍历逐题覆盖：同题多条时最终保留 created_at/id 最大（最近）的一条
  for (const row of rows) {
    map.set(row.questionId, {
      answer: row.answer,
      isCorrect: row.isCorrect,
      isTimeout: row.isTimeout,
      durationMs: row.durationMs,
    })
  }
  return map
}

/** 图片段 path 投影：仅 KEYED 形态拼为 /api/img 绝对 URL，其余原样（见 IMAGE_KEY_PATTERN 注释） */
function projectImagePath(path: string, requestUrl: string): string {
  return IMAGE_KEY_PATTERN.test(path) ? new URL(`/api/img/${path}`, requestUrl).href : path
}

/** RichContent 投影：text 段原样，image 段按 KEYED 形态投影 path（纯函数，返回新数组不改库读出对象） */
function projectRichContent(content: RichContent, requestUrl: string): RichContent {
  return content.map((segment) =>
    segment.type === 'image' ? { ...segment, path: projectImagePath(segment.path, requestUrl) } : segment,
  )
}

/** 题目行 → PracticeQuestionDto 列表：序 = questionIds 序，answered 挂续做回显（无记录 null） */
function toQuestionDtos(
  questionIds: number[],
  questionRows: Map<number, QuestionRow>,
  records: Map<number, AnsweredRecord>,
  requestUrl: string,
): PracticeQuestionDto[] {
  const dtos: PracticeQuestionDto[] = []
  for (const id of questionIds) {
    const row = questionRows.get(id)
    // 悬空 id（题目行被内容重删）跳过；total 仍按 questionIds 清单长度计
    if (row === undefined) {
      continue
    }
    dtos.push({
      id: row.id,
      kind: row.kind,
      stem: projectRichContent(row.stem, requestUrl),
      options: row.options.map((option) => ({
        key: option.key,
        content: projectRichContent(option.content, requestUrl),
      })),
      answered: records.get(id) ?? null,
    })
  }
  return dtos
}

export const practiceRoute = new Hono<AppEnv>()

// 本域无公开端点：三端点一律经 requireAuth（401 由组合根收敛为 unauthorized 信封）
practiceRoute.use(requireAuth)

practiceRoute.post('/sessions', async (c) => {
  const request = parseCreateRequest(await readJsonBody(c))
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 模块解析：moduleCode 为稳定自然键（ADR-0009：会话表故意不设外键），按 code 查 modules 行
  const moduleRows = await db.select({ id: modules.id }).from(modules).where(eq(modules.code, request.module))
  const moduleIds = moduleRows.map((row) => row.id)
  if (moduleIds.length === 0) {
    throw new HTTPException(400, { message: `模块 ${request.module} 暂无题目` })
  }

  // 抽题：模块可用题目为 0（未做过与做过均无）→ 400；不足 count 时按实际数建会话（不报错）
  const questionIds = await selectQuestionIds(db, authUser.id, moduleIds, request.count)
  if (questionIds.length === 0) {
    throw new HTTPException(400, { message: `模块 ${request.module} 暂无题目` })
  }

  const inserted = await db
    .insert(practiceSessions)
    .values({ userId: authUser.id, mode: 'module', moduleCode: request.module, questionIds })
    .returning({ id: practiceSessions.id, status: practiceSessions.status })
  const session = inserted[0]

  // 新会话不可能有作答记录（session id 刚生成），answered 全 null、answeredCount 恒 0
  const questionRows = await fetchQuestionRows(db, questionIds)
  const body: PracticeSessionDetail = {
    id: session.id,
    mode: 'module',
    moduleCode: request.module,
    status: session.status,
    total: questionIds.length,
    answeredCount: 0,
    questions: toQuestionDtos(questionIds, questionRows, new Map(), c.req.url),
  }
  return c.json(body, 201)
})

practiceRoute.get('/sessions/:id', async (c) => {
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 非数字 id 一律 404（与「不存在」同文案，不区分原因）
  const idParam = c.req.param('id')
  if (!/^\d+$/.test(idParam)) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  // 归属条件并入查询：不存在与不属于当前用户同回 404（防存在性探测）；
  // 任意 status 均可取详情（finished/abandoned 供前端展示完成态）
  const sessionRows = await db
    .select()
    .from(practiceSessions)
    .where(and(eq(practiceSessions.id, Number(idParam)), eq(practiceSessions.userId, authUser.id)))
  const session = sessionRows[0]
  if (session === undefined) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  const questionIds = session.questionIds
  const questionRows = await fetchQuestionRows(db, questionIds)
  const records = await fetchLatestRecordsByQuestion(db, authUser.id, session.id, questionIds)
  const body: PracticeSessionDetail = {
    id: session.id,
    mode: session.mode,
    moduleCode: session.moduleCode,
    status: session.status,
    total: questionIds.length,
    // 已答题目去重数 = 该会话落在题目清单内的最近记录条数（Map 以 questionId 为键天然去重）
    answeredCount: records.size,
    questions: toQuestionDtos(questionIds, questionRows, records, c.req.url),
  }
  return c.json(body, 200)
})

practiceRoute.get('/sessions', async (c) => {
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 活动会话不限并存：列表只列 in_progress（finished/abandoned 经详情端点按 id 取）
  const sessions = await db
    .select()
    .from(practiceSessions)
    .where(and(eq(practiceSessions.userId, authUser.id), eq(practiceSessions.status, 'in_progress')))
    // id 倒序兜底：同毫秒插入的并列会话保持稳定序（createdAt 为毫秒精度 ISO 文本）
    .orderBy(desc(practiceSessions.createdAt), desc(practiceSessions.id))

  // 会话内已答题目数：practice_records 按 session 聚合去重题目数（sessionId 为 TEXT 衔接形态）
  const answeredCounts = new Map<string, number>()
  if (sessions.length > 0) {
    const sessionIdStrings = sessions.map((session) => String(session.id))
    const countRows = await db
      .select({ sessionId: practiceRecords.sessionId, answered: countDistinct(practiceRecords.questionId) })
      .from(practiceRecords)
      .where(and(eq(practiceRecords.userId, authUser.id), inArray(practiceRecords.sessionId, sessionIdStrings)))
      .groupBy(practiceRecords.sessionId)
    for (const row of countRows) {
      if (row.sessionId !== null) {
        answeredCounts.set(row.sessionId, row.answered)
      }
    }
  }

  const body: PracticeSessionSummary[] = sessions.map((session) => ({
    id: session.id,
    mode: session.mode,
    moduleCode: session.moduleCode,
    status: session.status,
    total: session.questionIds.length,
    answeredCount: answeredCounts.get(String(session.id)) ?? 0,
    createdAt: session.createdAt,
  }))
  return c.json(body, 200)
})
