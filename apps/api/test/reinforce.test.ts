import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ReinforceReason, ReinforceStatus } from '@ncse/shared'
import { examTypes, practiceSessions, reinforceQueue, users } from '../src/db/schema'
import { bearerGet, bearerPost, errorField, numberField, questionList, registerForToken, requestJson } from './api-helpers'
import { db, insertContentFixture, insertSession, insertWrongBookEntry, userIdOf, type ContentFixture } from './practice-fixtures'

/**
 * 需加强清单 API 集成测试（T3-01e，M3 规划 D5 定稿）：练习判分与模考交卷驱动的全自动强化队列。
 * 经 worker 真实入口覆盖：判分联动（汇入 pending/reason 覆盖、出队 resolved、reinforce 会话
 * 超时按题目所属模块推导）、GET /api/reinforce 列表（status 过滤/白名单 400/倒序/隔离/401）、
 * POST /api/practice/sessions 的 reinforce 分支（题目序 = updatedAt 倒序、0 条 400、不足按实际、
 * module 省缺 mode 旧形状回归）。模考交卷侧的汇入用例见 mock-api.test.ts（与错题本 D8 联动
 * 用例同 describe，共用其判分会话夹具）。助手与夹具见 test/api-helpers.ts 与
 * test/practice-fixtures.ts（种子行直插 reinforce_queue——排序/抽题序用例需钉死可控 updatedAt）。
 * 超时推导基准：省考联考·标准卷（province_joint_std）——political_theory 每题时限
 * 40s = floor(10 分钟 × 60 / 15 题)；judgement 60s = floor(30 分钟 × 60 / 30 题)。
 */

/** reinforce_queue 行（直查断言用，列类型由 schema 推导） */
type ReinforceRow = typeof reinforceQueue.$inferSelect

/** 直插强化队列条目覆盖项（缺省为「答错一次后」的形状：pending、reason wrong） */
interface ReinforceEntryOverrides {
  reason?: ReinforceReason
  status?: ReinforceStatus
  /** 最近变化时间（缺省库端 now；列表排序与强化抽题序用例需钉死可控值） */
  updatedAt?: string
}

let content: ContentFixture

beforeEach(async () => {
  // 清空 users（级联清 practice_sessions / reinforce_queue）与 exam_types（级联清内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
  content = await insertContentFixture()
})

/** 提交作答（判分端点的简写） */
function submitAnswer(sessionId: number, token: string, body: unknown) {
  return requestJson(`/api/practice/sessions/${sessionId}/answers`, bearerPost(token, body))
}

/** 建会话请求（简写） */
function createSession(token: string, body: unknown) {
  return requestJson('/api/practice/sessions', bearerPost(token, body))
}

/** 直插一条强化队列条目（判分联动/列表/强化会话的前置态） */
async function insertReinforceEntry(
  userId: number,
  questionId: number,
  overrides: ReinforceEntryOverrides = {},
): Promise<void> {
  await db.insert(reinforceQueue).values({
    userId,
    questionId,
    reason: overrides.reason ?? 'wrong',
    status: overrides.status ?? 'pending',
    ...(overrides.updatedAt === undefined ? {} : { updatedAt: overrides.updatedAt }),
  })
}

/** 直查强化队列条目行（undefined = 不在册；判分联动的落库断言用） */
async function reinforceRowOf(userId: number, questionId: number): Promise<ReinforceRow | undefined> {
  const rows = await db
    .select()
    .from(reinforceQueue)
    .where(and(eq(reinforceQueue.userId, userId), eq(reinforceQueue.questionId, questionId)))
  return rows.at(0)
}

