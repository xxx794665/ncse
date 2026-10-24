import { Hono } from 'hono'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  classifyPaperCompleteness,
  DEFAULT_BLUEPRINT_CODE,
  deriveMockTotalMinutes,
  deriveQuestionTimeLimits,
  MOCK_MAX_DURATION_MS,
  MOCK_TOTAL_MINUTES_MAX,
  MOCK_TOTAL_MINUTES_MIN,
} from '@ncse/shared'
import type {
  BlueprintModulePlan,
  ExamBlueprint,
  MockAnsweredInfo,
  MockModuleReport,
  MockQuestionDto,
  MockReportQuestionItem,
  MockSessionDetail,
  MockSessionReport,
  MockSessionStatus,
  MockSessionSummary,
  PaperSummary,
  QuestionKind,
  QuestionOption,
  RichContent,
  SubmitMockAnswerResponse,
  UpdateMockTimerResponse,
  XingceModuleCode,
} from '@ncse/shared'
import { createDb, type DbClient } from '../db'
import {
  blueprintModules,
  blueprints,
  mockAnswers,
  mockSessions,
  modules,
  papers,
  questionPapers,
  questions,
  subjects,
} from '../db/schema'
import { requireAuth } from '../auth/middleware'
import { projectRichContent } from './rich-content-project'
import { applyWrongBookStateMachine } from './wrong-book-machine'
import type { AppEnv } from '../types'

/**
 * 整卷模拟·模考会话域路由（T2-01b，挂载于 /api/mock，见 src/routes/api.ts）：
 * - POST /sessions：开考建会话（D3/D7）——固化卷题集快照（question_papers 按 sequence 序）
 *   与整卷时长（缺省 deriveMockTotalMinutes 推导，显式值钳 [5,600]），201 返回会话详情；
 * - GET /sessions：当前用户 in_progress 会话列表（createdAt 倒序，续考入口）；
 * - GET /sessions/:id：会话详情（任意 status 可取，交卷后回看）——题目富片段不含答案/解析
 *   （D4：作答中不下发，交卷统一判分）、mock_answers 已答回显仅 answer+durationMs（判分字段不下发）；
 * - POST /sessions/:id/answers：逐题作答 upsert（每会话每题一行，交卷前可改答案——与练习
 *   append-only 不同；durationMs 取 max 防回退；已交卷会话拒绝，真实考试交卷即定卷）；
 * - POST /sessions/:id/timer：计时上报（D6 累计绝对值口径，服务端 max 防回退，不做墙钟推导）；
 * - POST /sessions/:id/submit：交卷统一判分（D4）——逐已作答行落 mock_answers.isCorrect 与
 *   isTimeout（D5 超时按蓝图每题时限严格大于判，与练习判分同口径；蓝图行缺失/空明细防御性
 *   全不判超时）、答错题联动错题本状态机（D8 复用共享 wrong-book-machine.ts；答对/未答不联动
 *   ——模考答对非重做场景）、会话翻 submitted（交卷即定卷，重复交卷拒绝）；模考不写
 *   practice_records（D9，mock_answers 独立承载）；无请求体入参，响应即成绩单（与 report 同形状）；
 * - GET /sessions/:id/report：成绩单聚合（summary/modules/questions 全部从库重算，交卷后可随时
 *   回看；逐题项不含正确答案与解析——展示解析走既有题目详情或后续需求）。
 * 全端点 requireAuth；业务错误一律抛 HTTPException（中文 message），
 * 由组合根 onError 统一收敛为 ApiErrorBody（沿用既有错误码，不新增）。
 */

/** 会话 404 文案：不存在与不属于当前用户同一句（防存在性探测） */
const SESSION_NOT_FOUND_MESSAGE = '会话不存在'

/** 试卷 404 文案：建会话时试卷行不存在（防存在性探测，不区分原因） */
const PAPER_NOT_FOUND_MESSAGE = '试卷不存在'

/** 蓝图种子缺失文案：部署前置缺失属服务端错误（500），非用户输入问题 */
const BLUEPRINT_SEED_MISSING_MESSAGE = '蓝图种子未初始化，请先执行蓝图种子导入'

/** 已交卷会话的作答拒绝文案（模考语义：交卷即定卷，submitted/abandoned 均拒——与练习 append-anytime 不同） */
const SESSION_CLOSED_ANSWER_MESSAGE = '会话已交卷，不可再作答'

/** 已交卷会话的计时上报拒绝文案（同上拒绝语义，动作不同故分开文案求准确） */
const SESSION_CLOSED_TIMER_MESSAGE = '会话已交卷，不可更新计时'

/** 重复交卷拒绝文案（模考语义：交卷即定卷，submitted/abandoned 均拒——防判分与错题本重复副作用） */
const SESSION_ALREADY_SUBMITTED_MESSAGE = '会话已交卷'

/** 未交卷会话的成绩单拒绝文案（成绩单只对已定卷会话有意义——判分未落，聚合无依据） */
const SESSION_NOT_SUBMITTED_MESSAGE = '会话未交卷'

