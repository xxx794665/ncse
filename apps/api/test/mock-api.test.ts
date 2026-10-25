import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BLUEPRINT_CODE, type RichContent, type RichSegment } from '@ncse/shared'
import { blueprints, examTypes, mockSessions, papers, questions, reinforceQueue, users } from '../src/db/schema'
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
import { db, fakeImageKey, insertQuestion, insertWrongBookEntry, LEGACY_IMAGE_PATH, userIdOf, wrongBookRowOf } from './practice-fixtures'
import {
  insertMockAnswerRow,
  insertMockFixture,
  insertMockSessionRow,
  insertPaperRow,
  linkBlueprintModules,
  linkPaperQuestions,
  mockAnswerRowsOf,
  type BlueprintModulePlanInput,
  type MockFixture,
} from './mock-fixtures'

/**
 * 整卷模拟·模考会话 API 集成测试（T2-01b）：经 worker 入口走真实 fetch（含路由挂载与
 * onError 错误信封），D1 为 workerd 内本地实例。夹具链复用 practice-fixtures 内容题库 +
 * mock-fixtures 蓝图/试卷/归属/会话/作答直插（卷题集序刻意与题目 id 大小序不同，
 * 验证快照按 question_papers.sequence 取序）。
 * 覆盖生命周期三端点、作答/计时上报两端点（upsert/防回退/已交卷拒绝——交卷即定卷）
 * 与交卷判分/成绩单两端点（统一判分落 isCorrect/isTimeout、错题本联动 D8、需加强队列
 * 汇入 M3 D5（T3-01e，模考仅汇入不做出队）、summary/modules/questions 聚合口径；
 * 判分测试蓝图挂自造小值明细，边界断言清晰）。
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

describe('鉴权（五端点）', () => {
  it('缺 token：401 + unauthorized 信封', async () => {
    const outcomes = [
      await requestJson('/api/mock/sessions', postJson({ paperId: fixture.paperId })),
      await requestJson('/api/mock/sessions', { method: 'GET' }),
      await requestJson('/api/mock/sessions/1', { method: 'GET' }),
      await requestJson('/api/mock/sessions/1/answers', postJson({ questionId: 1, answer: 'A', durationMs: 1000 })),
      await requestJson('/api/mock/sessions/1/timer', postJson({ elapsedMs: 1000 })),
    ]
    for (const { status, body } of outcomes) {
      expect(status).toBe(401)
      expect(errorField(body).code).toBe('unauthorized')
    }
  })
})

describe('作答与计时（T2-01b）', () => {
  /** 走 POST 建会话真实路径造进行中会话（缺省 7 题快照），返回 token 与 sessionId */
  async function createInProgressSession(username = 'alice'): Promise<{ token: string; sessionId: number }> {
    const token = await registerForToken(username)
    const created = await requestJson('/api/mock/sessions', bearerPost(token, { paperId: fixture.paperId }))
    expect(created.status).toBe(201)
    return { token, sessionId: numberField(created.body, 'id') }
  }

  /** 提交作答（作答端点简写） */
  function submitAnswer(sessionId: number, token: string, body: unknown) {
    return requestJson(`/api/mock/sessions/${sessionId}/answers`, bearerPost(token, body))
  }

  /** 上报计时（计时端点简写） */
  function reportTimer(sessionId: number, token: string, body: unknown) {
    return requestJson(`/api/mock/sessions/${sessionId}/timer`, bearerPost(token, body))
  }

  /* ---------- POST /sessions/:id/answers（逐题作答 upsert） ---------- */

  it('首答：200，mock_answers 行落值 answer/durationMs、判分字段不触碰（isCorrect null），answeredCount 1，响应键集恰为 questionId/answeredCount', async () => {
    const { token, sessionId } = await createInProgressSession()
    const questionId = fixture.paperQuestionIds[0]

    const { status, body } = await submitAnswer(sessionId, token, { questionId, answer: 'C', durationMs: 4_200 })

    expect(status).toBe(200)
    // 轻响应：D4 不回发题目/判分信息（toStrictEqual 连 undefined 键也拒绝）
    expect(Object.keys(body).sort()).toEqual(['answeredCount', 'questionId'])
    expect(numberField(body, 'questionId')).toBe(questionId)
    expect(numberField(body, 'answeredCount')).toBe(1)

    const rows = await mockAnswerRowsOf(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0].questionId).toBe(questionId)
    expect(rows[0].answer).toBe('C')
    expect(rows[0].durationMs).toBe(4_200)
    // 判分字段交卷才落值（isCorrect 可空列保持 null；isTimeout notNull 缺省 false）
    expect(rows[0].isCorrect).toBeNull()
    expect(rows[0].isTimeout).toBe(false)
  })

  it('改答案：同题二次提交覆盖为最新 answer；durationMs 取 max（先 5000 后 3000 → 5000 不缩水；先 3000 后 5000 → 5000）', async () => {
    const { token, sessionId } = await createInProgressSession()
    const [first, second] = [fixture.paperQuestionIds[0], fixture.paperQuestionIds[1]]

    // first 题回退方向：5000 → 3000，保留 5000；answer 覆盖为最新
    const firstSubmit = await submitAnswer(sessionId, token, { questionId: first, answer: 'A', durationMs: 5_000 })
    expect(firstSubmit.status).toBe(200)
    const firstRedo = await submitAnswer(sessionId, token, { questionId: first, answer: 'D', durationMs: 3_000 })
    expect(firstRedo.status).toBe(200)

    // second 题增长方向：3000 → 5000，取 5000
    await submitAnswer(sessionId, token, { questionId: second, answer: 'B', durationMs: 3_000 })
    const secondRedo = await submitAnswer(sessionId, token, { questionId: second, answer: 'C', durationMs: 5_000 })
    expect(numberField(secondRedo.body, 'answeredCount')).toBe(2)

    const rows = await mockAnswerRowsOf(sessionId)
    expect(rows).toHaveLength(2)
    const rowOf = (questionId: number) => rows.find((row) => row.questionId === questionId)
    // answer 最新胜、durationMs 防回退不缩水
    expect(rowOf(first)).toMatchObject({ answer: 'D', durationMs: 5_000 })
    expect(rowOf(second)).toMatchObject({ answer: 'C', durationMs: 5_000 })
  })

  it('每题 upsert 不加行：两题各两次提交 → 行数仍 2、answeredCount 首答后不再变', async () => {
    const { token, sessionId } = await createInProgressSession()
    const [first, second] = [fixture.paperQuestionIds[0], fixture.paperQuestionIds[1]]

    // 第一题：首答 1，重提仍是 1（冲突分支不加行，answeredCount 不变）
    const firstSubmit = await submitAnswer(sessionId, token, { questionId: first, answer: 'A', durationMs: 1_000 })
    expect(numberField(firstSubmit.body, 'answeredCount')).toBe(1)
    const firstRedo = await submitAnswer(sessionId, token, { questionId: first, answer: 'B', durationMs: 2_000 })
    expect(numberField(firstRedo.body, 'answeredCount')).toBe(1)

    // 第二题：首答 2，重提仍是 2
    const secondSubmit = await submitAnswer(sessionId, token, { questionId: second, answer: 'A', durationMs: 1_000 })
    expect(numberField(secondSubmit.body, 'answeredCount')).toBe(2)
    const secondRedo = await submitAnswer(sessionId, token, { questionId: second, answer: 'B', durationMs: 2_000 })
    expect(numberField(secondRedo.body, 'answeredCount')).toBe(2)

    expect(await mockAnswerRowsOf(sessionId)).toHaveLength(2)
  })

  it('悬空题目 id（快照内但题目行已删）：404 not_found「题目不存在」', async () => {
    const { token, sessionId } = await createInProgressSession()
    // 删快照末题的题目行（question_papers 级联清，会话 JSON 快照保留 id → 悬空）
    const danglingId = fixture.paperQuestionIds[6]
    await db.delete(questions).where(eq(questions.id, danglingId))

    const { status, body } = await submitAnswer(sessionId, token, { questionId: danglingId, answer: 'A', durationMs: 1_000 })
    expect(status).toBe(404)
    const error = errorField(body)
    expect(error.code).toBe('not_found')
    expect(error.message).toBe('题目不存在')
  })

  it('题目不在会话内（题行存在但未挂卷）：400 bad_request「题目不在会话内」', async () => {
    const { token, sessionId } = await createInProgressSession()
    // 政治理论第 6 题在题库但不在 7 题卷快照内（不落「题目不存在」分支）
    const notInPaper = fixture.content.politicalQuestionIds[5]

    const { status, body } = await submitAnswer(sessionId, token, { questionId: notInPaper, answer: 'A', durationMs: 1_000 })
    expect(status).toBe(400)
    const error = errorField(body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toBe('题目不在会话内')
  })

  it.each([
    { case: '0', questionId: 0 },
    { case: '小数 1.5', questionId: 1.5 },
    { case: '字符串 "1"', questionId: '1' },
    { case: '缺失', questionId: undefined },
  ])('questionId 非正整数（$case）：400 bad_request「questionId 必须是正整数」', async ({ questionId }) => {
    const { token, sessionId } = await createInProgressSession()
    const { status, body } = await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 1_000 })
    expect(status).toBe(400)
    const error = errorField(body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toBe('questionId 必须是正整数')
  })

  it.each([
    { case: "选项键外 'E'", answer: 'E' },
    { case: '非字符串 42', answer: 42 },
  ])('answer 非选项键（$case）：400 bad_request「answer 必须是题目选项键之一」', async ({ answer }) => {
    const { token, sessionId } = await createInProgressSession()
    const { status, body } = await submitAnswer(sessionId, token, {
      questionId: fixture.paperQuestionIds[0],
      answer,
      durationMs: 1_000,
    })
    expect(status).toBe(400)
    const error = errorField(body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toBe('answer 必须是题目选项键之一')
  })

  it.each([
    { case: '负数 -1', durationMs: -1 },
    { case: '恰达上限 86400000', durationMs: 86_400_000 },
    { case: '非整数 1.5', durationMs: 1.5 },
  ])('durationMs 越界（$case）：400 bad_request，消息含区间', async ({ durationMs }) => {
    const { token, sessionId } = await createInProgressSession()
    const { status, body } = await submitAnswer(sessionId, token, {
      questionId: fixture.paperQuestionIds[0],
      answer: 'A',
      durationMs,
    })
    expect(status).toBe(400)
    const error = errorField(body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toContain('durationMs')
    expect(error.message).toContain('0 到 86400000')
  })

  it.each(['submitted', 'abandoned'] as const)(
    '已交卷会话（%s）作答：400 bad_request「会话已交卷，不可再作答」（交卷即定卷）',
    async (sessionStatus) => {
      const token = await registerForToken('alice')
      const userId = await userIdOf('alice')
      const sessionId = await insertMockSessionRow({
        userId,
        blueprintId: fixture.blueprintId,
        paperId: fixture.paperId,
        questionIds: fixture.paperQuestionIds.slice(0, 2),
        totalMinutes: 10,
        overrides: { status: sessionStatus },
      })

      const { status, body } = await submitAnswer(sessionId, token, {
        questionId: fixture.paperQuestionIds[0],
        answer: 'A',
        durationMs: 1_000,
      })
      expect(status).toBe(400)
      const error = errorField(body)
      expect(error.code).toBe('bad_request')
      expect(error.message).toBe('会话已交卷，不可再作答')
      // 拒绝后不落任何作答行
      expect(await mockAnswerRowsOf(sessionId)).toHaveLength(0)
    },
  )

  it('他人会话/不存在 id/非数字 id：404 同文案「会话不存在」（防存在性探测）', async () => {
    const alice = await createInProgressSession('alice')
    const tokenBob = await registerForToken('bob')
    const answerBody = { questionId: fixture.paperQuestionIds[0], answer: 'A', durationMs: 1_000 }

    const foreign = await submitAnswer(alice.sessionId, tokenBob, answerBody)
    expect(foreign.status).toBe(404)
    const foreignError = errorField(foreign.body)
    expect(foreignError.code).toBe('not_found')
    expect(foreignError.message).toBe('会话不存在')

    const missing = await submitAnswer(999_999, alice.token, answerBody)
    expect(missing.status).toBe(404)
    expect(errorField(missing.body).message).toBe('会话不存在')

    const nonNumeric = await requestJson('/api/mock/sessions/abc/answers', bearerPost(alice.token, answerBody))
    expect(nonNumeric.status).toBe(404)
    expect(errorField(nonNumeric.body).message).toBe('会话不存在')
  })

  it('请求体非 JSON 对象（数组）：两端点均 400 bad_request', async () => {
    const { token, sessionId } = await createInProgressSession()
    const answer = await requestJson(`/api/mock/sessions/${sessionId}/answers`, bearerPost(token, [1, 2]))
    expect(answer.status).toBe(400)
    expect(errorField(answer.body).code).toBe('bad_request')

    const timer = await requestJson(`/api/mock/sessions/${sessionId}/timer`, bearerPost(token, [1, 2]))
    expect(timer.status).toBe(400)
    expect(errorField(timer.body).code).toBe('bad_request')
  })

  /* ---------- POST /sessions/:id/timer（计时上报） ---------- */

  it('首次上报：200 回发 elapsedMs、响应键集恰一项，会话行落值', async () => {
    const { token, sessionId } = await createInProgressSession()

    const { status, body } = await reportTimer(sessionId, token, { elapsedMs: 61_800 })

    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['elapsedMs'])
    expect(numberField(body, 'elapsedMs')).toBe(61_800)

    const sessionRow = (
      await db.select({ elapsedMs: mockSessions.elapsedMs }).from(mockSessions).where(eq(mockSessions.id, sessionId))
    ).at(0)
    expect(sessionRow?.elapsedMs).toBe(61_800)
  })

  it('回退上报不缩水：先 60000 后 30000 → 回发与落库均 60000（服务端 max 防回退）', async () => {
    const { token, sessionId } = await createInProgressSession()

    const first = await reportTimer(sessionId, token, { elapsedMs: 60_000 })
    expect(first.status).toBe(200)
    expect(numberField(first.body, 'elapsedMs')).toBe(60_000)

    const regressed = await reportTimer(sessionId, token, { elapsedMs: 30_000 })
    expect(regressed.status).toBe(200)
    expect(numberField(regressed.body, 'elapsedMs')).toBe(60_000)

    const sessionRow = (
      await db.select({ elapsedMs: mockSessions.elapsedMs }).from(mockSessions).where(eq(mockSessions.id, sessionId))
    ).at(0)
    expect(sessionRow?.elapsedMs).toBe(60_000)
  })

  it.each([
    { case: '负数 -1', elapsedMs: -1 },
    { case: '恰达上限 86400000', elapsedMs: 86_400_000 },
    { case: '非整数 1.5', elapsedMs: 1.5 },
  ])('计时 elapsedMs 越界（$case）：400 bad_request，消息含区间', async ({ elapsedMs }) => {
    const { token, sessionId } = await createInProgressSession()
    const { status, body } = await reportTimer(sessionId, token, { elapsedMs })
    expect(status).toBe(400)
    const error = errorField(body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toContain('elapsedMs')
    expect(error.message).toContain('0 到 86400000')
  })

  it.each(['submitted', 'abandoned'] as const)(
    '已交卷会话（%s）上报计时：400 bad_request「会话已交卷，不可更新计时」',
    async (sessionStatus) => {
      const token = await registerForToken('alice')
      const userId = await userIdOf('alice')
      const sessionId = await insertMockSessionRow({
        userId,
        blueprintId: fixture.blueprintId,
        paperId: fixture.paperId,
        questionIds: fixture.paperQuestionIds.slice(0, 2),
        totalMinutes: 10,
        overrides: { status: sessionStatus },
      })

      const { status, body } = await reportTimer(sessionId, token, { elapsedMs: 60_000 })
      expect(status).toBe(400)
      const error = errorField(body)
      expect(error.code).toBe('bad_request')
      expect(error.message).toBe('会话已交卷，不可更新计时')
    },
  )

  it('计时上报他人会话/非数字 id：404 同文案「会话不存在」（防存在性探测）', async () => {
    const alice = await createInProgressSession('alice')
    const tokenBob = await registerForToken('bob')

    const foreign = await reportTimer(alice.sessionId, tokenBob, { elapsedMs: 60_000 })
    expect(foreign.status).toBe(404)
    const foreignError = errorField(foreign.body)
    expect(foreignError.code).toBe('not_found')
    expect(foreignError.message).toBe('会话不存在')

    const nonNumeric = await requestJson('/api/mock/sessions/abc/timer', bearerPost(alice.token, { elapsedMs: 60_000 }))
    expect(nonNumeric.status).toBe(404)
    expect(errorField(nonNumeric.body).message).toBe('会话不存在')
  })
})

