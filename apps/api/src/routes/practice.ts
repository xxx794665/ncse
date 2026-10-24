import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { and, asc, countDistinct, desc, eq, inArray, notExists, sql } from 'drizzle-orm'
import { DEFAULT_BLUEPRINT, deriveQuestionTimeLimit } from '@ncse/shared'
import type {
  PracticeQuestionDto,
  PracticeSessionDetail,
  PracticeSessionStatus,
  PracticeSessionSummary,
  QuestionKind,
  QuestionOption,
  RichContent,
  SubmitPracticeAnswerResponse,
  WrongBookRedoSource,
  XingceModuleCode,
} from '@ncse/shared'
import { createDb, type DbClient } from '../db'
import { modules, practiceRecords, practiceSessions, questions, wrongBook } from '../db/schema'
import { requireAuth } from '../auth/middleware'
import { projectRichContent } from './rich-content-project'
import { applyWrongBookStateMachine } from './wrong-book-machine'
import type { AppEnv } from '../types'

/**
 * 专项刷题·练习会话域路由（T1-08b/08c/10a，挂载于 /api/practice，见 src/routes/api.ts）：
 * - POST /sessions：建会话（判别联合，mode 省缺 = 'module' 向后兼容）——
 *   module 分支按模块抽题（未做过优先、不足按最近作答最旧补齐）；
 *   wrong_redo 分支按错题本/难点本在册条目建重做会话（T1-10a：题目序 = updatedAt 倒序，
 *   最近变化在前；moduleCode null → 判分不判超时）；201 返回会话详情；
 * - GET /sessions/:id：会话详情（题目富片段不含答案/解析——服务端判分共识；图片段投影 /api/img URL）；
 * - GET /sessions：当前用户活动会话列表（只列 in_progress，createdAt 倒序）；
 * - POST /sessions/:id/answers：判分（practice_records append-only 落库 + 错题本状态机 ADR-0010
 *   + 会话 finished 判定 ADR-0009），correctAnswer/analysis 仅判分后回发。
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

/** 会话 404 文案：不存在与不属于当前用户同一句（防存在性探测） */
const SESSION_NOT_FOUND_MESSAGE = '会话不存在'

/** durationMs 合法上限（毫秒）：24 小时，防把时间戳等荒谬值当用时落库 */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000

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

/**
 * 建会话入参的解析结果（判别联合，与 shared CreatePracticeSessionRequest 两分支同构；
 * count 已定缺省）。module 分支省缺 mode 的旧形状与显式 mode='module' 均归入 module 分支。
 */
type ParsedCreateRequest =
  | { mode: 'module'; module: XingceModuleCode; count: number }
  | { mode: 'wrong_redo'; source: WrongBookRedoSource; count: number }

/** wrong_redo 分支的 source 白名单（与 shared WrongBookRedoSource 对齐，两端勿单方扩值） */
const REDO_SOURCES: readonly WrongBookRedoSource[] = ['active', 'hard']

/** source 值收窄：是否为两个重做来源之一 */
function isRedoSource(value: string): value is WrongBookRedoSource {
  return (REDO_SOURCES as readonly string[]).includes(value)
}