/** 解析 JSON 请求体；不可解析（非 JSON / 非法编码）抛 400（与 auth.ts 同构） */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new HTTPException(400, { message: '请求体必须是合法 JSON' })
  }
}

/** 建会话入参解析结果（totalMinutes 已定缺省） */
interface ParsedCreateRequest {
  paperId: number
  totalMinutes: number | undefined
}

/** 解析建会话入参：paperId 正整数、totalMinutes 可选但显式值须为 [5,600] 内整数；不合法抛 400 */
function parseCreateRequest(body: unknown): ParsedCreateRequest {
  if (typeof body !== 'object' || body === null) {
    throw new HTTPException(400, { message: '请求体须为 JSON 对象，且含 paperId 数字字段' })
  }
  const { paperId, totalMinutes } = body as Record<string, unknown>

  if (typeof paperId !== 'number' || !Number.isSafeInteger(paperId) || paperId <= 0) {
    throw new HTTPException(400, { message: 'paperId 必须是正整数' })
  }
  if (
    totalMinutes !== undefined &&
    (typeof totalMinutes !== 'number' ||
      !Number.isSafeInteger(totalMinutes) ||
      totalMinutes < MOCK_TOTAL_MINUTES_MIN ||
      totalMinutes > MOCK_TOTAL_MINUTES_MAX)
  ) {
    throw new HTTPException(400, {
      message: `totalMinutes 必须是 ${MOCK_TOTAL_MINUTES_MIN} 到 ${MOCK_TOTAL_MINUTES_MAX} 之间的整数（分钟），或省缺按题数推导`,
    })
  }
  return { paperId, totalMinutes }
}

/** 试卷行对外投影输入（PaperSummary 的库侧形状；建会话与详情共用） */
interface PaperRow {
  id: number
  name: string
  year: number | null
  region: string | null
  paperType: string | null
  questionCount: number
}

/** PaperRow → PaperSummary（completeness 由 shared 同一口径派生，与 /api/papers 一致） */
function toPaperSummary(row: PaperRow): PaperSummary {
  return { ...row, completeness: classifyPaperCompleteness(row.questionCount) }
}

/**
 * D1 绑定参数分批上限：Cloudflare D1 每查询最多 100 个绑定参数（线上实测 135 题整卷的
 * inArray 即触限报「Failed query」；本地 miniflare 模拟无此限制，集成测试防不住——
 * 整卷快照 100+ 题的 inArray 查询必须分批，批大小为 inArray 之外的其余绑定参数留余量）。
 */
const D1_PARAM_BATCH_SIZE = 90

/** 按固定批大小切分列表（尾批可短；空列表返回空批数组，调用方循环天然短路） */
function chunked<T>(list: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size))
  }
  return chunks
}

/** 模考题目行的对外投影输入（answer/analysis 刻意不取——D4 交卷统一判分） */
interface MockQuestionRow {
  id: number
  moduleCode: XingceModuleCode
  kind: QuestionKind
  stem: RichContent
  options: QuestionOption[]
}

/** 按题目清单批量取题目行并映射 id → 行（innerJoin modules 取 moduleCode；
 * 模块行随内容重删级联删题，悬空 id 由调用方跳过。
 * 整卷 100+ 题 → inArray 分批（D1 100 绑定参数上限，见 D1_PARAM_BATCH_SIZE），多批结果合并） */
async function fetchQuestionRows(db: DbClient, questionIds: number[]): Promise<Map<number, MockQuestionRow>> {
  const map = new Map<number, MockQuestionRow>()
  for (const batch of chunked(questionIds, D1_PARAM_BATCH_SIZE)) {
    const rows = await db
      .select({
        id: questions.id,
        moduleCode: modules.code,
        kind: questions.kind,
        stem: questions.stem,
        options: questions.options,
      })
      .from(questions)
      .innerJoin(modules, eq(modules.id, questions.moduleId))
      .where(inArray(questions.id, batch))
    for (const row of rows) {
      map.set(
        row.id,
        // modules.code 库层为无域类型的 TEXT（M1 内容域即行测模块编码），读取处按域值断言
        //（与 practice_sessions.moduleCode 的 $type<XingceModuleCode> 同一约定，见 wrong-book.ts）
        { ...row, moduleCode: row.moduleCode as XingceModuleCode },
      )
    }
  }
  return map
}

/** 作答/计时/交卷/成绩单端点共用的会话头取行（status 与 questionIds/blueprintId 即校验与判分所需的全部列） */
interface SessionWriteRow {
  id: number
  blueprintId: number
  questionIds: number[]
  status: MockSessionStatus
}

/**
 * 归属条件并入查询取会话头（不存在与不属于当前用户同回 404，防存在性探测）；
 * 作答/计时上报/交卷/成绩单四端点共用（与 GET /:id 的详情取行同构，但只取写路径所需列）。
 */
