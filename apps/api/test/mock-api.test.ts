import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BLUEPRINT_CODE, type RichContent, type RichSegment } from '@ncse/shared'
import { blueprints, examTypes, papers, users } from '../src/db/schema'
import {
  bearerGet,
  bearerPost,
  errorField,
  numberField,
  ORIGIN,
  postJson,
  questionList,
  registerForToken,
  requestJson,
} from './api-helpers'
import { db, fakeImageKey, LEGACY_IMAGE_PATH, userIdOf } from './practice-fixtures'
import {
  insertMockAnswerRow,
  insertMockFixture,
  insertMockSessionRow,
  insertPaperRow,
  type MockFixture,
} from './mock-fixtures'

/**
 * 整卷模拟·模考会话 API 集成测试（T2-01b）：经 worker 入口走真实 fetch（含路由挂载与
 * onError 错误信封），D1 为 workerd 内本地实例。夹具链复用 practice-fixtures 内容题库 +
 * mock-fixtures 蓝图/试卷/归属/会话/作答直插（卷题集序刻意与题目 id 大小序不同，
 * 验证快照按 question_papers.sequence 取序）。
 * 作答/计时/交卷端点为后续片——已答态经直插 mock_answers 模拟。
 */

/** 测试卷名（mock-fixtures 的 insertMockFixture 固定值，列表/详情字段精确断言共用） */
const PAPER_NAME = '2026年虚构省联考《行测》卷（模考 API 测试卷）'

/** 卷内各题的预期模块编码（序 = 卷内 sequence 序，与 mock-fixtures 挂卷序一致） */
const EXPECTED_MODULE_CODES = [
  'judgement',
  'political_theory',
  'common_sense',
  'political_theory',
  'common_sense',
  'political_theory',
  'political_theory',
] as const

let fixture: MockFixture

beforeEach(async () => {
  // 先清 users（级联清 mock_sessions / mock_answers，解除对蓝图/试卷的 restrict），再清 papers 与 exam_types（级联清内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(papers)
  await db.delete(examTypes)
  fixture = await insertMockFixture()
})