describe('练习判分联动需加强队列（M3 D5）', () => {
  it('答错：汇入 pending/wrong（新建行）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    const { status, body } = await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 1000 })

    expect(status).toBe(200)
    expect(body.isCorrect).toBe(false)
    expect(body.isTimeout).toBe(false)
    expect(await reinforceRowOf(userId, questionId)).toMatchObject({ status: 'pending', reason: 'wrong' })
  })

  it('答对不超时：在册行翻 resolved（reason 原值保留）；不在册不建行', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [inQueueId, notInQueueId] = content.politicalQuestionIds
    await insertReinforceEntry(userId, inQueueId, { reason: 'timeout' })
    const sessionId = await insertSession(userId, 'political_theory', [inQueueId, notInQueueId])

    const first = await submitAnswer(sessionId, token, { questionId: inQueueId, answer: 'B', durationMs: 1000 })
    expect(first.body.isCorrect).toBe(true)
    expect(first.body.isTimeout).toBe(false)
    await submitAnswer(sessionId, token, { questionId: notInQueueId, answer: 'B', durationMs: 1000 })

    // 出队只翻 status（reason 不动）；答对不在册不建行
    expect(await reinforceRowOf(userId, inQueueId)).toMatchObject({ status: 'resolved', reason: 'timeout' })
    expect(await reinforceRowOf(userId, notInQueueId)).toBeUndefined()
  })

  it('答对但超时：汇入 pending/timeout（judgement 每题时限 60s，60_001 严格大于判超）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.judgementQuestionIds[0]
    const sessionId = await insertSession(userId, 'judgement', [questionId])

    const { body } = await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 60_001 })

    expect(body.isCorrect).toBe(true)
    expect(body.isTimeout).toBe(true)
    expect(await reinforceRowOf(userId, questionId)).toMatchObject({ status: 'pending', reason: 'timeout' })
  })

  it('答错且超时同用：reason 记 wrong（答错优先；political 每题时限 40s，40_001 判超）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    const { body } = await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 40_001 })

    expect(body.isCorrect).toBe(false)
    expect(body.isTimeout).toBe(true)
    expect(await reinforceRowOf(userId, questionId)).toMatchObject({ status: 'pending', reason: 'wrong' })
  })

  it('resolved 行再答错：复活 pending（reason 覆盖）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await insertReinforceEntry(userId, questionId, {
      reason: 'timeout',
      status: 'resolved',
      updatedAt: '2026-10-11T01:00:00.000Z',
    })
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 1000 })

    expect(await reinforceRowOf(userId, questionId)).toMatchObject({ status: 'pending', reason: 'wrong' })
  })

  it('在册 wrong 行再「答对但超时」：仍 pending、reason 覆盖为 timeout', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    // 先答错（不超时）汇入 wrong
    await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 1000 })
    expect(await reinforceRowOf(userId, questionId)).toMatchObject({ status: 'pending', reason: 'wrong' })

    // 再答对但超时（40_001 > 40s）→ reason 刷新为 timeout
    await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 40_001 })
    expect(await reinforceRowOf(userId, questionId)).toMatchObject({ status: 'pending', reason: 'timeout' })
  })

  it('reinforce 会话判分超时按题目所属模块推导：judgement 60s 等于不超（答对出队）、political 40s 严格大于判超（答对但超时汇入 timeout）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [politicalId, judgementId] = [content.politicalQuestionIds[0], content.judgementQuestionIds[0]]
    // 种子 pending 行（政治题较旧、判断题较新 → 会话题目序 = [judgement, political]）
    await insertReinforceEntry(userId, politicalId, { updatedAt: '2026-10-11T01:00:00.000Z' })
    await insertReinforceEntry(userId, judgementId, { updatedAt: '2026-10-11T02:00:00.000Z' })

    const created = await createSession(token, { mode: 'reinforce' })
    expect(created.status).toBe(201)
    const sessionId = numberField(created.body, 'id')
    expect(questionList(created.body).map((question) => numberField(question, 'id'))).toEqual([judgementId, politicalId])

    // judgement 每题 60s：等于时限不超时、答对且不超时 → 出队
    const atLimit = await submitAnswer(sessionId, token, { questionId: judgementId, answer: 'B', durationMs: 60_000 })
    expect(atLimit.body.isTimeout).toBe(false)
    expect(await reinforceRowOf(userId, judgementId)).toMatchObject({ status: 'resolved' })

    // political 每题 40s：40_001 严格大于 → 超时，答对但超时 → 汇入 pending/timeout
    //（若不按题目模块推导则 isTimeout=false，该行会被误判出队——本用例锁定此语义）
    const overLimit = await submitAnswer(sessionId, token, { questionId: politicalId, answer: 'B', durationMs: 40_001 })
    expect(overLimit.body.isTimeout).toBe(true)
    expect(await reinforceRowOf(userId, politicalId)).toMatchObject({ status: 'pending', reason: 'timeout' })
  })

  it('wrong_redo 会话回归：长用时答对不判超时（M1 设计维持），在册 pending 行出队 resolved', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await insertWrongBookEntry(userId, questionId, { status: 'active', updatedAt: '2026-10-11T01:00:00.000Z' })
    await insertReinforceEntry(userId, questionId, { reason: 'wrong' })
    const created = await createSession(token, { mode: 'wrong_redo', source: 'active' })
    expect(created.status).toBe(201)
    const sessionId = numberField(created.body, 'id')

    // 用时 10 分钟（远超 political 40s 时限）：moduleCode null 且非 reinforce → 不判超时 → 答对出队
    const answered = await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 600_000 })
    expect(answered.body.isCorrect).toBe(true)
    expect(answered.body.isTimeout).toBe(false)
    expect(await reinforceRowOf(userId, questionId)).toMatchObject({ status: 'resolved' })
  })
})