async function fetchSessionForWrite(db: DbClient, sessionId: number, userId: number): Promise<SessionWriteRow | undefined> {
  const rows = await db
    .select({
      id: mockSessions.id,
      blueprintId: mockSessions.blueprintId,
      questionIds: mockSessions.questionIds,
      status: mockSessions.status,
    })
    .from(mockSessions)
    .where(and(eq(mockSessions.id, sessionId), eq(mockSessions.userId, userId)))
  return rows[0]
}

/**
 * 取单题选项白名单行（作答端点选项键校验用；undefined = 悬空 id：快照内 id 但题目行
 * 已被内容重删的罕见态）。answer/analysis 刻意不取——本域作答中不判分（D4），
 * 故不复用 practice.ts 的 fetchGradingQuestionRow（其取判分三列且为私有，本域重写更小）。
 */
async function fetchQuestionOptionsRow(db: DbClient, questionId: number): Promise<{ options: QuestionOption[] } | undefined> {
  const rows = await db.select({ options: questions.options }).from(questions).where(eq(questions.id, questionId))
  return rows[0]
}

/**
 * 取会话内已答题的作答行，映射 questionId → 回显信息。
 * 只取 answer+durationMs（D4：判分字段 isCorrect/isTimeout 不下发——行内交卷判分落值也不回显）；
 * answer 为空的行（作答端点只写有答案的行，库缺省可空——防御脏数据）不视为已答。
 */
async function fetchAnsweredByQuestion(
  db: DbClient,
  sessionId: number,
  questionIds: number[],
): Promise<Map<number, MockAnsweredInfo>> {
  const map = new Map<number, MockAnsweredInfo>()
  for (const batch of chunked(questionIds, D1_PARAM_BATCH_SIZE)) {
    const rows = await db
      .select({ questionId: mockAnswers.questionId, answer: mockAnswers.answer, durationMs: mockAnswers.durationMs })
      .from(mockAnswers)
      .where(and(eq(mockAnswers.sessionId, sessionId), inArray(mockAnswers.questionId, batch)))
    for (const row of rows) {
      if (row.answer !== null) {
        map.set(row.questionId, { answer: row.answer, durationMs: row.durationMs })
      }
    }
  }
  return map
}

/** 题目行 → MockQuestionDto 列表：序 = questionIds 快照序，悬空 id 跳过（total 仍按清单长度计），
 * 图片段投影复用共享 rich-content-project.ts */
function toQuestionDtos(
  questionIds: number[],
  questionRows: Map<number, MockQuestionRow>,
  answeredByQuestion: Map<number, MockAnsweredInfo>,
  requestUrl: string,
): MockQuestionDto[] {
  const dtos: MockQuestionDto[] = []
  for (const id of questionIds) {
    const row = questionRows.get(id)
    if (row === undefined) {
      continue
    }
    dtos.push({
      id: row.id,
      moduleCode: row.moduleCode,
      kind: row.kind,
      stem: projectRichContent(row.stem, requestUrl),
      options: row.options.map((option) => ({
        key: option.key,
        content: projectRichContent(option.content, requestUrl),
      })),
      answered: answeredByQuestion.get(id) ?? null,
    })
  }
  return dtos
}

/** 交卷判分/成绩单共用的题目行投影（answer 判分比对，moduleCode 模块归属与超时推导；
 * 成绩单只消费 moduleCode——answer 刻意不下发，见 MockReportQuestionItem 边界注释） */
interface GradingQuestionRow {
  moduleCode: XingceModuleCode
  answer: string
}

/** 批量取题目判分行（innerJoin modules 取 moduleCode），映射 id → 行；悬空 id 不入映射
 * （模块行随内容重删级联删题——判分与统计由调用方按映射缺失跳过）。
 * 整卷 100+ 题 → inArray 分批（D1 100 绑定参数上限），多批结果合并 */
async function fetchGradingQuestionRows(db: DbClient, questionIds: number[]): Promise<Map<number, GradingQuestionRow>> {
  const map = new Map<number, GradingQuestionRow>()
  for (const batch of chunked(questionIds, D1_PARAM_BATCH_SIZE)) {
    const rows = await db
      .select({ id: questions.id, moduleCode: modules.code, answer: questions.answer })
      .from(questions)
      .innerJoin(modules, eq(modules.id, questions.moduleId))
      .where(inArray(questions.id, batch))
    for (const row of rows) {
      map.set(
        row.id,
        // modules.code 库层为无域类型的 TEXT，读取处按域值断言（与 fetchQuestionRows 同一约定）
        { moduleCode: row.moduleCode as XingceModuleCode, answer: row.answer },
      )
    }
  }
  return map
}

/** 蓝图模块明细的库侧读取结果（交卷判分超时推导与成绩单模块排序共用） */
interface BlueprintPlanInfo {
  /** 每模块每题时限映射（秒；蓝图行缺失/空明细 → 空映射，全部不判超时） */
  questionTimeLimits: Partial<Record<XingceModuleCode, number>>
  /** 蓝图模块序（成绩单模块分组排序锚；蓝图行缺失/空明细 → 空序） */
  moduleOrder: XingceModuleCode[]
}