describe('交卷判分与成绩单（T2-01b）', () => {
  /**
   * 判分测试蓝图明细（自造小值断言更清晰；每题秒数由被测端点经 shared 推导）：
   * political_theory 2 题 1 分钟 → 每题 30s、common_sense 3 题 1 分钟 → 每题 20s（floor(60/3)）；
   * 序刻意与字典序相反（political_theory 先于 common_sense——验证成绩单模块序取蓝图序）；
   * judgement 刻意不入蓝图（蓝图外模块不判超时 + 成绩单模块殿后组用例）。
   */
  const GRADING_PLANS: BlueprintModulePlanInput[] = [
    { module: 'political_theory', questionCount: 2, timeLimitMinutes: 1 },
    { module: 'common_sense', questionCount: 3, timeLimitMinutes: 1 },
  ]

  /** 直插进行中会话（缺省 status in_progress、totalMinutes 10），返回 token 与 sessionId */
  async function createGradingSession(
    username: string,
    questionIds: number[],
  ): Promise<{ token: string; sessionId: number }> {
    const token = await registerForToken(username)
    const sessionId = await insertMockSessionRow({
      userId: await userIdOf(username),
      blueprintId: fixture.blueprintId,
      paperId: fixture.paperId,
      questionIds,
      totalMinutes: 10,
    })
    return { token, sessionId }
  }

  /** 交卷（无请求体——端点无入参，不发 Content-Type/体） */
  function submitSession(sessionId: number, token: string) {
    return requestJson(`/api/mock/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  }

  /** 取成绩单 */
  function fetchReport(sessionId: number, token: string) {
    return requestJson(`/api/mock/sessions/${sessionId}/report`, bearerGet(token))
  }

  /** 直查强化队列行（undefined = 不在册；交卷汇入需加强队列的落库断言用，T3-01e） */
  async function reinforceRowOf(userId: number, questionId: number) {
    const rows = await db
      .select()
      .from(reinforceQueue)
      .where(and(eq(reinforceQueue.userId, userId), eq(reinforceQueue.questionId, questionId)))
    return rows.at(0)
  }

  /* ---------- POST /sessions/:id/submit（交卷统一判分） ---------- */

  it('交卷主流程：3 题卷（答对/答错/未答）无请求体 200 回成绩单；isCorrect 库内落值 1/0/null、isTimeout 落 false；summary 计数精确；status 翻 submitted、submittedAt 落值；重复交卷（空对象体）400「会话已交卷」', async () => {
    const [judgementId, politicalId, commonId] = fixture.paperQuestionIds
    const { token, sessionId } = await createGradingSession('alice', [politicalId, commonId, judgementId])
    // 题库答案缺省 'B'：B 答对、A 答错、判断题未答；蓝图缺省无明细（防御分支：全部不判超时）
    await insertMockAnswerRow(sessionId, politicalId, { answer: 'B', durationMs: 5_000 })
    await insertMockAnswerRow(sessionId, commonId, { answer: 'A', durationMs: 6_000 })

    const { status, body } = await submitSession(sessionId, token)

    expect(status).toBe(200)
    expect(body.summary).toEqual({
      total: 3,
      answered: 2,
      correct: 1,
      unanswered: 1,
      timeoutCount: 0,
      totalDurationMs: 11_000,
    })
    // 逐题项 = 快照序，未答题 answer/isCorrect null、用时 0
    expect(questionList(body)).toEqual([
      { questionId: politicalId, moduleCode: 'political_theory', answer: 'B', isCorrect: true, isTimeout: false, durationMs: 5_000 },
      { questionId: commonId, moduleCode: 'common_sense', answer: 'A', isCorrect: false, isTimeout: false, durationMs: 6_000 },
      { questionId: judgementId, moduleCode: 'judgement', answer: null, isCorrect: null, isTimeout: false, durationMs: 0 },
    ])

    // 判分落库（库内断言）：isCorrect 落值、isTimeout notNull 落 false
    const rows = await mockAnswerRowsOf(sessionId)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.questionId === politicalId)).toMatchObject({ isCorrect: true, isTimeout: false })
    expect(rows.find((row) => row.questionId === commonId)).toMatchObject({ isCorrect: false, isTimeout: false })

    // 会话翻 submitted、submittedAt 落值（ISO 文本）
    const sessionRow = (
      await db
        .select({ status: mockSessions.status, submittedAt: mockSessions.submittedAt })
        .from(mockSessions)
        .where(eq(mockSessions.id, sessionId))
    ).at(0)
    expect(sessionRow?.status).toBe('submitted')
    expect(sessionRow?.submittedAt).not.toBeNull()

    // 重复交卷拒绝（空对象请求体亦可——端点本就无入参）；文案「会话已交卷」
    const repeat = await requestJson(`/api/mock/sessions/${sessionId}/submit`, bearerPost(token, {}))
    expect(repeat.status).toBe(400)
    const error = errorField(repeat.body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toBe('会话已交卷')
  })

  it('isTimeout 边界（蓝图小值：common_sense 每题 20s）：恰等于时限不超、严格大于判超；蓝图未含模块（judgement）不判超时', async () => {
    await linkBlueprintModules(fixture.blueprintId, fixture.content.moduleIds, GRADING_PLANS)
    const [judgementId, , commonExactId, , commonOverId] = fixture.paperQuestionIds
    const { token, sessionId } = await createGradingSession('alice', [commonExactId, commonOverId, judgementId])
    await insertMockAnswerRow(sessionId, commonExactId, { answer: 'B', durationMs: 20_000 })
    await insertMockAnswerRow(sessionId, commonOverId, { answer: 'B', durationMs: 20_001 })
    await insertMockAnswerRow(sessionId, judgementId, { answer: 'B', durationMs: 600_000 })

    const { status, body } = await submitSession(sessionId, token)

    expect(status).toBe(200)
    const rows = await mockAnswerRowsOf(sessionId)
    expect(rows.find((row) => row.questionId === commonExactId)?.isTimeout).toBe(false)
    expect(rows.find((row) => row.questionId === commonOverId)?.isTimeout).toBe(true)
    expect(rows.find((row) => row.questionId === judgementId)?.isTimeout).toBe(false)
    expect(body.summary).toMatchObject({ timeoutCount: 1 })
  })

  it('改答案后交卷判最新值（走真实作答端点）：先答 A 再改 B → answer=B 判对', async () => {
    const token = await registerForToken('alice')
    const created = await requestJson('/api/mock/sessions', bearerPost(token, { paperId: fixture.paperId }))
    expect(created.status).toBe(201)
    const sessionId = numberField(created.body, 'id')
    const questionId = fixture.paperQuestionIds[0]

    const first = await requestJson(
      `/api/mock/sessions/${sessionId}/answers`,
      bearerPost(token, { questionId, answer: 'A', durationMs: 1_000 }),
    )
    expect(first.status).toBe(200)
    const second = await requestJson(
      `/api/mock/sessions/${sessionId}/answers`,
      bearerPost(token, { questionId, answer: 'B', durationMs: 1_500 }),
    )
    expect(second.status).toBe(200)

    const { status, body } = await submitSession(sessionId, token)
    expect(status).toBe(200)
    // 库内与成绩单均按最新 answer 判分
    expect(await mockAnswerRowsOf(sessionId)).toHaveLength(1)
    expect((await mockAnswerRowsOf(sessionId))[0]).toMatchObject({ answer: 'B', isCorrect: true })
    expect(questionList(body)[0]).toMatchObject({ questionId, answer: 'B', isCorrect: true })
  })

  it('错题本联动（D8）：答错新题入册 active/wrongCount 1；既有 eliminated 条目复活 active 且计数累加；答对题与未答题不动在册条目（模考答对非重做）', async () => {
    const [judgementId, newWrongId, correctId, reviveId] = fixture.paperQuestionIds
    const { token, sessionId } = await createGradingSession('alice', [newWrongId, reviveId, correctId, judgementId])
    const userId = await userIdOf('alice')
    // 前置在册：reviveId eliminated（答错复活）、correctId active（答对不动）、judgementId hard（未答不动）
    await insertWrongBookEntry(userId, reviveId, { status: 'eliminated', wrongCount: 2, redoCount: 1, consecutiveCorrect: 3 })
    await insertWrongBookEntry(userId, correctId, { status: 'active', wrongCount: 1, redoCount: 5, consecutiveCorrect: 2 })
    await insertWrongBookEntry(userId, judgementId, { status: 'hard', wrongCount: 1, redoCount: 0, consecutiveCorrect: 0 })
    await insertMockAnswerRow(sessionId, newWrongId, { answer: 'A' })
    await insertMockAnswerRow(sessionId, reviveId, { answer: 'A' })
    await insertMockAnswerRow(sessionId, correctId, { answer: 'B' })

    const { status } = await submitSession(sessionId, token)
    expect(status).toBe(200)

    // 答错新题：插入分支 active/wrongCount 1/redoCount 0/连对 0
    expect(await wrongBookRowOf(userId, newWrongId)).toMatchObject({
      status: 'active',
      wrongCount: 1,
      redoCount: 0,
      consecutiveCorrect: 0,
    })
    // 答错在册（eliminated）：复活 active、wrongCount/redoCount 累加、连对清零
    expect(await wrongBookRowOf(userId, reviveId)).toMatchObject({
      status: 'active',
      wrongCount: 3,
      redoCount: 2,
      consecutiveCorrect: 0,
    })
    // 答对在册：不动（本片解释——练习复习闭环才累加 redoCount，模考答对非重做）
    expect(await wrongBookRowOf(userId, correctId)).toMatchObject({
      status: 'active',
      wrongCount: 1,
      redoCount: 5,
      consecutiveCorrect: 2,
    })
    // 未答在册：不动
    expect(await wrongBookRowOf(userId, judgementId)).toMatchObject({
      status: 'hard',
      wrongCount: 1,
      redoCount: 0,
      consecutiveCorrect: 0,
    })
  })

  /* ---------- 需加强队列联动（T3-01e，M3 D5 同口径汇入；模考仅汇入不做出队） ---------- */

  it('交卷汇入需加强队列：答错 → pending/wrong（resolved 行复活）；答对但超时 → pending/timeout；未答题不入队', async () => {
    // 蓝图挂小值明细：political_theory 每题 30s（floor(60/2)）——30_001 判超
    await linkBlueprintModules(fixture.blueprintId, fixture.content.moduleIds, GRADING_PLANS)
    const [judgementId, wrongId, , correctTimeoutId] = fixture.paperQuestionIds
    const { token, sessionId } = await createGradingSession('alice', [wrongId, correctTimeoutId, judgementId])
    const userId = await userIdOf('alice')
    // 前置 resolved 行：交卷答错复活为 pending（M3 D5——resolved 行汇入复活，reason 覆盖）
    await db.insert(reinforceQueue).values({ userId, questionId: wrongId, reason: 'timeout', status: 'resolved' })
    // 题库答案缺省 'B'：wrongId 答 A 答错不超时、correctTimeoutId 答 B 答对但超时；judgementId 未答
    await insertMockAnswerRow(sessionId, wrongId, { answer: 'A', durationMs: 5_000 })
    await insertMockAnswerRow(sessionId, correctTimeoutId, { answer: 'B', durationMs: 30_001 })

    const { status } = await submitSession(sessionId, token)
    expect(status).toBe(200)

    // 答错（不超时）：复活 pending、reason 覆盖为 wrong
    expect(await reinforceRowOf(userId, wrongId)).toMatchObject({ status: 'pending', reason: 'wrong' })
    // 答对但超时：汇入 pending/timeout（与练习判分同口径）
    expect(await reinforceRowOf(userId, correctTimeoutId)).toMatchObject({ status: 'pending', reason: 'timeout' })
    // 未答题：无作答行，天然不汇入
    expect(await reinforceRowOf(userId, judgementId)).toBeUndefined()
  })

  it('模考保守口径：答对且不超时不出队——在册 pending 行保持 pending 原样（模考答对非重做，出队只发生在练习判分）', async () => {
    const [judgementId, wrongId, correctId] = fixture.paperQuestionIds
    const { token, sessionId } = await createGradingSession('alice', [wrongId, correctId, judgementId])
    const userId = await userIdOf('alice')
    // 前置在册 pending 行：correctId 将答对（B、不超时）——保守保持 pending，不做出队
    await db.insert(reinforceQueue).values({ userId, questionId: correctId, reason: 'wrong', status: 'pending' })
    // 蓝图缺省无明细（防御分支：全部不判超时）→ correctId 答对即「答对且不超时」
    await insertMockAnswerRow(sessionId, correctId, { answer: 'B', durationMs: 5_000 })
    await insertMockAnswerRow(sessionId, wrongId, { answer: 'A', durationMs: 6_000 })

    const { status } = await submitSession(sessionId, token)
    expect(status).toBe(200)

    // 答对且不超时：在册 pending 行原样保持（模考不做出队——保守口径见 submit 端点内注释）
    expect(await reinforceRowOf(userId, correctId)).toMatchObject({ status: 'pending', reason: 'wrong' })
    // 答错照常汇入；未答题不动
    expect(await reinforceRowOf(userId, wrongId)).toMatchObject({ status: 'pending', reason: 'wrong' })
    expect(await reinforceRowOf(userId, judgementId)).toBeUndefined()
  })

  it('悬空题目 id（快照内但题目行已删）：交卷不炸，成绩单 total 不计悬空、其模块组不出现（无蓝图明细 → 模块序退化为字典序）；悬空题作答行随题级联删', async () => {
    const [judgementId, politicalId, commonId] = fixture.paperQuestionIds
    const { token, sessionId } = await createGradingSession('alice', [judgementId, politicalId, commonId])
    await insertMockAnswerRow(sessionId, judgementId, { answer: 'A' })
    await insertMockAnswerRow(sessionId, politicalId, { answer: 'B' })
    await insertMockAnswerRow(sessionId, commonId, { answer: 'B' })
    // 删判断题行（question_papers 与 mock_answers 该题行级联删，会话 JSON 快照保留 id → 悬空）
    await db.delete(questions).where(eq(questions.id, judgementId))

    const { status, body } = await submitSession(sessionId, token)

    expect(status).toBe(200)
    expect(body.summary).toEqual({
      total: 2,
      answered: 2,
      correct: 2,
      unanswered: 0,
      timeoutCount: 0,
      totalDurationMs: 6_000,
    })
    // judgement 组不出现；蓝图无明细 → 模块序全字典序（common_sense 先于 political_theory）
    const moduleCodes = (body.modules as unknown as { moduleCode: string }[]).map((row) => row.moduleCode)
    expect(moduleCodes).toEqual(['common_sense', 'political_theory'])
    expect(questionList(body).map((question) => numberField(question, 'questionId'))).toEqual([politicalId, commonId])
  })

  it.each(['submitted', 'abandoned'] as const)(
    '已定卷会话（%s）交卷：400 bad_request「会话已交卷」（重复交卷拒绝；判分与错题本不重复副作用）',
    async (sessionStatus) => {
      const token = await registerForToken('alice')
      const userId = await userIdOf('alice')
      const politicalId = fixture.paperQuestionIds[1]
      const sessionId = await insertMockSessionRow({
        userId,
        blueprintId: fixture.blueprintId,
        paperId: fixture.paperId,
        questionIds: [politicalId],
        totalMinutes: 10,
        overrides: { status: sessionStatus },
      })
      await insertMockAnswerRow(sessionId, politicalId, { answer: 'A' })

      const { status, body } = await submitSession(sessionId, token)
      expect(status).toBe(400)
      const error = errorField(body)
      expect(error.code).toBe('bad_request')
      expect(error.message).toBe('会话已交卷')
      // 拒绝后不判分（isCorrect 保持 null）、不动错题本
      expect((await mockAnswerRowsOf(sessionId))[0].isCorrect).toBeNull()
      expect(await wrongBookRowOf(userId, politicalId)).toBeUndefined()
    },
  )

  it('交卷与成绩单：他人会话/不存在 id/非数字 id 一律 404 同文案「会话不存在」（防存在性探测）', async () => {
    const { token: tokenAlice, sessionId } = await createGradingSession('alice', fixture.paperQuestionIds.slice(0, 2))
    const tokenBob = await registerForToken('bob')

    const foreignSubmit = await submitSession(sessionId, tokenBob)
    expect(foreignSubmit.status).toBe(404)
    expect(errorField(foreignSubmit.body).message).toBe('会话不存在')
    const foreignReport = await fetchReport(sessionId, tokenBob)
    expect(foreignReport.status).toBe(404)
    expect(errorField(foreignReport.body).message).toBe('会话不存在')

    const missingSubmit = await submitSession(999_999, tokenAlice)
    expect(missingSubmit.status).toBe(404)
    expect(errorField(missingSubmit.body).message).toBe('会话不存在')
    const missingReport = await fetchReport(999_999, tokenAlice)
    expect(missingReport.status).toBe(404)
    expect(errorField(missingReport.body).message).toBe('会话不存在')

    const nonNumericSubmit = await requestJson('/api/mock/sessions/abc/submit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAlice}` },
    })
    expect(nonNumericSubmit.status).toBe(404)
    expect(errorField(nonNumericSubmit.body).message).toBe('会话不存在')
    const nonNumericReport = await requestJson('/api/mock/sessions/abc/report', bearerGet(tokenAlice))
    expect(nonNumericReport.status).toBe(404)
    expect(errorField(nonNumericReport.body).message).toBe('会话不存在')
  })

  it('缺 token：交卷与成绩单均 401 + unauthorized 信封', async () => {
    const outcomes = [
      await requestJson('/api/mock/sessions/1/submit', { method: 'POST' }),
      await requestJson('/api/mock/sessions/1/report', { method: 'GET' }),
    ]
    for (const { status, body } of outcomes) {
      expect(status).toBe(401)
      expect(errorField(body).code).toBe('unauthorized')
    }
  })

  it('交卷后作答被拒（回归既有作答端点）：400「会话已交卷，不可再作答」，不落新作答行', async () => {
    const token = await registerForToken('alice')
    const created = await requestJson('/api/mock/sessions', bearerPost(token, { paperId: fixture.paperId }))
    expect(created.status).toBe(201)
    const sessionId = numberField(created.body, 'id')
    const questionId = fixture.paperQuestionIds[0]
    const answered = await requestJson(
      `/api/mock/sessions/${sessionId}/answers`,
      bearerPost(token, { questionId, answer: 'B', durationMs: 1_000 }),
    )
    expect(answered.status).toBe(200)
    const submitted = await submitSession(sessionId, token)
    expect(submitted.status).toBe(200)

    const rejected = await requestJson(
      `/api/mock/sessions/${sessionId}/answers`,
      bearerPost(token, { questionId: fixture.paperQuestionIds[1], answer: 'A', durationMs: 1_000 }),
    )
    expect(rejected.status).toBe(400)
    expect(errorField(rejected.body).message).toBe('会话已交卷，不可再作答')
    expect(await mockAnswerRowsOf(sessionId)).toHaveLength(1)
  })

  it('交卷后 GET /:id 详情仍可取（回归）：status submitted、answeredCount 正常、已答回显仅 answer+durationMs（判分字段不下发，D4）', async () => {
    const [judgementId, politicalId] = fixture.paperQuestionIds
    const { token, sessionId } = await createGradingSession('alice', [politicalId, judgementId])
    await insertMockAnswerRow(sessionId, politicalId, { answer: 'B', durationMs: 5_000 })
    const submitted = await submitSession(sessionId, token)
    expect(submitted.status).toBe(200)

    const detail = await requestJson(`/api/mock/sessions/${sessionId}`, bearerGet(token))
    expect(detail.status).toBe(200)
    expect(detail.body.status).toBe('submitted')
    expect(numberField(detail.body, 'answeredCount')).toBe(1)
    const list = questionList(detail.body)
    expect(list).toHaveLength(2)
    expect(list[0].answered).toStrictEqual({ answer: 'B', durationMs: 5_000 })
    expect(list[0].answered).not.toHaveProperty('isCorrect')
    expect(list[1].answered).toBeNull()
  })

  /* ---------- GET /sessions/:id/report（成绩单聚合） ---------- */

  it('成绩单模块分组：序 = 蓝图模块序（political_theory 先于 common_sense，非字典序）、蓝图外模块（judgement）字典序殿后；各组计数/用时求和精确、逐题项快照序与键集精确', async () => {
    await linkBlueprintModules(fixture.blueprintId, fixture.content.moduleIds, GRADING_PLANS)
    const [judgementId, politicalFirstId, commonFirstId, politicalSecondId, commonSecondId] = fixture.paperQuestionIds
    const { token, sessionId } = await createGradingSession('alice', [
      politicalFirstId,
      commonFirstId,
      politicalSecondId,
      commonSecondId,
      judgementId,
    ])
    await insertMockAnswerRow(sessionId, politicalFirstId, { answer: 'B', durationMs: 4_000 })
    await insertMockAnswerRow(sessionId, politicalSecondId, { answer: 'A', durationMs: 5_000 })
    await insertMockAnswerRow(sessionId, commonFirstId, { answer: 'B', durationMs: 3_000 })
    // 常识题每题 20s：25_000 严格大于 → 答错且超时
    await insertMockAnswerRow(sessionId, commonSecondId, { answer: 'A', durationMs: 25_000 })

    const { status, body } = await submitSession(sessionId, token)

    expect(status).toBe(200)
    expect(body.summary).toEqual({
      total: 5,
      answered: 4,
      correct: 2,
      unanswered: 1,
      timeoutCount: 1,
      totalDurationMs: 37_000,
    })
    // 模块序 = 蓝图序（political_theory → common_sense），judgement（蓝图外）殿后
    expect(body.modules).toEqual([
      { moduleCode: 'political_theory', total: 2, answered: 2, correct: 1, timeoutCount: 0, totalDurationMs: 9_000 },
      { moduleCode: 'common_sense', total: 2, answered: 2, correct: 1, timeoutCount: 1, totalDurationMs: 28_000 },
      { moduleCode: 'judgement', total: 1, answered: 0, correct: 0, timeoutCount: 0, totalDurationMs: 0 },
    ])
    // 计数给、率不给（无正确率等派生字段）
    for (const moduleReport of body.modules as unknown as Record<string, unknown>[]) {
      expect(Object.keys(moduleReport).sort()).toEqual([
        'answered',
        'correct',
        'moduleCode',
        'timeoutCount',
        'total',
        'totalDurationMs',
      ])
    }
    expect(questionList(body)).toEqual([
      { questionId: politicalFirstId, moduleCode: 'political_theory', answer: 'B', isCorrect: true, isTimeout: false, durationMs: 4_000 },
      { questionId: commonFirstId, moduleCode: 'common_sense', answer: 'B', isCorrect: true, isTimeout: false, durationMs: 3_000 },
      { questionId: politicalSecondId, moduleCode: 'political_theory', answer: 'A', isCorrect: false, isTimeout: false, durationMs: 5_000 },
      { questionId: commonSecondId, moduleCode: 'common_sense', answer: 'A', isCorrect: false, isTimeout: true, durationMs: 25_000 },
      { questionId: judgementId, moduleCode: 'judgement', answer: null, isCorrect: null, isTimeout: false, durationMs: 0 },
    ])
  })

  it('成绩单：in_progress 会话 400 bad_request「会话未交卷」（判分未落，聚合无依据）', async () => {
    const { token, sessionId } = await createGradingSession('alice', fixture.paperQuestionIds.slice(0, 2))
    const { status, body } = await fetchReport(sessionId, token)
    expect(status).toBe(400)
    const error = errorField(body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toBe('会话未交卷')
  })

  it('abandoned 会话成绩单可取：200，未判分行不计 answered（作答内容仍在逐题项回显）', async () => {
    const [, politicalId, commonId] = fixture.paperQuestionIds
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const sessionId = await insertMockSessionRow({
      userId,
      blueprintId: fixture.blueprintId,
      paperId: fixture.paperId,
      questionIds: [politicalId, commonId],
      totalMinutes: 10,
      overrides: { status: 'abandoned' },
    })
    await insertMockAnswerRow(sessionId, politicalId, { answer: 'A', durationMs: 4_000 })

    const { status, body } = await fetchReport(sessionId, token)
    expect(status).toBe(200)
    expect(body.summary).toEqual({
      total: 2,
      answered: 0,
      correct: 0,
      unanswered: 2,
      timeoutCount: 0,
      totalDurationMs: 0,
    })
    expect(questionList(body)).toEqual([
      { questionId: politicalId, moduleCode: 'political_theory', answer: 'A', isCorrect: null, isTimeout: false, durationMs: 4_000 },
      { questionId: commonId, moduleCode: 'common_sense', answer: null, isCorrect: null, isTimeout: false, durationMs: 0 },
    ])
  })

  it('交卷响应与 GET report 同构：同会话两形状逐字段一致（成绩单从库重算，交卷后可随时回看）', async () => {
    const [judgementId, politicalId, commonId] = fixture.paperQuestionIds
    const { token, sessionId } = await createGradingSession('alice', [politicalId, commonId, judgementId])
    await insertMockAnswerRow(sessionId, politicalId, { answer: 'B', durationMs: 5_000 })
    await insertMockAnswerRow(sessionId, commonId, { answer: 'A', durationMs: 6_000 })

    const submitted = await submitSession(sessionId, token)
    expect(submitted.status).toBe(200)
    const report = await fetchReport(sessionId, token)
    expect(report.status).toBe(200)
    expect(report.body).toEqual(submitted.body)
  })
})