describe('GET /api/reinforce（列表与过滤）', () => {
  it('status 过滤与缺省：缺省/pending 只列 pending；resolved 只列 resolved', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [pendingId, resolvedId] = content.politicalQuestionIds
    await insertReinforceEntry(userId, pendingId, { updatedAt: '2026-10-11T01:00:00.000Z' })
    await insertReinforceEntry(userId, resolvedId, { status: 'resolved', updatedAt: '2026-10-11T02:00:00.000Z' })

    const defaulted = await requestJson('/api/reinforce', bearerGet(token))
    expect(defaulted.status).toBe(200)
    expect((defaulted.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      pendingId,
    ])

    const explicitPending = await requestJson('/api/reinforce?status=pending', bearerGet(token))
    expect((explicitPending.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      pendingId,
    ])

    const resolved = await requestJson('/api/reinforce?status=resolved', bearerGet(token))
    expect((resolved.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      resolvedId,
    ])
  })

  it('列表项字段全形状：questionId/moduleCode/stemPreview/reason/status/updatedAt', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const updatedAt = '2026-10-11T08:30:00.000Z'
    await insertReinforceEntry(userId, questionId, { reason: 'timeout', updatedAt })

    const { status, body } = await requestJson('/api/reinforce', bearerGet(token))
    expect(status).toBe(200)
    expect(body).toEqual([
      {
        questionId,
        moduleCode: 'political_theory',
        // 夹具题干「政治理论第 1 题」+ 图片段：text 段即预览全文（不截断）
        stemPreview: '政治理论第 1 题',
        reason: 'timeout',
        status: 'pending',
        updatedAt,
      },
    ])
  })

  it('无队列条目：200 空数组', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/reinforce', bearerGet(token))
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it.each([
    { case: 'status 非法值', query: 'status=bogus' },
    { case: 'status 空串', query: 'status=' },
  ])('status 非法（$case）：400 + bad_request', async ({ query }) => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson(`/api/reinforce?${query}`, bearerGet(token))
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
  })

  it('排序：updatedAt 倒序（最近汇入在前）；同值并列按 id 倒序稳定', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [oldest, middle, tiedFirst, tiedSecond] = content.politicalQuestionIds.slice(0, 4)
    await insertReinforceEntry(userId, oldest, { updatedAt: '2026-10-11T01:00:00.000Z' })
    await insertReinforceEntry(userId, middle, { updatedAt: '2026-10-11T03:00:00.000Z' })
    // 同 updatedAt 并列：后插者 id 更大，应排在前（id 倒序兜底）
    await insertReinforceEntry(userId, tiedFirst, { updatedAt: '2026-10-11T05:00:00.000Z' })
    await insertReinforceEntry(userId, tiedSecond, { updatedAt: '2026-10-11T05:00:00.000Z' })

    const { status, body } = await requestJson('/api/reinforce', bearerGet(token))
    expect(status).toBe(200)
    expect((body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      tiedSecond,
      tiedFirst,
      middle,
      oldest,
    ])
  })

  it('用户隔离：他人条目不出现（bob 的 pending 不入 alice 列表，反之亦然）', async () => {
    const tokenAlice = await registerForToken('alice')
    const tokenBob = await registerForToken('bob')
    const aliceId = await userIdOf('alice')
    const bobId = await userIdOf('bob')
    const [aliceQuestion, bobQuestion] = [content.politicalQuestionIds[0], content.politicalQuestionIds[1]]
    await insertReinforceEntry(aliceId, aliceQuestion, { updatedAt: '2026-10-11T00:00:01.000Z' })
    await insertReinforceEntry(bobId, bobQuestion, { updatedAt: '2026-10-11T00:00:02.000Z' })

    const aliceList = await requestJson('/api/reinforce', bearerGet(tokenAlice))
    expect((aliceList.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      aliceQuestion,
    ])
    const bobList = await requestJson('/api/reinforce', bearerGet(tokenBob))
    expect((bobList.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      bobQuestion,
    ])
  })

  it('缺 token：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson('/api/reinforce', { method: 'GET' })
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })
})