/**
 * 从库读蓝图模块明细并经 shared deriveQuestionTimeLimits 推导每题时限映射——推导口径以
 * shared 为唯一权威（库只供数据，勿在此另写 floor 公式）：blueprints join blueprint_modules
 * join modules，序 = blueprint_modules.id（自增即插入序；种子按 ExamBlueprint.modules 序写入）。
 * 蓝图行缺失/空明细（理论不可达——建会话 restrict 保证蓝图行存在、明细由种子保证）：
 * 防御性按空映射处理（全部不判超时、成绩单模块序退化为全字典序）并 console.error，不炸交卷主流程。
 */
async function fetchBlueprintPlanInfo(db: DbClient, blueprintId: number): Promise<BlueprintPlanInfo> {
  const rows = await db
    .select({
      code: blueprints.code,
      name: blueprints.name,
      moduleCode: modules.code,
      questionCount: blueprintModules.questionCount,
      timeLimitMinutes: blueprintModules.timeLimitMinutes,
    })
    .from(blueprints)
    .innerJoin(blueprintModules, eq(blueprintModules.blueprintId, blueprints.id))
    .innerJoin(modules, eq(modules.id, blueprintModules.moduleId))
    .where(eq(blueprints.id, blueprintId))
    .orderBy(asc(blueprintModules.id))
  if (rows.length === 0) {
    console.error(`模考蓝图 id=${blueprintId} 行缺失或无模块明细，判分不标记超时（防御分支，理论不可达）`)
    return { questionTimeLimits: {}, moduleOrder: [] }
  }
  const plans: BlueprintModulePlan[] = rows.map((row) => ({
    module: row.moduleCode as XingceModuleCode,
    questionCount: row.questionCount,
    timeLimitMinutes: row.timeLimitMinutes,
  }))
  // 构造 ExamBlueprint 形状喂 shared 推导（totalMinutes 汇总自洽——推导函数不读该值，但类型要求）
  const blueprint: ExamBlueprint = {
    code: rows[0].code,
    name: rows[0].name,
    totalMinutes: plans.reduce((sum, plan) => sum + plan.timeLimitMinutes, 0),
    modules: plans,
  }
  return { questionTimeLimits: deriveQuestionTimeLimits(blueprint), moduleOrder: plans.map((plan) => plan.module) }
}

/** 成绩单聚合读出的作答行投影（answer 可空——库缺省可空，作答端点只写有答案的行） */
interface ReportAnswerRow {
  questionId: number
  answer: string | null
  isCorrect: boolean | null
  isTimeout: boolean
  durationMs: number
}

/**
 * 成绩单聚合（交卷响应与 GET report 共用；全部从 mock_answers + questions join modules 现读，
 * 不依赖判分时内存态——交卷后可随时重算回看）：
 * - 已答口径 = isCorrect 非空行（交卷后已答行恒已判分；abandoned 未判分行不计入 answered，
 *   但其作答内容仍在 questions 逐题项回显）；
 * - 悬空题目 id 跳过（不计 total，与交卷判分口径一致）；
 * - 模块序 = 蓝图 modules 序，蓝图未含的模块按 code 字典序殿后；
 * - 逐题项不含正确答案与解析（正确答案交卷后回发虽合法，本端点保持克制——展示解析走既有
 *   题目详情或后续需求，见 shared MockReportQuestionItem 注释）。
 */