describe('POST /api/mock/sessions（开考建会话）', () => {
  it('缺省时长：201，题目序 = sequence 快照序（与 id 大小序不同）、answeredCount 0、totalMinutes 按 7 题推导为 10、elapsedMs 0、blueprintCode/paper 正确', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/mock/sessions', bearerPost(token, { paperId: fixture.paperId }))

    expect(status).toBe(201)
    expect(numberField(body, 'id')).toBeGreaterThan(0)
    expect(body.blueprintCode).toBe(DEFAULT_BLUEPRINT_CODE)
    expect(numberField(body, 'totalMinutes')).toBe(10)
    expect(numberField(body, 'elapsedMs')).toBe(0)
    expect(body.status).toBe('in_progress')
    expect(numberField(body, 'total')).toBe(7)
    expect(numberField(body, 'answeredCount')).toBe(0)
    expect(body.paper).toEqual({
      id: fixture.paperId,
      name: PAPER_NAME,
      year: 2026,
      region: 'fictionland',
      paperType: '联考',
      questionCount: 7,
      completeness: 'fragment',
    })

    const list = questionList(body)
    const ids = list.map((question) => numberField(question, 'id'))
    // 快照序 = question_papers.sequence 序；夹具刻意让该序与题目 id 大小序不同
    expect(ids).toEqual(fixture.paperQuestionIds)
    expect(ids).not.toEqual([...ids].sort((a, b) => a - b))
    for (const question of list) {
      expect(question.answered).toBeNull()
      // D4：作答中不下发答案与解析
      expect(question).not.toHaveProperty('answer')
      expect(question).not.toHaveProperty('analysis')
    }
  })

  it.each([5, 90, 600])('显式 totalMinutes=%d（区间端点与中值）：201 落值', async (totalMinutes) => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson(
      '/api/mock/sessions',
      bearerPost(token, { paperId: fixture.paperId, totalMinutes }),
    )
    expect(status).toBe(201)
    expect(numberField(body, 'totalMinutes')).toBe(totalMinutes)
  })

  it.each([
    { case: '低于下限 4', totalMinutes: 4 },
    { case: '高于上限 601', totalMinutes: 601 },
    { case: '非整数 12.5', totalMinutes: 12.5 },
    { case: '负数 -10', totalMinutes: -10 },
  ])('显式 totalMinutes 非法（$case）：400 bad_request，消息含区间', async ({ totalMinutes }) => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson(
      '/api/mock/sessions',
      bearerPost(token, { paperId: fixture.paperId, totalMinutes }),
    )
    expect(status).toBe(400)
    const error = errorField(body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toContain('totalMinutes')
    expect(error.message).toContain('5 到 600')
  })

  it.each([
    { case: '0', paperId: 0 },
    { case: '-1', paperId: -1 },
    { case: '小数 1.5', paperId: 1.5 },
    { case: '字符串 "1"', paperId: '1' },
    { case: '缺失', paperId: undefined },
  ])('paperId 非正整数（$case）：400 bad_request', async ({ paperId }) => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/mock/sessions', bearerPost(token, { paperId }))
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
  })

  it('试卷不存在：404 not_found，文案「试卷不存在」（防存在性探测）', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/mock/sessions', bearerPost(token, { paperId: 999999 }))
    expect(status).toBe(404)
    const error = errorField(body)
    expect(error.code).toBe('not_found')
    expect(error.message).toBe('试卷不存在')
  })

  it('空卷（question_papers 无行）：400 bad_request「该试卷无可考题目」', async () => {
    const token = await registerForToken('alice')
    const emptyPaperId = await insertPaperRow('空卷（无可考题目测试）', { questionCount: 0 })
    const { status, body } = await requestJson('/api/mock/sessions', bearerPost(token, { paperId: emptyPaperId }))
    expect(status).toBe(400)
    const error = errorField(body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toBe('该试卷无可考题目')
  })

  it('蓝图种子缺失：500 internal_error（部署前置缺失属服务端错误；beforeEach 重建蓝图，不影响其他用例）', async () => {
    const token = await registerForToken('alice')
    await db.delete(blueprints).where(eq(blueprints.id, fixture.blueprintId))
    const { status, body } = await requestJson('/api/mock/sessions', bearerPost(token, { paperId: fixture.paperId }))
    expect(status).toBe(500)
    const error = errorField(body)
    expect(error.code).toBe('internal_error')
    expect(error.message).toContain('蓝图种子未初始化')
  })

  it('并存不限：同卷可再开一场（两次 201，id 不同）', async () => {
    const token = await registerForToken('alice')
    const first = await requestJson('/api/mock/sessions', bearerPost(token, { paperId: fixture.paperId }))
    const second = await requestJson('/api/mock/sessions', bearerPost(token, { paperId: fixture.paperId }))
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(numberField(second.body, 'id')).not.toBe(numberField(first.body, 'id'))
  })
})