/** 解析建会话入参：mode 收敛（省缺 = 'module'）、分支字段与 count 校验；不合法抛 400 */
function parseCreateRequest(body: unknown): ParsedCreateRequest {
  if (typeof body !== 'object' || body === null) {
    throw new HTTPException(400, { message: '请求体须为 JSON 对象，且含 module 字符串字段' })
  }
  const { mode, module, source, count } = body as Record<string, unknown>

  // mode 省缺 = 'module'（向后兼容：既有 web 调用与全部既有测试不传 mode）；非法值拒绝
  if (mode !== undefined && mode !== 'module' && mode !== 'wrong_redo') {
    throw new HTTPException(400, { message: 'mode 必须是 module 或 wrong_redo（字符串；省缺视同 module）' })
  }

  if (count !== undefined) {
    if (typeof count !== 'number' || !ALLOWED_QUESTION_COUNTS.includes(count)) {
      throw new HTTPException(400, { message: `count 必须是 ${ALLOWED_QUESTION_COUNTS.join('/')} 之一` })
    }
  }
  const questionCount = count ?? DEFAULT_QUESTION_COUNT

  if (mode === 'wrong_redo') {
    if (typeof source !== 'string' || !isRedoSource(source)) {
      throw new HTTPException(400, { message: `source 必须是 ${REDO_SOURCES.join(' 或 ')}（字符串）` })
    }
    return { mode: 'wrong_redo', source, count: questionCount }
  }

  // module 分支（mode 省缺或显式 'module'）
  if (typeof module !== 'string' || !isXingceModuleCode(module)) {
    throw new HTTPException(400, { message: `module 必须是行测六模块编码之一（${XINGCE_MODULE_CODES.join('/')}）` })
  }
  return { mode: 'module', module, count: questionCount }
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

/** 判分题目行（answer/analysis/options——仅判分端点取用，不进会话详情投影） */
interface GradingQuestionRow {
  answer: string
  analysis: RichContent
  options: QuestionOption[]
}

/** 取单题判分行（undefined = 悬空 id：清单内 id 但题目行已被内容重删的罕见态） */
async function fetchGradingQuestionRow(db: DbClient, questionId: number): Promise<GradingQuestionRow | undefined> {
  const rows = await db
    .select({ answer: questions.answer, analysis: questions.analysis, options: questions.options })
    .from(questions)
    .where(eq(questions.id, questionId))
  return rows[0]
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

/** 题目行 → PracticeQuestionDto 列表：序 = questionIds 序，answered 挂续做回显（无记录 null）；
 * 图片段投影复用共享 rich-content-project.ts（T2-01b 抽出，练习与模考两域共用） */
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

/** practice_sessions 整行（判分端点与 finished 判定共用的库侧形状） */
type PracticeSessionRow = typeof practiceSessions.$inferSelect

/**
 * 会话是否已全部作答（finished 判定，ADR-0009）：实际存在的题目数 == 本会话有作答记录的题目数
 * （两 Map 均以 questionId 为键去重；清单内悬空 id 不阻塞完成——题删记录亦级联删）。
 */
async function isSessionFullyAnswered(db: DbClient, userId: number, session: PracticeSessionRow): Promise<boolean> {
  const questionRows = await fetchQuestionRows(db, session.questionIds)
  const records = await fetchLatestRecordsByQuestion(db, userId, session.id, session.questionIds)
  return questionRows.size === records.size
}

export const practiceRoute = new Hono<AppEnv>()

// 本域无公开端点：三端点一律经 requireAuth（401 由组合根收敛为 unauthorized 信封）
practiceRoute.use(requireAuth)

/**
 * 错题重做抽题（T1-10a）：当前用户 wrong_book 中 status=source 的在册条目，
 * 取 updatedAt 倒序、id 倒序并列稳定的前 count 个 questionId——题目序 = 该序（最近变化在前）；
 * user+question 唯一保证清单无重复。eliminated 软移除条目不进 source 白名单，天然排除。
 */
async function selectWrongRedoQuestionIds(
  db: DbClient,
  userId: number,
  source: WrongBookRedoSource,
  count: number,
): Promise<number[]> {
  const rows = await db
    .select({ questionId: wrongBook.questionId })
    .from(wrongBook)
    .where(and(eq(wrongBook.userId, userId), eq(wrongBook.status, source)))
    .orderBy(desc(wrongBook.updatedAt), desc(wrongBook.id))
    .limit(count)
  return rows.map((row) => row.questionId)
}

practiceRoute.post('/sessions', async (c) => {
  const request = parseCreateRequest(await readJsonBody(c))
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  /** 会话模式与模块编码（两分支唯一差异；wrong_redo 恒 moduleCode null → 判分不判超时） */
  let mode: 'module' | 'wrong_redo'
  let moduleCode: XingceModuleCode | null
  /** 会话题目清单（序 = 抽取序：module 为未做过优先，wrong_redo 为 updatedAt 倒序） */
  let questionIds: number[]

  if (request.mode === 'wrong_redo') {
    mode = 'wrong_redo'
    moduleCode = null
    questionIds = await selectWrongRedoQuestionIds(db, authUser.id, request.source, request.count)
    if (questionIds.length === 0) {
      throw new HTTPException(400, {
        message: request.source === 'active' ? '错题本暂无可重做的题目' : '难点本暂无可重做的题目',
      })
    }
    // 在册条目不足 count 时按实际条数建会话（同模块流惯例，不报错）
  } else {
    mode = 'module'
    moduleCode = request.module

    // 模块解析：moduleCode 为稳定自然键（ADR-0009：会话表故意不设外键），按 code 查 modules 行
    const moduleRows = await db.select({ id: modules.id }).from(modules).where(eq(modules.code, request.module))
    const moduleIds = moduleRows.map((row) => row.id)
    if (moduleIds.length === 0) {
      throw new HTTPException(400, { message: `模块 ${request.module} 暂无题目` })
    }

    // 抽题：模块可用题目为 0（未做过与做过均无）→ 400；不足 count 时按实际数建会话（不报错）
    questionIds = await selectQuestionIds(db, authUser.id, moduleIds, request.count)
    if (questionIds.length === 0) {
      throw new HTTPException(400, { message: `模块 ${request.module} 暂无题目` })
    }
  }

  // 建会话行（两分支共用既有 insert 路径：mode/moduleCode/questionIds 投影与详情/列表 DTO 不需改）
  const inserted = await db
    .insert(practiceSessions)
    .values({ userId: authUser.id, mode, moduleCode, questionIds })
    .returning({ id: practiceSessions.id, status: practiceSessions.status })
  const session = inserted[0]

  // 新会话不可能有作答记录（session id 刚生成），answered 全 null、answeredCount 恒 0
  const questionRows = await fetchQuestionRows(db, questionIds)
  const body: PracticeSessionDetail = {
    id: session.id,
    mode,
    moduleCode,
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

practiceRoute.post('/sessions/:id/answers', async (c) => {
  // 非数字 id 一律 404（与 GET /:id 同构，不区分原因，防存在性探测）
  const idParam = c.req.param('id')
  if (!/^\d+$/.test(idParam)) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 归属条件并入查询（与 GET /:id 同构）：不存在与非本人同回 404；
  // 任意 status 均可作答（append-only 语义：finished/abandoned 重答不拦，多落一行记录）
  const sessionRows = await db
    .select()
    .from(practiceSessions)
    .where(and(eq(practiceSessions.id, Number(idParam)), eq(practiceSessions.userId, authUser.id)))
  const session = sessionRows[0]
  if (session === undefined) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  // 入参校验序：questionId（形状 → 会话成员）→ 题目行存在（404）→ answer 选项合法 → durationMs 区间
  const requestBody = await readJsonBody(c)
  if (typeof requestBody !== 'object' || requestBody === null) {
    throw new HTTPException(400, { message: '请求体须为 JSON 对象，且含 questionId、answer、durationMs 字段' })
  }
  const { questionId, answer, durationMs } = requestBody as Record<string, unknown>

  if (typeof questionId !== 'number' || !Number.isSafeInteger(questionId) || questionId <= 0) {
    throw new HTTPException(400, { message: 'questionId 必须是正整数' })
  }
  if (!session.questionIds.includes(questionId)) {
    throw new HTTPException(400, { message: '题目不在会话内' })
  }

  // 题目行（answer/analysis/options）：answer 选项校验与判分依据
  const questionRow = await fetchGradingQuestionRow(db, questionId)
  if (questionRow === undefined) {
    throw new HTTPException(404, { message: '题目不存在' })
  }

  // answer 限定为该题选项键：防无效作答（如 'E'）混入「判错」语义
  if (typeof answer !== 'string' || !questionRow.options.some((option) => option.key === answer)) {
    throw new HTTPException(400, { message: 'answer 必须是题目选项键之一' })
  }
  if (
    typeof durationMs !== 'number' ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs >= MAX_DURATION_MS
  ) {
    throw new HTTPException(400, { message: `durationMs 必须是 0 到 ${MAX_DURATION_MS} 之间的整数（毫秒）` })
  }

  // 服务端判分：单选为选项键比对（答案不随题面下发，判分后才回发——服务端判分共识）
  const isCorrect = answer === questionRow.answer

  // 超时推导：默认标准卷蓝图 × 会话模块的每题时限，严格大于判超时（等于时限不超时）；
  // moduleCode 为 null（非 module 模式）或蓝图未含该模块 → 不判超时
  const timeLimitSeconds =
    session.moduleCode === null ? undefined : deriveQuestionTimeLimit(DEFAULT_BLUEPRINT, session.moduleCode)
  const isTimeout = timeLimitSeconds !== undefined && durationMs > timeLimitSeconds * 1000

  // 作答记录落库（append-only：同题重复提交每次一行，不去重不覆盖；mode/sessionId 取自会话）
  await db.insert(practiceRecords).values({
    userId: authUser.id,
    questionId,
    answer,
    isCorrect,
    durationMs,
    isTimeout,
    mode: session.mode,
    sessionId: String(session.id),
  })

  // 错题本状态机（ADR-0010，共享实现见 wrong-book-machine.ts）：答错复活在册，答对在册累加重做与连对
  const wrongBookContext = await applyWrongBookStateMachine(db, authUser.id, questionId, isCorrect)

  // 会话 finished 判定（ADR-0009）：全部作答后翻状态（updatedAt 显式给值，同上不依赖 $onUpdate）
  let sessionStatus: PracticeSessionStatus = session.status
  if (await isSessionFullyAnswered(db, authUser.id, session)) {
    await db
      .update(practiceSessions)
      .set({ status: 'finished', updatedAt: new Date().toISOString() })
      .where(eq(practiceSessions.id, session.id))
    sessionStatus = 'finished'
  }

  const responseBody: SubmitPracticeAnswerResponse = {
    questionId,
    isCorrect,
    isTimeout,
    correctAnswer: questionRow.answer,
    analysis: projectRichContent(questionRow.analysis, c.req.url),
    wrongBook: wrongBookContext,
    sessionStatus,
  }
  return c.json(responseBody, 200)
})