async function buildSessionReport(
  db: DbClient,
  session: { id: number; questionIds: number[]; blueprintId: number },
): Promise<MockSessionReport> {
  const questionRows = await fetchGradingQuestionRows(db, session.questionIds)
  const answerRows: ReportAnswerRow[] = await db
    .select({
      questionId: mockAnswers.questionId,
      answer: mockAnswers.answer,
      isCorrect: mockAnswers.isCorrect,
      isTimeout: mockAnswers.isTimeout,
      durationMs: mockAnswers.durationMs,
    })
    .from(mockAnswers)
    .where(eq(mockAnswers.sessionId, session.id))
  const answerByQuestion = new Map(answerRows.map((row) => [row.questionId, row]))
  const planInfo = await fetchBlueprintPlanInfo(db, session.blueprintId)

  // 逐题项（序 = questionIds 快照序，悬空跳过）与 summary/分模块聚合一次遍历完成
  const questions: MockReportQuestionItem[] = []
  const moduleAgg = new Map<XingceModuleCode, MockModuleReport>()
  const summary = { total: 0, answered: 0, correct: 0, unanswered: 0, timeoutCount: 0, totalDurationMs: 0 }
  for (const id of session.questionIds) {
    const questionRow = questionRows.get(id)
    if (questionRow === undefined) {
      continue
    }
    const answerRow = answerByQuestion.get(id)
    questions.push({
      questionId: id,
      moduleCode: questionRow.moduleCode,
      answer: answerRow?.answer ?? null,
      isCorrect: answerRow?.isCorrect ?? null,
      isTimeout: answerRow?.isTimeout ?? false,
      durationMs: answerRow?.durationMs ?? 0,
    })

    summary.total += 1
    let moduleReport = moduleAgg.get(questionRow.moduleCode)
    if (moduleReport === undefined) {
      moduleReport = {
        moduleCode: questionRow.moduleCode,
        total: 0,
        answered: 0,
        correct: 0,
        timeoutCount: 0,
        totalDurationMs: 0,
      }
      moduleAgg.set(questionRow.moduleCode, moduleReport)
    }
    moduleReport.total += 1
    // 已答口径 = 已判分行（isCorrect 非空）；聚合四项（answered/correct/timeout/用时）同基
    if (answerRow !== undefined && answerRow.isCorrect !== null) {
      summary.answered += 1
      moduleReport.answered += 1
      if (answerRow.isCorrect) {
        summary.correct += 1
        moduleReport.correct += 1
      }
      if (answerRow.isTimeout) {
        summary.timeoutCount += 1
        moduleReport.timeoutCount += 1
      }
      summary.totalDurationMs += answerRow.durationMs
      moduleReport.totalDurationMs += answerRow.durationMs
    }
  }
  summary.unanswered = summary.total - summary.answered

  // 模块排序：蓝图 modules 序在前，蓝图未含（或蓝图防御性缺失）的模块按 code 字典序殿后
  const moduleOrder = planInfo.moduleOrder
  const orderedModuleCodes = [
    ...moduleOrder.filter((code) => moduleAgg.has(code)),
    ...[...moduleAgg.keys()].filter((code) => !moduleOrder.includes(code)).sort(),
  ]
  const modules: MockModuleReport[] = []
  for (const code of orderedModuleCodes) {
    const moduleReport = moduleAgg.get(code)
    if (moduleReport !== undefined) {
      modules.push(moduleReport)
    }
  }

  return { summary, modules, questions }
}

export const mockRoute = new Hono<AppEnv>()

// 本域无公开端点：三端点一律经 requireAuth（401 由组合根收敛为 unauthorized 信封）
mockRoute.use(requireAuth)

mockRoute.post('/sessions', async (c) => {
  const request = parseCreateRequest(await readJsonBody(c))
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 试卷行（不存在 404；join 无必要——直接取 papers 行，PaperSummary 全列在此）
  const paperRows = await db
    .select({
      id: papers.id,
      name: papers.name,
      year: papers.year,
      region: papers.region,
      paperType: papers.paperType,
      questionCount: papers.questionCount,
    })
    .from(papers)
    .where(eq(papers.id, request.paperId))
  const paper = paperRows[0]
  if (paper === undefined) {
    throw new HTTPException(404, { message: PAPER_NOT_FOUND_MESSAGE })
  }

  // 卷题集快照（D7）：开考时固化 question_papers 卷内序（sequence ASC）
  const questionIdRows = await db
    .select({ questionId: questionPapers.questionId })
    .from(questionPapers)
    .where(eq(questionPapers.paperId, request.paperId))
    .orderBy(asc(questionPapers.sequence))
  const questionIds = questionIdRows.map((row) => row.questionId)
  if (questionIds.length === 0) {
    throw new HTTPException(400, { message: '该试卷无可考题目' })
  }

  // 卷型蓝图（分析锚）：种子写入的行测默认蓝图；部署前置缺失属服务端错误（500）
  const blueprintRows = await db
    .select({ id: blueprints.id })
    .from(blueprints)
    .innerJoin(subjects, eq(subjects.id, blueprints.subjectId))
    .where(and(eq(blueprints.code, DEFAULT_BLUEPRINT_CODE), eq(subjects.code, 'xingce')))
  const blueprintId = blueprintRows[0]?.id
  if (blueprintId === undefined) {
    throw new HTTPException(500, { message: BLUEPRINT_SEED_MISSING_MESSAGE })
  }

  // 建会话行：快照 + 开考锁定时长（缺省按题数推导，D3）落库；elapsedMs/status 走列缺省（0/in_progress）
  const totalMinutes = request.totalMinutes ?? deriveMockTotalMinutes(questionIds.length)
  const inserted = await db
    .insert(mockSessions)
    .values({ userId: authUser.id, blueprintId, paperId: request.paperId, questionIds, totalMinutes })
    .returning({ id: mockSessions.id, status: mockSessions.status })
  const session = inserted[0]

  // 新会话不可能有作答行（session id 刚生成），answered 全 null、answeredCount 恒 0、elapsedMs 恒 0
  const questionRows = await fetchQuestionRows(db, questionIds)
  const body: MockSessionDetail = {
    id: session.id,
    paper: toPaperSummary(paper),
    blueprintCode: DEFAULT_BLUEPRINT_CODE,
    totalMinutes,
    elapsedMs: 0,
    status: session.status,
    total: questionIds.length,
    answeredCount: 0,
    questions: toQuestionDtos(questionIds, questionRows, new Map(), c.req.url),
  }
  return c.json(body, 201)
})

