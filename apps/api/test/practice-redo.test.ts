import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { examTypes, practiceRecords, practiceSessions, users } from '../src/db/schema'
import { bearerGet, bearerPost, errorField, numberField, questionList, registerForToken, requestJson } from './api-helpers'
import { db, insertContentFixture, insertWrongBookEntry, userIdOf, type ContentFixture } from './practice-fixtures'

/**
 * 错题重做会话 API 集成测试（T1-10a）：POST /api/practice/sessions 的 wrong_redo 分支
 * 经 worker 真实入口。抽题序 = wrong_book.updatedAt 倒序（最近变化在前）、moduleCode null、
 * 不足按实际条数、0 条 400（错题本/难点本文案分流）、判分落库 mode='wrong_redo' 且
 * isTimeout=false（moduleCode null → 不判超时）、用户隔离、入参校验、401；
 * 另验 module 分支省缺 mode 的旧形状仍 201（向后兼容回归）。
 * 助手与夹具见 test/api-helpers.ts 与 test/practice-fixtures.ts。
 */

let content: ContentFixture

beforeEach(async () => {
  // 清空 users（级联清 practice_sessions / practice_records / wrong_book）与 exam_types（级联清内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
  content = await insertContentFixture()
})

/** 建会话请求（简写） */
function createSession(token: string, body: unknown) {
  return requestJson('/api/practice/sessions', bearerPost(token, body))
}