describe('GET /api/mock/sessions（进行中会话列表）', () => {
  it('只列本人 in_progress、createdAt 倒序、卷名/年份/进度/计时正确；submitted 与他人会话不出现', async () => {
    const tokenAlice = await registerForToken('alice')
    const tokenBob = await registerForToken('bob')
    const aliceId = await userIdOf('alice')
    const bobId = await userIdOf('bob')

    const older = await insertMockSessionRow({
      userId: aliceId,
      blueprintId: fixture.blueprintId,
      paperId: fixture.paperId,
      questionIds: fixture.paperQuestionIds,
      totalMinutes: 10,
      overrides: { createdAt: '2026-10-20T01:00:00.000Z', elapsedMs: 12_000 },
    })
    const newer = await insertMockSessionRow({
      userId: aliceId,
      blueprintId: fixture.blueprintId,
      paperId: fixture.paperId,
      questionIds: fixture.paperQuestionIds.slice(0, 3),
      totalMinutes: 120,
      overrides: { createdAt: '2026-10-20T02:00:00.000Z' },
    })
    // submitted 不入列表（交卷后回走详情）；bob 的会话对 alice 不可见
    await insertMockSessionRow({
      userId: aliceId,
      blueprintId: fixture.blueprintId,
      paperId: fixture.paperId,
      questionIds: fixture.paperQuestionIds,
      totalMinutes: 10,
      overrides: { status: 'submitted', createdAt: '2026-10-20T03:00:00.000Z' },
    })
    const bobSession = await insertMockSessionRow({
      userId: bobId,
      blueprintId: fixture.blueprintId,
      paperId: fixture.paperId,
      questionIds: fixture.paperQuestionIds,
      totalMinutes: 10,
      overrides: { createdAt: '2026-10-20T04:00:00.000Z' },
    })
    // older 已答 2 题（行存在即已答）
    await insertMockAnswerRow(older, fixture.paperQuestionIds[0], { answer: 'B', durationMs: 5_000 })
    await insertMockAnswerRow(older, fixture.paperQuestionIds[1], { answer: 'C', durationMs: 6_000 })

    const aliceList = await requestJson('/api/mock/sessions', bearerGet(tokenAlice))
    expect(aliceList.status).toBe(200)
    const list = aliceList.body as unknown as Record<string, unknown>[]
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      id: newer,
      paperName: PAPER_NAME,
      paperYear: 2026,
      totalMinutes: 120,
      elapsedMs: 0,
      status: 'in_progress',
      total: 3,
      answeredCount: 0,
      createdAt: '2026-10-20T02:00:00.000Z',
    })
    expect(list[1]).toEqual({
      id: older,
      paperName: PAPER_NAME,
      paperYear: 2026,
      totalMinutes: 10,
      elapsedMs: 12_000,
      status: 'in_progress',
      total: 7,
      answeredCount: 2,
      createdAt: '2026-10-20T01:00:00.000Z',
    })

    // 用户隔离：bob 只见自己的会话
    const bobList = await requestJson('/api/mock/sessions', bearerGet(tokenBob))
    expect(bobList.status).toBe(200)
    expect((bobList.body as unknown as { id: number }[]).map((row) => row.id)).toEqual([bobSession])
  })

  it('无进行中会话：200 空数组', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/mock/sessions', bearerGet(token))
    expect(status).toBe(200)
    expect(body).toEqual([])
  })
})