mockRoute.get('/sessions', async (c) => {
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 活动会话不限并存：列表只列 in_progress（submitted/abandoned 经详情端点按 id 取）；
  // paper 行由建会话 restrict 保证存在，innerJoin 取卷名/年份
  const sessions = await db
    .select({
      id: mockSessions.id,
      paperName: papers.name,
      paperYear: papers.year,
      totalMinutes: mockSessions.totalMinutes,
      elapsedMs: mockSessions.elapsedMs,
      status: mockSessions.status,
      questionIds: mockSessions.questionIds,
      createdAt: mockSessions.createdAt,
    })
    .from(mockSessions)
    .innerJoin(papers, eq(papers.id, mockSessions.paperId))
    .where(and(eq(mockSessions.userId, authUser.id), eq(mockSessions.status, 'in_progress')))
    // id 倒序兜底：同毫秒插入的并列会话保持稳定序（createdAt 为毫秒精度 ISO 文本）
    .orderBy(desc(mockSessions.createdAt), desc(mockSessions.id))

  // 会话内已答题数：作答端点只写有答案的行，行存在即已答（按 sessionId 聚合批量查）
  const answeredCounts = new Map<number, number>()
  if (sessions.length > 0) {
    const sessionIds = sessions.map((session) => session.id)
    const countRows = await db
      .select({ sessionId: mockAnswers.sessionId, answered: count() })
      .from(mockAnswers)
      .where(inArray(mockAnswers.sessionId, sessionIds))
      .groupBy(mockAnswers.sessionId)
    for (const row of countRows) {
      answeredCounts.set(row.sessionId, row.answered)
    }
  }

  const body: MockSessionSummary[] = sessions.map((session) => ({
    id: session.id,
    paperName: session.paperName,
    paperYear: session.paperYear,
    totalMinutes: session.totalMinutes,
    elapsedMs: session.elapsedMs,
    status: session.status,
    total: session.questionIds.length,
    answeredCount: answeredCounts.get(session.id) ?? 0,
    createdAt: session.createdAt,
  }))
  return c.json(body, 200)
})

mockRoute.get('/sessions/:id', async (c) => {
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 非数字 id 一律 404（与「不存在」同文案，不区分原因）
  const idParam = c.req.param('id')
  if (!/^\d+$/.test(idParam)) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  // 归属条件并入查询：不存在与不属于当前用户同回 404（防存在性探测）；
  // 任意 status 均可取详情（submitted/abandoned 交卷后回看）；paper/blueprint 行由建会话
  // 双 restrict 保证存在，innerJoin 取卷目录列与蓝图编码
  const sessionRows = await db
    .select({
      id: mockSessions.id,
      questionIds: mockSessions.questionIds,
      totalMinutes: mockSessions.totalMinutes,
      elapsedMs: mockSessions.elapsedMs,
      status: mockSessions.status,
      paperId: papers.id,
      paperName: papers.name,
      paperYear: papers.year,
      paperRegion: papers.region,
      paperType: papers.paperType,
      paperQuestionCount: papers.questionCount,
      blueprintCode: blueprints.code,
    })
    .from(mockSessions)
    .innerJoin(papers, eq(papers.id, mockSessions.paperId))
    .innerJoin(blueprints, eq(blueprints.id, mockSessions.blueprintId))
    .where(and(eq(mockSessions.id, Number(idParam)), eq(mockSessions.userId, authUser.id)))
  const session = sessionRows[0]
  if (session === undefined) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  const questionIds = session.questionIds
  const questionRows = await fetchQuestionRows(db, questionIds)
  const answeredByQuestion = await fetchAnsweredByQuestion(db, session.id, questionIds)

  // 已答题数 = 该会话 mock_answers 行数（行存在即已答；与列表口径一致）
  const answeredCountRows = await db
    .select({ answered: count() })
    .from(mockAnswers)
    .where(eq(mockAnswers.sessionId, session.id))
  const answeredCount = answeredCountRows[0]?.answered ?? 0

  const body: MockSessionDetail = {
    id: session.id,
    paper: toPaperSummary({
      id: session.paperId,
      name: session.paperName,
      year: session.paperYear,
      region: session.paperRegion,
      paperType: session.paperType,
      questionCount: session.paperQuestionCount,
    }),
    blueprintCode: session.blueprintCode,
    totalMinutes: session.totalMinutes,
    elapsedMs: session.elapsedMs,
    status: session.status,
    total: questionIds.length,
    answeredCount,
    questions: toQuestionDtos(questionIds, questionRows, answeredByQuestion, c.req.url),
  }
  return c.json(body, 200)
})