describe('POST /api/practice/sessions（wrong_redo 分支）', () => {
  it('source=active：201，mode/moduleCode null、题目序 = updatedAt 倒序、库行一致、活动列表可见', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    // active 两题（updatedAt 新旧）+ hard 一题 + eliminated 一题：active 分支只取前两题、序为倒序
    const [olderActive, newerActive, hardOne, eliminatedOne] = content.politicalQuestionIds.slice(0, 4)
    await insertWrongBookEntry(userId, olderActive, { status: 'active', updatedAt: '2026-10-11T01:00:00.000Z' })
    await insertWrongBookEntry(userId, newerActive, { status: 'active', updatedAt: '2026-10-11T03:00:00.000Z' })
    await insertWrongBookEntry(userId, hardOne, { status: 'hard', updatedAt: '2026-10-11T04:00:00.000Z' })
    await insertWrongBookEntry(userId, eliminatedOne, { status: 'eliminated', updatedAt: '2026-10-11T05:00:00.000Z' })

    const { status, body } = await createSession(token, { mode: 'wrong_redo', source: 'active' })

    expect(status).toBe(201)
    expect(numberField(body, 'id')).toBeGreaterThan(0)
    expect(body.mode).toBe('wrong_redo')
    expect(body.moduleCode).toBeNull()
    expect(body.status).toBe('in_progress')
    expect(numberField(body, 'total')).toBe(2)
    expect(numberField(body, 'answeredCount')).toBe(0)
    // 题目序 = updatedAt 倒序（最近变化在前）；hard/eliminated 条目不进 active 会话
    const ids = questionList(body).map((question) => numberField(question, 'id'))
    expect(ids).toEqual([newerActive, olderActive])

    // 库行与会话详情一致（mode/moduleCode/questionIds）
    const sessionId = numberField(body, 'id')
    const sessionRows = await db.select().from(practiceSessions).where(eq(practiceSessions.id, sessionId))
    expect(sessionRows).toHaveLength(1)
    expect(sessionRows[0].mode).toBe('wrong_redo')
    expect(sessionRows[0].moduleCode).toBeNull()
    expect(sessionRows[0].questionIds).toEqual([newerActive, olderActive])
    expect(sessionRows[0].userId).toBe(userId)

    // 活动会话列表照常可见（列表 DTO 的 mode 字段已含 wrong_redo）
    const listResponse = await requestJson('/api/practice/sessions', bearerGet(token))
    const list = listResponse.body as unknown as Record<string, unknown>[]
    const row = list.find((entry) => numberField(entry, 'id') === sessionId)
    expect(row?.mode).toBe('wrong_redo')
    expect(row?.moduleCode).toBeNull()
  })

  it('source=hard：只取难点本条目（active/eliminated 不入）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [activeOne, hardOne] = [content.politicalQuestionIds[0], content.politicalQuestionIds[1]]
    await insertWrongBookEntry(userId, activeOne, { status: 'active', updatedAt: '2026-10-11T01:00:00.000Z' })
    await insertWrongBookEntry(userId, hardOne, { status: 'hard', updatedAt: '2026-10-11T02:00:00.000Z' })

    const { status, body } = await createSession(token, { mode: 'wrong_redo', source: 'hard' })

    expect(status).toBe(201)
    expect(body.mode).toBe('wrong_redo')
    expect(questionList(body).map((question) => numberField(question, 'id'))).toEqual([hardOne])
  })

  it('count 上限生效：7 条 active、count=5 → total=5 且为最近变化的 5 题（倒序；不足的对照见首用例 total=2）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionIds = content.politicalQuestionIds.slice(0, 7)
    for (const [index, questionId] of questionIds.entries()) {
      // createdAt/updatedAt 随索引递增：索引 0 最旧、索引 6 最新
      await insertWrongBookEntry(userId, questionId, {
        status: 'active',
        updatedAt: `2026-10-11T0${index + 1}:00:00.000Z`,
      })
    }

    const { status, body } = await createSession(token, { mode: 'wrong_redo', source: 'active', count: 5 })

    expect(status).toBe(201)
    expect(numberField(body, 'total')).toBe(5)
    // updatedAt 倒序取前 5：索引 6..2（LIMIT 生效于倒序序）
    const expected = [...questionIds.slice(2)].reverse()
    expect(questionList(body).map((question) => numberField(question, 'id'))).toEqual(expected)
  })

  it('0 条 400：active →「错题本暂无可重做的题目」；hard →「难点本暂无可重做的题目」（source 分流）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')

    // 无任何在册条目：两分支各回各自文案
    const activeEmpty = await createSession(token, { mode: 'wrong_redo', source: 'active' })
    expect(activeEmpty.status).toBe(400)
    expect(errorField(activeEmpty.body).code).toBe('bad_request')
    expect(errorField(activeEmpty.body).message).toBe('错题本暂无可重做的题目')

    const hardEmpty = await createSession(token, { mode: 'wrong_redo', source: 'hard' })
    expect(hardEmpty.status).toBe(400)
    expect(errorField(hardEmpty.body).message).toBe('难点本暂无可重做的题目')

    // 仅有 hard 条目：active 分支仍 400（按 source 过滤，非总数）
    await insertWrongBookEntry(userId, content.politicalQuestionIds[0], { status: 'hard' })
    const activeAfterHard = await createSession(token, { mode: 'wrong_redo', source: 'active' })
    expect(activeAfterHard.status).toBe(400)
    expect(errorField(activeAfterHard.body).message).toBe('错题本暂无可重做的题目')

    // 400 时不建任何会话行
    const rows = await db.select({ id: practiceSessions.id }).from(practiceSessions)
    expect(rows).toHaveLength(0)
  })

  it('判分落库：wrong_redo 会话作答 → practice_records 行 mode=wrong_redo、isTimeout=false（moduleCode null 不判超时）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await insertWrongBookEntry(userId, questionId, { status: 'active', updatedAt: '2026-10-11T01:00:00.000Z' })

    const created = await createSession(token, { mode: 'wrong_redo', source: 'active' })
    const sessionId = numberField(created.body, 'id')

    // 用时 10 分钟（远超任何模块的每题时限）：moduleCode null → 不判超时
    const answered = await requestJson(
      `/api/practice/sessions/${sessionId}/answers`,
      bearerPost(token, { questionId, answer: 'B', durationMs: 600_000 }),
    )
    expect(answered.status).toBe(200)
    expect(answered.body.isCorrect).toBe(true)
    expect(answered.body.isTimeout).toBe(false)
    // 单题会话答完即 finished
    expect(answered.body.sessionStatus).toBe('finished')

    const recordRows = await db
      .select()
      .from(practiceRecords)
      .where(eq(practiceRecords.sessionId, String(sessionId)))
    expect(recordRows).toHaveLength(1)
    expect(recordRows[0].mode).toBe('wrong_redo')
    expect(recordRows[0].isTimeout).toBe(false)
    expect(recordRows[0].userId).toBe(userId)
    expect(recordRows[0].questionId).toBe(questionId)
  })

  it('用户隔离：bob 的在册条目不可被 alice 重做（alice 无条目仍 400，bob 可建）', async () => {
    const tokenAlice = await registerForToken('alice')
    const tokenBob = await registerForToken('bob')
    const bobId = await userIdOf('bob')
    await insertWrongBookEntry(bobId, content.politicalQuestionIds[0], { status: 'active' })

    const aliceAttempt = await createSession(tokenAlice, { mode: 'wrong_redo', source: 'active' })
    expect(aliceAttempt.status).toBe(400)
    expect(errorField(aliceAttempt.body).message).toBe('错题本暂无可重做的题目')

    const bobSession = await createSession(tokenBob, { mode: 'wrong_redo', source: 'active' })
    expect(bobSession.status).toBe(201)
    expect(questionList(bobSession.body).map((question) => numberField(question, 'id'))).toEqual([
      content.politicalQuestionIds[0],
    ])
  })

  it.each([
    { case: 'mode 非法值', requestBody: { mode: 'random' } },
    { case: 'mode 类型错（数字）', requestBody: { mode: 1 } },
    { case: 'wrong_redo 缺 source', requestBody: { mode: 'wrong_redo' } },
    { case: 'source 非法值（eliminated）', requestBody: { mode: 'wrong_redo', source: 'eliminated' } },
    { case: 'source 类型错（数字）', requestBody: { mode: 'wrong_redo', source: 1 } },
    { case: 'wrong_redo count 非法值', requestBody: { mode: 'wrong_redo', source: 'active', count: 7 } },
    { case: 'wrong_redo count 类型错', requestBody: { mode: 'wrong_redo', source: 'hard', count: '10' } },
  ])('入参不合法（$case）：400 + bad_request 且不建会话', async ({ requestBody }) => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    // 预置一条在册条目：校验失败应发生在抽题前/后无关，均不落会话行
    await insertWrongBookEntry(userId, content.politicalQuestionIds[0], { status: 'active' })

    const { status, body } = await createSession(token, requestBody)
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
    const rows = await db.select({ id: practiceSessions.id }).from(practiceSessions)
    expect(rows).toHaveLength(0)
  })

  it('缺 token：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson(
      '/api/practice/sessions',
      bearerPost('not-a-token', { mode: 'wrong_redo', source: 'active' }),
    )
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })
})

describe('module 分支向后兼容（T1-10a 回归）', () => {
  it('省缺 mode 的旧形状仍 201：{ module } 与既有行为一致（mode=module、moduleCode 回显）', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await createSession(token, { module: 'political_theory' })
    expect(status).toBe(201)
    expect(body.mode).toBe('module')
    expect(body.moduleCode).toBe('political_theory')
    expect(numberField(body, 'total')).toBe(10)
  })

  it('显式 mode=module 等价省缺：201 同形状', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await createSession(token, { mode: 'module', module: 'common_sense', count: 5 })
    expect(status).toBe(201)
    expect(body.mode).toBe('module')
    expect(body.moduleCode).toBe('common_sense')
    expect(numberField(body, 'total')).toBe(2)
  })
})