describe('D1 绑定参数分批（T2-01b 热修）', () => {
  /**
   * Cloudflare D1 每查询最多 100 个绑定参数（线上实测 135 题整卷 inArray 触限；
   * 本地 miniflare 无此限制，本用例锁定的是分批合并语义——120 题 > 批大小 90，
   * 建会话/详情/判分三处跨批查询不得丢题、不得乱序）。
   */
  it('120 题整卷（跨 2 批）建会话/详情/逐题作答/交卷/成绩单全链路不丢题不乱序', async () => {
    const politicalModuleId = fixture.content.moduleIds.get('political_theory')
    if (politicalModuleId === undefined) throw new Error('模块 id 缺失')
    const stem: RichContent = [{ type: 'text', text: '分批查询题干' }]
    const questionIds: number[] = []
    for (let i = 0; i < 120; i++) {
      questionIds.push(await insertQuestion(politicalModuleId, `batch-d1-param-${i}`, stem, { answer: 'A' }))
    }
    const paperId = await insertPaperRow('分批查询测试卷（120 题）', { questionCount: 120 })
    await linkPaperQuestions(paperId, questionIds)

    const token = await registerForToken('alice')
    const created = await requestJson('/api/mock/sessions', bearerPost(token, { paperId, totalMinutes: 120 }))
    expect(created.status).toBe(201)
    expect(numberField(created.body, 'total')).toBe(120)
    const listedIds = questionList(created.body).map((question) => numberField(question, 'id'))
    // 跨批合并后题集完整（120 题、无重复）且序 = 挂卷 sequence 序
    expect(listedIds).toEqual(questionIds)
    expect(new Set(listedIds).size).toBe(120)

    // 详情端点同口径（fetchQuestionRows 与已答回显两处跨批）
    const detail = await requestJson(
      `/api/mock/sessions/${numberField(created.body, 'id')}`,
      bearerGet(token),
    )
    expect(detail.status).toBe(200)
    expect(questionList(detail.body).map((question) => numberField(question, 'id'))).toEqual(questionIds)

    // 全卷作答（fetchAnsweredByQuestion 跨批）+ 交卷判分（fetchGradingQuestionRows 跨批）
    const sessionId = numberField(created.body, 'id')
    for (const questionId of questionIds) {
      const answered = await requestJson(
        `/api/mock/sessions/${sessionId}/answers`,
        bearerPost(token, { questionId, answer: 'A', durationMs: 1_000 }),
      )
      expect(answered.status).toBe(200)
    }
    const submitted = await requestJson(`/api/mock/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(submitted.status).toBe(200)
    expect(submitted.body.summary).toEqual({
      total: 120,
      answered: 120,
      correct: 120,
      unanswered: 0,
      timeoutCount: 0,
      totalDurationMs: 120_000,
    })
    expect(questionList(submitted.body)).toHaveLength(120)
  })
})

describe('历史列表（T2-01e）', () => {
  /**
   * 直插历史列表夹具会话：缺省 status submitted + 7 题快照 + totalMinutes 10
   * （elapsedMs/submittedAt/题数/状态按 overrides 覆盖；submitted 会话的作答行另经
   * insertMockAnswerRow 直插——isCorrect/isTimeout 显式落值模拟交卷后已判分态）。
   */
  async function insertHistorySession(
    userId: number,
    overrides: {
      status?: 'in_progress' | 'submitted' | 'abandoned'
      submittedAt?: string
      elapsedMs?: number
      totalMinutes?: number
      questionCount?: number
    } = {},
  ): Promise<number> {
    return insertMockSessionRow({
      userId,
      blueprintId: fixture.blueprintId,
      paperId: fixture.paperId,
      questionIds: fixture.paperQuestionIds.slice(0, overrides.questionCount ?? 7),
      totalMinutes: overrides.totalMinutes ?? 10,
      overrides: {
        status: overrides.status ?? 'submitted',
        submittedAt: overrides.submittedAt,
        elapsedMs: overrides.elapsedMs,
      },
    })
  }

  it('空历史（本人无任何会话）：200 空数组', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/mock/history', bearerGet(token))
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('缺 token：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson('/api/mock/history', { method: 'GET' })
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })

  it('单条 submitted 会话：概要六数精确（未答=total-answered、超时与用时只计已判分行），卷名/年份/时长/计时/交卷时间正确', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [correctFirst, correctSecond, wrongTimeout, wrong] = fixture.paperQuestionIds
    const sessionId = await insertHistorySession(userId, {
      submittedAt: '2026-10-20T05:00:00.000Z',
      elapsedMs: 123_456,
      totalMinutes: 30,
      questionCount: 5,
    })
    await insertMockAnswerRow(sessionId, correctFirst, { answer: 'B', durationMs: 4_000, isCorrect: true })
    await insertMockAnswerRow(sessionId, correctSecond, { answer: 'B', durationMs: 5_000, isCorrect: true })
    await insertMockAnswerRow(sessionId, wrongTimeout, { answer: 'A', durationMs: 25_000, isCorrect: false, isTimeout: true })
    await insertMockAnswerRow(sessionId, wrong, { answer: 'A', durationMs: 6_000, isCorrect: false })
    // 快照第 5 题未答（无作答行）

    const { status, body } = await requestJson('/api/mock/history', bearerGet(token))
    expect(status).toBe(200)
    expect(body).toEqual([
      {
        id: sessionId,
        paperId: fixture.paperId,
        paperName: PAPER_NAME,
        paperYear: 2026,
        totalMinutes: 30,
        elapsedMs: 123_456,
        submittedAt: '2026-10-20T05:00:00.000Z',
        summary: { total: 5, answered: 4, correct: 2, unanswered: 1, timeoutCount: 1, totalDurationMs: 40_000 },
      },
    ])
  })

  it('多会话 submittedAt 倒序（并列 id 倒序稳定）；in_progress 与 abandoned 不出现（abandoned 未判分无成绩）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const oldest = await insertHistorySession(userId, { submittedAt: '2026-10-20T01:00:00.000Z' })
    const newer = await insertHistorySession(userId, { submittedAt: '2026-10-20T02:00:00.000Z' })
    // 并列 submittedAt：后插 id 更大，排前（id 倒序兜底）
    const tie = await insertHistorySession(userId, { submittedAt: '2026-10-20T02:00:00.000Z' })
    await insertHistorySession(userId, { status: 'in_progress' })
    await insertHistorySession(userId, { status: 'abandoned' })

    const { status, body } = await requestJson('/api/mock/history', bearerGet(token))
    expect(status).toBe(200)
    const rows = body as unknown as { id: number }[]
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.id)).toEqual([tie, newer, oldest])
  })

  it('多用户隔离：本人只见自己的 submitted 历史，他人会话不可见', async () => {
    const tokenAlice = await registerForToken('alice')
    await registerForToken('bob')
    const aliceSession = await insertHistorySession(await userIdOf('alice'), { submittedAt: '2026-10-20T01:00:00.000Z' })
    await insertHistorySession(await userIdOf('bob'), { submittedAt: '2026-10-20T02:00:00.000Z' })

    const aliceList = await requestJson('/api/mock/history', bearerGet(tokenAlice))
    expect(aliceList.status).toBe(200)
    expect((aliceList.body as unknown as { id: number }[]).map((row) => row.id)).toEqual([aliceSession])
  })

  it('isCorrect null 行不计 answered/correct/timeoutCount/totalDurationMs（脏数据/中断态防御，口径与 report 一致）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [graded, ungraded] = fixture.paperQuestionIds
    const sessionId = await insertHistorySession(userId, { submittedAt: '2026-10-20T05:00:00.000Z', questionCount: 3 })
    await insertMockAnswerRow(sessionId, graded, { answer: 'B', durationMs: 4_000, isCorrect: true })
    // 未判分行（isCorrect null）：交卷后已答行理论恒非空，此处直插模拟脏数据/中断态——超时与用时均不得计入
    await insertMockAnswerRow(sessionId, ungraded, { answer: 'A', durationMs: 9_999, isTimeout: true })

    const { status, body } = await requestJson('/api/mock/history', bearerGet(token))
    expect(status).toBe(200)
    const rows = body as unknown as { summary: Record<string, number> }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toEqual({
      total: 3,
      answered: 1,
      correct: 1,
      unanswered: 2,
      timeoutCount: 0,
      totalDurationMs: 4_000,
    })
  })

  it('无作答行的 submitted 会话：summary 四数全 0、unanswered=total（D1 SUM 空集缺省归 0）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    await insertHistorySession(userId, { submittedAt: '2026-10-20T05:00:00.000Z', questionCount: 4 })

    const { status, body } = await requestJson('/api/mock/history', bearerGet(token))
    expect(status).toBe(200)
    const rows = body as unknown as { summary: Record<string, number> }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toEqual({
      total: 4,
      answered: 0,
      correct: 0,
      unanswered: 4,
      timeoutCount: 0,
      totalDurationMs: 0,
    })
  })
})