mockRoute.post('/sessions/:id/answers', async (c) => {
  // 非数字 id 一律 404（与 GET /:id 同构，不区分原因，防存在性探测）
  const idParam = c.req.param('id')
  if (!/^\d+$/.test(idParam)) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 归属条件并入查询（同 GET /:id 防探测口径）
  const session = await fetchSessionForWrite(db, Number(idParam), authUser.id)
  if (session === undefined) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  // 模考语义：交卷即定卷——submitted/abandoned 均拒（与练习 append-anytime 不同）
  if (session.status !== 'in_progress') {
    throw new HTTPException(400, { message: SESSION_CLOSED_ANSWER_MESSAGE })
  }

  // 入参校验序（照练习判分端点序，去掉判分）：questionId 形状 → 会话成员 → 题目行存在 → answer 选项键 → durationMs 区间
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

  // 题目行（options）：answer 选项键白名单校验依据
  const questionRow = await fetchQuestionOptionsRow(db, questionId)
  if (questionRow === undefined) {
    throw new HTTPException(404, { message: '题目不存在' })
  }

  // answer 限定为该题选项键：防无效作答混入作答行（D4 交卷才判分，脏值会污染判分）
  if (typeof answer !== 'string' || !questionRow.options.some((option) => option.key === answer)) {
    throw new HTTPException(400, { message: 'answer 必须是题目选项键之一' })
  }
  if (
    typeof durationMs !== 'number' ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs >= MOCK_MAX_DURATION_MS
  ) {
    throw new HTTPException(400, { message: `durationMs 必须是 0 到 ${MOCK_MAX_DURATION_MS} 之间的整数（毫秒）` })
  }

  // 作答行 upsert（每会话每题一行，交卷前可改答案——与练习 append-only 不同）：
  // - answer 直接覆盖（最新选择胜；与插入值同源，等价于 excluded.answer）；
  // - durationMs 取 SQL MAX 防回退：前端上报累计绝对值（见 DTO JSDoc），乱序/重复上报不缩水；
  // - isCorrect/isTimeout 不触碰（交卷判分才落值，D4）；
  // - updatedAt 显式给值（$onUpdate 在 upsert 冲突分支不触发，不依赖它——practice.ts 惯例）。
  await db
    .insert(mockAnswers)
    .values({ sessionId: session.id, questionId, answer, durationMs })
    .onConflictDoUpdate({
      target: [mockAnswers.sessionId, mockAnswers.questionId],
      set: {
        answer,
        durationMs: sql`MAX(${mockAnswers.durationMs}, excluded.duration_ms)`,
        updatedAt: new Date().toISOString(),
      },
    })

  // 已答数 = 会话内 mock_answers 行数（与详情/列表口径一致；upsert 不加行，二次提交同值）
  const answeredCountRows = await db
    .select({ answered: count() })
    .from(mockAnswers)
    .where(eq(mockAnswers.sessionId, session.id))
  const answeredCount = answeredCountRows[0]?.answered ?? 0

  // 轻响应（D4 不回发题目/判分信息）：前端 invalidate 详情重新拉取
  const responseBody: SubmitMockAnswerResponse = { questionId, answeredCount }
  return c.json(responseBody, 200)
})

mockRoute.post('/sessions/:id/timer', async (c) => {
  // 非数字 id 一律 404（同作答端点，不区分原因，防存在性探测）
  const idParam = c.req.param('id')
  if (!/^\d+$/.test(idParam)) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 归属条件并入查询（同作答端点防探测口径）
  const session = await fetchSessionForWrite(db, Number(idParam), authUser.id)
  if (session === undefined) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  // 模考语义：交卷即定卷——计时不再受理（与作答拒绝同语义，文案按动作分开求准确）
  if (session.status !== 'in_progress') {
    throw new HTTPException(400, { message: SESSION_CLOSED_TIMER_MESSAGE })
  }

  const requestBody = await readJsonBody(c)
  if (typeof requestBody !== 'object' || requestBody === null) {
    throw new HTTPException(400, { message: '请求体须为 JSON 对象，且含 elapsedMs 数字字段' })
  }
  const { elapsedMs } = requestBody as Record<string, unknown>
  if (
    typeof elapsedMs !== 'number' ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs >= MOCK_MAX_DURATION_MS
  ) {
    throw new HTTPException(400, { message: `elapsedMs 必须是 0 到 ${MOCK_MAX_DURATION_MS} 之间的整数（毫秒）` })
  }

  // 落库取 SQL MAX 防回退（D6 累计绝对值口径：服务端不做墙钟推导，乱序/重复/并发上报不缩水）；
  // updatedAt 显式刷新（不依赖 $onUpdate）；returning 回读 max 后落库值，前端据回发值校准本地基线
  const updated = await db
    .update(mockSessions)
    .set({
      elapsedMs: sql`MAX(${mockSessions.elapsedMs}, ${elapsedMs})`,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(mockSessions.id, session.id), eq(mockSessions.userId, authUser.id)))
    .returning({ elapsedMs: mockSessions.elapsedMs })
  const row = updated[0]
  if (row === undefined) {
    // 归属校验刚通过即 0 命中：仅并发删会话等异常态可达，属服务端错误
    throw new HTTPException(500, { message: '计时更新失败' })
  }

  const responseBody: UpdateMockTimerResponse = { elapsedMs: row.elapsedMs }
  return c.json(responseBody, 200)
})