describe('GET /api/mock/sessions/:id（会话详情）', () => {
  it('会话隔离：他人会话/不存在 id/非数字 id 一律 404 同文案「会话不存在」（防存在性探测）', async () => {
    const tokenA = await registerForToken('alice')
    const tokenB = await registerForToken('bob')
    const created = await requestJson('/api/mock/sessions', bearerPost(tokenA, { paperId: fixture.paperId }))
    expect(created.status).toBe(201)
    const sessionId = numberField(created.body, 'id')

    const foreign = await requestJson(`/api/mock/sessions/${sessionId}`, bearerGet(tokenB))
    expect(foreign.status).toBe(404)
    const foreignError = errorField(foreign.body)
    expect(foreignError.code).toBe('not_found')
    expect(foreignError.message).toBe('会话不存在')

    const missing = await requestJson('/api/mock/sessions/999999', bearerGet(tokenA))
    expect(missing.status).toBe(404)
    expect(errorField(missing.body).message).toBe('会话不存在')

    const nonNumeric = await requestJson('/api/mock/sessions/abc', bearerGet(tokenA))
    expect(nonNumeric.status).toBe(404)
    expect(errorField(nonNumeric.body).message).toBe('会话不存在')
  })

  it('已答回显 answer+durationMs（键集恰两项，无 isCorrect/isTimeout——行内判分值不下发）、moduleCode/题目序/图片投影正确、elapsedMs 原样回发', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const sessionId = await insertMockSessionRow({
      userId,
      blueprintId: fixture.blueprintId,
      paperId: fixture.paperId,
      questionIds: fixture.paperQuestionIds,
      totalMinutes: 10,
      overrides: { elapsedMs: 65_000 },
    })
    // isCorrect 显式落值（模拟交卷后回看态）：回显仍不得包含判分字段
    await insertMockAnswerRow(sessionId, fixture.paperQuestionIds[0], { answer: 'C', durationMs: 8_000, isCorrect: true })
    await insertMockAnswerRow(sessionId, fixture.paperQuestionIds[2], { answer: 'D', durationMs: 9_000 })

    const { status, body } = await requestJson(`/api/mock/sessions/${sessionId}`, bearerGet(token))
    expect(status).toBe(200)
    expect(numberField(body, 'elapsedMs')).toBe(65_000)
    expect(numberField(body, 'totalMinutes')).toBe(10)
    expect(body.status).toBe('in_progress')
    expect(numberField(body, 'total')).toBe(7)
    expect(numberField(body, 'answeredCount')).toBe(2)
    expect(body.blueprintCode).toBe(DEFAULT_BLUEPRINT_CODE)

    const list = questionList(body)
    // 题目序 = 快照序；moduleCode 按题所属模块
    expect(list.map((question) => numberField(question, 'id'))).toEqual(fixture.paperQuestionIds)
    expect(list.map((question) => question.moduleCode)).toEqual([...EXPECTED_MODULE_CODES])
    for (const question of list) {
      expect(Object.keys(question).sort()).toEqual(['answered', 'id', 'kind', 'moduleCode', 'options', 'stem'])
    }

    // 已答回显：键集恰为 answer/durationMs（toStrictEqual 连 undefined 键也拒绝）
    expect(list[0].answered).toStrictEqual({ answer: 'C', durationMs: 8_000 })
    expect(list[2].answered).toStrictEqual({ answer: 'D', durationMs: 9_000 })
    for (const question of [list[1], list[3], list[4], list[5], list[6]]) {
      expect(question.answered).toBeNull()
    }

    // KEYED 图片段（卷内第 4 题 = political 第 1 题）投影为 /api/img 绝对 URL
    const keyedStem = list[3].stem as RichContent
    expect((keyedStem[1] as Extract<RichSegment, { type: 'image' }>).path).toBe(
      `${ORIGIN}/api/img/${fakeImageKey(0)}`,
    )
    // 源相对路径段（卷内第 7 题 = political 第 12 题）原样保留，防误构造
    const legacyStem = list[6].stem as RichContent
    expect((legacyStem[1] as Extract<RichSegment, { type: 'image' }>).path).toBe(LEGACY_IMAGE_PATH)
  })

  it('submitted 会话可回看：任意 status 均可取详情（交卷后回看态）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const sessionId = await insertMockSessionRow({
      userId,
      blueprintId: fixture.blueprintId,
      paperId: fixture.paperId,
      questionIds: fixture.paperQuestionIds.slice(0, 2),
      totalMinutes: 10,
      overrides: { status: 'submitted' },
    })
    const { status, body } = await requestJson(`/api/mock/sessions/${sessionId}`, bearerGet(token))
    expect(status).toBe(200)
    expect(body.status).toBe('submitted')
    expect(questionList(body)).toHaveLength(2)
  })

  it('建会话响应与 GET /:id 同构（同 id 两形状逐字段一致）', async () => {
    const token = await registerForToken('alice')
    const created = await requestJson(
      '/api/mock/sessions',
      bearerPost(token, { paperId: fixture.paperId, totalMinutes: 15 }),
    )
    expect(created.status).toBe(201)
    const fetched = await requestJson(`/api/mock/sessions/${numberField(created.body, 'id')}`, bearerGet(token))
    expect(fetched.status).toBe(200)
    expect(fetched.body).toEqual(created.body)
  })
})

describe('鉴权（三端点）', () => {
  it('缺 token：401 + unauthorized 信封', async () => {
    const outcomes = [
      await requestJson('/api/mock/sessions', postJson({ paperId: fixture.paperId })),
      await requestJson('/api/mock/sessions', { method: 'GET' }),
      await requestJson('/api/mock/sessions/1', { method: 'GET' }),
    ]
    for (const { status, body } of outcomes) {
      expect(status).toBe(401)
      expect(errorField(body).code).toBe('unauthorized')
    }
  })
})