describe('POST /api/practice/sessions（reinforce 分支）', () => {
  it('201 主流程：mode=moduleCode null、题目序 = updatedAt 倒序（resolved 不进）、库行一致、活动列表可见', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [olderPending, newerPending, resolvedOne] = content.politicalQuestionIds.slice(0, 3)
    const commonPending = content.commonQuestionIds[0]
    await insertReinforceEntry(userId, olderPending, { updatedAt: '2026-10-11T01:00:00.000Z' })
    await insertReinforceEntry(userId, newerPending, { updatedAt: '2026-10-11T03:00:00.000Z' })
    await insertReinforceEntry(userId, commonPending, { reason: 'timeout', updatedAt: '2026-10-11T05:00:00.000Z' })
    await insertReinforceEntry(userId, resolvedOne, { status: 'resolved', updatedAt: '2026-10-11T06:00:00.000Z' })

    const { status, body } = await createSession(token, { mode: 'reinforce' })

    expect(status).toBe(201)
    expect(numberField(body, 'id')).toBeGreaterThan(0)
    expect(body.mode).toBe('reinforce')
    expect(body.moduleCode).toBeNull()
    expect(body.status).toBe('in_progress')
    expect(numberField(body, 'total')).toBe(3)
    expect(numberField(body, 'answeredCount')).toBe(0)
    // 题目序 = updatedAt 倒序（最近汇入在前）；resolved 条目不进强化会话
    const ids = questionList(body).map((question) => numberField(question, 'id'))
    expect(ids).toEqual([commonPending, newerPending, olderPending])

    // 库行与会话详情一致（mode/moduleCode/questionIds）
    const sessionId = numberField(body, 'id')
    const sessionRows = await db.select().from(practiceSessions).where(eq(practiceSessions.id, sessionId))
    expect(sessionRows).toHaveLength(1)
    expect(sessionRows[0].mode).toBe('reinforce')
    expect(sessionRows[0].moduleCode).toBeNull()
    expect(sessionRows[0].questionIds).toEqual([commonPending, newerPending, olderPending])
    expect(sessionRows[0].userId).toBe(userId)

    // 活动会话列表照常可见（列表 DTO 的 mode 字段已含 reinforce）
    const listResponse = await requestJson('/api/practice/sessions', bearerGet(token))
    const list = listResponse.body as unknown as Record<string, unknown>[]
    const row = list.find((entry) => numberField(entry, 'id') === sessionId)
    expect(row?.mode).toBe('reinforce')
    expect(row?.moduleCode).toBeNull()
  })

  it('count 上限生效：7 条 pending、count=5 → total=5 且为最近汇入的 5 题（倒序；不足的对照见主流程 total=3）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionIds = content.politicalQuestionIds.slice(0, 7)
    for (const [index, questionId] of questionIds.entries()) {
      // createdAt/updatedAt 随索引递增：索引 0 最旧、索引 6 最新
      await insertReinforceEntry(userId, questionId, { updatedAt: `2026-10-11T0${index + 1}:00:00.000Z` })
    }

    const { status, body } = await createSession(token, { mode: 'reinforce', count: 5 })

    expect(status).toBe(201)
    expect(numberField(body, 'total')).toBe(5)
    // updatedAt 倒序取前 5：索引 6..2（LIMIT 生效于倒序序）
    const expected = [...questionIds.slice(2)].reverse()
    expect(questionList(body).map((question) => numberField(question, 'id'))).toEqual(expected)
  })

  it('0 条 400：文案「需加强清单暂无待强化题目」；仅 resolved 条目亦 400（抽题只取 pending）；不建会话行', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')

    const empty = await createSession(token, { mode: 'reinforce' })
    expect(empty.status).toBe(400)
    expect(errorField(empty.body).code).toBe('bad_request')
    expect(errorField(empty.body).message).toBe('需加强清单暂无待强化题目')

    // 仅有 resolved 条目：pending 仍 0 → 400（按 status 过滤，非总数）
    await insertReinforceEntry(userId, content.politicalQuestionIds[0], { status: 'resolved' })
    const onlyResolved = await createSession(token, { mode: 'reinforce' })
    expect(onlyResolved.status).toBe(400)
    expect(errorField(onlyResolved.body).message).toBe('需加强清单暂无待强化题目')

    // 400 时不建任何会话行
    const rows = await db.select({ id: practiceSessions.id }).from(practiceSessions)
    expect(rows).toHaveLength(0)
  })

  it('用户隔离：bob 的 pending 条目不可被 alice 强化（alice 无条目仍 400，bob 可建）', async () => {
    const tokenAlice = await registerForToken('alice')
    const tokenBob = await registerForToken('bob')
    const bobId = await userIdOf('bob')
    await insertReinforceEntry(bobId, content.politicalQuestionIds[0])

    const aliceAttempt = await createSession(tokenAlice, { mode: 'reinforce' })
    expect(aliceAttempt.status).toBe(400)
    expect(errorField(aliceAttempt.body).message).toBe('需加强清单暂无待强化题目')

    const bobSession = await createSession(tokenBob, { mode: 'reinforce' })
    expect(bobSession.status).toBe(201)
    expect(questionList(bobSession.body).map((question) => numberField(question, 'id'))).toEqual([
      content.politicalQuestionIds[0],
    ])
  })

  it.each([
    { case: 'mode 非法值', requestBody: { mode: 'random' } },
    { case: 'mode 类型错（数字）', requestBody: { mode: 1 } },
    { case: 'reinforce count 非法值', requestBody: { mode: 'reinforce', count: 7 } },
    { case: 'reinforce count 类型错', requestBody: { mode: 'reinforce', count: '10' } },
  ])('入参不合法（$case）：400 + bad_request 且不建会话', async ({ requestBody }) => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    // 预置一条 pending 条目：校验失败无论发生在抽题前/后，均不落会话行
    await insertReinforceEntry(userId, content.politicalQuestionIds[0])

    const { status, body } = await createSession(token, requestBody)
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
    const rows = await db.select({ id: practiceSessions.id }).from(practiceSessions)
    expect(rows).toHaveLength(0)
  })

  it('缺 token：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson(
      '/api/practice/sessions',
      bearerPost('not-a-token', { mode: 'reinforce' }),
    )
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })

  it('module 分支省缺 mode 旧形状回归：仍 201（mode=module、moduleCode 回显、按模块抽题不受影响）', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await createSession(token, { module: 'political_theory' })
    expect(status).toBe(201)
    expect(body.mode).toBe('module')
    expect(body.moduleCode).toBe('political_theory')
    expect(numberField(body, 'total')).toBe(10)
  })
})