mockRoute.post('/sessions/:id/submit', async (c) => {
  // 非数字 id 一律 404（同作答端点，不区分原因，防存在性探测）
  const idParam = c.req.param('id')
  if (!/^\d+$/.test(idParam)) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 归属条件并入查询（同作答端点防探测口径）；交卷无请求体入参（不需要客户端提交任何数据）
  const session = await fetchSessionForWrite(db, Number(idParam), authUser.id)
  if (session === undefined) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  // 模考语义：交卷即定卷——submitted/abandoned 均拒（重复交卷拒绝，防判分与错题本重复副作用）
  if (session.status !== 'in_progress') {
    throw new HTTPException(400, { message: SESSION_ALREADY_SUBMITTED_MESSAGE })
  }

  // 判分材料：题目行（答案比对 + 模块归属）与蓝图每题时限映射（D5 超时推导）
  const questionRows = await fetchGradingQuestionRows(db, session.questionIds)
  const planInfo = await fetchBlueprintPlanInfo(db, session.blueprintId)

  // 逐已作答行统一判分（D4）：取会话全部作答行，answer 为空的行（作答端点只写有答案的行，
  // 库缺省可空——防御脏数据）与悬空题目 id（mock_answers 挂题目外键级联删，理论不可达）跳过：
  // - isCorrect = 作答选项键 === 题目答案（单选比对口径，与练习判分一致）；
  // - isTimeout = durationMs 严格大于蓝图该模块每题秒数 × 1000（等于不超——与练习判分同口径），
  //   模块不在蓝图映射 → false；
  // - 逐题 update 落 mock_answers（行数 ≤135 自用可接受；updatedAt 显式给值——同 upsert 惯例）。
  const answerRows = await db
    .select({ questionId: mockAnswers.questionId, answer: mockAnswers.answer, durationMs: mockAnswers.durationMs })
    .from(mockAnswers)
    .where(eq(mockAnswers.sessionId, session.id))
  const gradedAt = new Date().toISOString()
  for (const row of answerRows) {
    if (row.answer === null) {
      continue
    }
    const questionRow = questionRows.get(row.questionId)
    if (questionRow === undefined) {
      continue
    }
    const isCorrect = row.answer === questionRow.answer
    const timeLimitSeconds = planInfo.questionTimeLimits[questionRow.moduleCode]
    const isTimeout = timeLimitSeconds !== undefined && row.durationMs > timeLimitSeconds * 1000
    await db
      .update(mockAnswers)
      .set({ isCorrect, isTimeout, updatedAt: gradedAt })
      .where(and(eq(mockAnswers.sessionId, session.id), eq(mockAnswers.questionId, row.questionId)))

    // 错题本联动（D8）：仅答错题进状态机（复用共享 wrong-book-machine.ts——答错复活在册/
    // 新错入册，与专项刷题同一函数同一行为）。判分 true 的题不动错题本：D8「与专项刷题同状态机」
    // 取保守解释——同指同一个状态机函数与答错行为；练习「答对在册累加 redoCount」是复习闭环语义，
    // 模考是考试场景、答对不是「重做」，故不联动（未答题同样不动）。
    if (!isCorrect) {
      await applyWrongBookStateMachine(db, authUser.id, row.questionId, false)
    }
  }

  // 会话翻 submitted（交卷即定卷；submittedAt 落值；updatedAt 显式给值——不依赖 $onUpdate）
  const submittedAt = new Date().toISOString()
  await db
    .update(mockSessions)
    .set({ status: 'submitted', submittedAt, updatedAt: submittedAt })
    .where(eq(mockSessions.id, session.id))

  // 交卷即回成绩单（与 GET report 同形状、逐字段一致——聚合从库现读已落值的判分结果）
  const body = await buildSessionReport(db, session)
  return c.json(body, 200)
})

mockRoute.get('/sessions/:id/report', async (c) => {
  // 非数字 id 一律 404（同详情端点，不区分原因，防存在性探测）
  const idParam = c.req.param('id')
  if (!/^\d+$/.test(idParam)) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 归属条件并入查询（同详情端点防探测口径）
  const session = await fetchSessionForWrite(db, Number(idParam), authUser.id)
  if (session === undefined) {
    throw new HTTPException(404, { message: SESSION_NOT_FOUND_MESSAGE })
  }

  // 成绩单只对已定卷会话有意义（in_progress 判分未落、聚合无依据）；
  // submitted/abandoned 均可取（abandoned 未判分 → answered 恒 0，作答内容仍在逐题项回显）
  if (session.status === 'in_progress') {
    throw new HTTPException(400, { message: SESSION_NOT_SUBMITTED_MESSAGE })
  }

  const body = await buildSessionReport(db, session)
  return c.json(body, 200)
})
