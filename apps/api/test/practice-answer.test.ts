import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { RichContent, RichSegment } from '@ncse/shared'
import { examTypes, practiceRecords, practiceSessions, questions, users } from '../src/db/schema'
import {
  bearerGet,
  bearerPost,
  errorField,
  numberField,
  ORIGIN,
  postJson,
  registerForToken,
  requestJson,
  stringField,
} from './api-helpers'
import {
  db,
  fakeImageKey,
  insertContentFixture,
  insertQuestion,
  insertSession,
  insertWrongBookEntry,
  userIdOf,
  wrongBookRowOf,
  type ContentFixture,
} from './practice-fixtures'

/**
 * 专项刷题·判分与错题状态机 API 集成测试（T1-08c，ADR-0009/0010）：
 * POST /api/practice/sessions/:id/answers 经 worker 真实入口；practice_records 直查断言
 * （append-only 落库）、wrong_book 状态机直查断言（答错复活/答对在册累加）、
 * 会话 finished 判定（全部作答）。助手与夹具见 test/api-helpers.ts 与 test/practice-fixtures.ts。
 * 超时推导基准：省考联考·标准卷（province_joint_std）——political_theory 每题时限
 * 40s = floor(10 分钟 × 60 / 15 题)；judgement 60s = floor(30 分钟 × 60 / 30 题)。
 */

let content: ContentFixture

beforeEach(async () => {
  // 清空 users（级联清 practice_sessions / practice_records / wrong_book）与 exam_types（级联清内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
  content = await insertContentFixture()
})

/** 提交作答（判分端点的简写） */
function submitAnswer(sessionId: number, token: string, body: unknown) {
  return requestJson(`/api/practice/sessions/${sessionId}/answers`, bearerPost(token, body))
}

describe('POST /api/practice/sessions/:id/answers（判分与记录落库）', () => {
  it('答对：200 全字段（isCorrect/correctAnswer/analysis 图片段投影/wrongBook=null/sessionStatus），practice_records 行字段齐全', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    // 解析含 KEYED 图片段的题：判分响应的 analysis 投影断言用
    const politicalModuleId = content.moduleIds.get('political_theory')
    if (politicalModuleId === undefined) throw new Error('夹具缺 political_theory 模块行')
    const questionId = await insertQuestion(politicalModuleId, 'pt-ans-01', [{ type: 'text', text: '判分题' }], {
      analysis: [
        { type: 'text', text: '解析文本' },
        { type: 'image', path: fakeImageKey(99), alt: '解析图' },
      ],
    })
    // 2 题清单只答 1 题 → 会话保持 in_progress
    const sessionId = await insertSession(userId, 'political_theory', [questionId, content.politicalQuestionIds[0]])

    const { status, body } = await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 5000 })

    expect(status).toBe(200)
    expect(numberField(body, 'questionId')).toBe(questionId)
    expect(body.isCorrect).toBe(true)
    expect(body.isTimeout).toBe(false)
    expect(stringField(body, 'correctAnswer')).toBe('B')
    // 解析富片段：text 段原样 + 图片段投影为 /api/img 绝对 URL（判分后才回发——服务端判分共识）
    const analysis = body.analysis as RichContent
    expect(analysis[0]).toEqual({ type: 'text', text: '解析文本' })
    const imageSegment = analysis[1] as Extract<RichSegment, { type: 'image' }>
    expect(imageSegment.path).toBe(`${ORIGIN}/api/img/${fakeImageKey(99)}`)
    expect(imageSegment.alt).toBe('解析图')
    // 答对不在册 → null（不建错题本行）
    expect(body.wrongBook).toBeNull()
    expect(body.sessionStatus).toBe('in_progress')

    // 直查 practice_records 行字段（判分端点自身走 HTTP 路径，不经夹具直插）
    const recordRows = await db.select().from(practiceRecords).where(eq(practiceRecords.questionId, questionId))
    expect(recordRows).toHaveLength(1)
    const record = recordRows[0]
    expect(record.userId).toBe(userId)
    expect(record.answer).toBe('B')
    expect(record.isCorrect).toBe(true)
    expect(record.isTimeout).toBe(false)
    expect(record.durationMs).toBe(5000)
    expect(record.mode).toBe('module')
    expect(record.sessionId).toBe(String(sessionId))
  })

  it('答错：wrongBook={status:"active"}，wrong_book 建行（wrongCount=1、redoCount=0、连对 0）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    const { status, body } = await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 2000 })

    expect(status).toBe(200)
    expect(body.isCorrect).toBe(false)
    expect(stringField(body, 'correctAnswer')).toBe('B')
    expect(body.wrongBook).toEqual({ status: 'active' })

    const entry = await wrongBookRowOf(userId, questionId)
    expect(entry?.status).toBe('active')
    expect(entry?.wrongCount).toBe(1)
    expect(entry?.redoCount).toBe(0)
    expect(entry?.consecutiveCorrect).toBe(0)
  })

  it('超时边界：political_theory 每题时限 40s（floor(10×60/15)）——40000 不超时、40001 超时（响应与落库一致）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    const atLimit = await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 40000 })
    expect(atLimit.status).toBe(200)
    // 等于时限不超时（严格大于才判超时）
    expect(atLimit.body.isTimeout).toBe(false)

    const overLimit = await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 40001 })
    expect(overLimit.body.isTimeout).toBe(true)

    // 落库与响应一致（append-only 两行；按用时区分避免依赖插入序）
    const rows = await db
      .select({ durationMs: practiceRecords.durationMs, isTimeout: practiceRecords.isTimeout })
      .from(practiceRecords)
      .where(eq(practiceRecords.sessionId, String(sessionId)))
    const byDuration = new Map(rows.map((row) => [row.durationMs, row.isTimeout]))
    expect(byDuration.get(40000)).toBe(false)
    expect(byDuration.get(40001)).toBe(true)
  })

  it('模块差异：judgement 每题时限 60s（floor(30×60/30)）——60000 不超时（political 同值会超时）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const judgementId = content.judgementQuestionIds[0]
    const judgementSessionId = await insertSession(userId, 'judgement', [judgementId])

    const { status, body } = await submitAnswer(judgementSessionId, token, {
      questionId: judgementId,
      answer: 'B',
      durationMs: 60000,
    })
    expect(status).toBe(200)
    expect(body.isTimeout).toBe(false)

    // 反证：political_theory（40s）同用时 60000 → 超时，证明时限按会话模块推导
    const politicalId = content.politicalQuestionIds[1]
    const politicalSessionId = await insertSession(userId, 'political_theory', [politicalId])
    const political = await submitAnswer(politicalSessionId, token, { questionId: politicalId, answer: 'B', durationMs: 60000 })
    expect(political.body.isTimeout).toBe(true)
  })

  it('会话完成：2 题全答后末题响应 sessionStatus=finished、库行翻转、活动会话列表不再含该会话', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [firstId, secondId] = [content.politicalQuestionIds[0], content.politicalQuestionIds[1]]
    const sessionId = await insertSession(userId, 'political_theory', [firstId, secondId])

    const first = await submitAnswer(sessionId, token, { questionId: firstId, answer: 'B', durationMs: 1000 })
    expect(first.status).toBe(200)
    expect(first.body.sessionStatus).toBe('in_progress')

    const second = await submitAnswer(sessionId, token, { questionId: secondId, answer: 'A', durationMs: 1000 })
    expect(second.status).toBe(200)
    expect(second.body.sessionStatus).toBe('finished')

    const sessionRows = await db
      .select({ status: practiceSessions.status })
      .from(practiceSessions)
      .where(eq(practiceSessions.id, sessionId))
    expect(sessionRows[0]?.status).toBe('finished')

    const listResponse = await requestJson('/api/practice/sessions', bearerGet(token))
    expect(listResponse.status).toBe(200)
    const list = listResponse.body as unknown as Record<string, unknown>[]
    expect(list.map((row) => numberField(row, 'id'))).not.toContain(sessionId)
  })
})

describe('错题本状态机（ADR-0010）', () => {
  it('同题重复作答：两次提交落两行 records；错→对后 wrongBook 仍提示 active、行 redoCount=1/连对=1/wrongCount=1', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    const first = await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 1000 })
    expect(first.body.isCorrect).toBe(false)
    expect(first.body.wrongBook).toEqual({ status: 'active' })

    const second = await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 1000 })
    expect(second.body.isCorrect).toBe(true)
    // 答对在册 active 题仍带上下文（ADR-0010：每次答对在册 active 题均提示处置）
    expect(second.body.wrongBook).toEqual({ status: 'active' })

    // append-only：同题两次提交两行
    const recordRows = await db
      .select({ id: practiceRecords.id })
      .from(practiceRecords)
      .where(eq(practiceRecords.sessionId, String(sessionId)))
    expect(recordRows).toHaveLength(2)

    const entry = await wrongBookRowOf(userId, questionId)
    expect(entry?.status).toBe('active')
    expect(entry?.wrongCount).toBe(1)
    expect(entry?.redoCount).toBe(1)
    expect(entry?.consecutiveCorrect).toBe(1)
  })

  it('再答错在册题：wrongCount 累加 2、连对清零、redoCount 累加、status 保持 active', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    // 错 → 对 → 错：连对由 1 清回 0（错→对：连对 1；对→错：清零）
    await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 1000 })
    await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 1000 })
    const third = await submitAnswer(sessionId, token, { questionId, answer: 'C', durationMs: 1000 })
    expect(third.body.wrongBook).toEqual({ status: 'active' })

    const entry = await wrongBookRowOf(userId, questionId)
    expect(entry?.status).toBe('active')
    expect(entry?.wrongCount).toBe(2)
    expect(entry?.redoCount).toBe(2)
    expect(entry?.consecutiveCorrect).toBe(0)
  })

  it('eliminated 条目答错：复活 active、wrongCount 累加（3→4）、redoCount 累加', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await insertWrongBookEntry(userId, questionId, { status: 'eliminated', wrongCount: 3, redoCount: 1 })
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    const { status, body } = await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 1000 })

    expect(status).toBe(200)
    expect(body.wrongBook).toEqual({ status: 'active' })
    const entry = await wrongBookRowOf(userId, questionId)
    expect(entry?.status).toBe('active')
    expect(entry?.wrongCount).toBe(4)
    expect(entry?.redoCount).toBe(2)
    expect(entry?.consecutiveCorrect).toBe(0)
  })

  it('hard 条目答对：响应 wrongBook={status:"hard"}（前端据此不弹处置）、redoCount/连对累加、status 不动', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await insertWrongBookEntry(userId, questionId, { status: 'hard', wrongCount: 2, redoCount: 1 })
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    const { status, body } = await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 1000 })

    expect(status).toBe(200)
    expect(body.wrongBook).toEqual({ status: 'hard' })
    const entry = await wrongBookRowOf(userId, questionId)
    expect(entry?.status).toBe('hard')
    expect(entry?.wrongCount).toBe(2)
    expect(entry?.redoCount).toBe(2)
    expect(entry?.consecutiveCorrect).toBe(1)
  })
})

describe('入参校验、隔离与鉴权', () => {
  /** 判分非法入参用例：build 在测试内求值（依赖夹具题目的会话内 id，收集期不可用） */
  const invalidCases: { case: string; build: (questionId: number) => unknown }[] = [
    {
      case: 'questionId 不在会话清单（他模块题）',
      build: () => ({ questionId: content.commonQuestionIds[0], answer: 'A', durationMs: 1000 }),
    },
    { case: 'questionId 不在会话清单（不存在的大 id）', build: () => ({ questionId: 999999, answer: 'A', durationMs: 1000 }) },
    { case: 'questionId 类型错（字符串）', build: () => ({ questionId: '1', answer: 'A', durationMs: 1000 }) },
    { case: 'questionId 零', build: () => ({ questionId: 0, answer: 'A', durationMs: 1000 }) },
    { case: 'questionId 负数', build: () => ({ questionId: -1, answer: 'A', durationMs: 1000 }) },
    { case: 'questionId 非整数', build: () => ({ questionId: 1.5, answer: 'A', durationMs: 1000 }) },
    { case: 'answer 非选项键（E）', build: (questionId) => ({ questionId, answer: 'E', durationMs: 1000 }) },
    { case: 'answer 类型错（数字）', build: (questionId) => ({ questionId, answer: 2, durationMs: 1000 }) },
    { case: 'answer 缺失', build: (questionId) => ({ questionId, durationMs: 1000 }) },
    { case: 'durationMs 负数', build: (questionId) => ({ questionId, answer: 'A', durationMs: -1 }) },
    { case: 'durationMs 非整数', build: (questionId) => ({ questionId, answer: 'A', durationMs: 1000.5 }) },
    { case: 'durationMs 达 24h 上限（开区间外）', build: (questionId) => ({ questionId, answer: 'A', durationMs: 86_400_000 }) },
    { case: 'durationMs 类型错（字符串）', build: (questionId) => ({ questionId, answer: 'A', durationMs: '1000' }) },
    { case: 'body 非 JSON 对象（数组）', build: (questionId) => [questionId, 'A', 1000] },
  ]

  it.each(invalidCases)('入参不合法（$case）：400 + bad_request 且不落任何行', async ({ build }) => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const sessionId = await insertSession(userId, 'political_theory', [questionId])

    const { status, body } = await submitAnswer(sessionId, token, build(questionId))

    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
    // 校验失败不落作答记录（不建错题本行由 records 为空间接保证）
    const recordRows = await db
      .select({ id: practiceRecords.id })
      .from(practiceRecords)
      .where(eq(practiceRecords.sessionId, String(sessionId)))
    expect(recordRows).toHaveLength(0)
  })

  it('隔离与悬空：他人会话/不存在 id/非数字 id → 404 同文案；清单内 id 但题目行已删 → 404', async () => {
    const tokenA = await registerForToken('alice')
    const tokenB = await registerForToken('bob')
    const aliceId = await userIdOf('alice')
    const validBody = { questionId: content.politicalQuestionIds[0], answer: 'A', durationMs: 1000 }

    const sessionId = await insertSession(aliceId, 'political_theory', [content.politicalQuestionIds[0]])
    const foreign = await submitAnswer(sessionId, tokenB, validBody)
    expect(foreign.status).toBe(404)
    expect(errorField(foreign.body).code).toBe('not_found')

    const missing = await submitAnswer(999999, tokenA, validBody)
    expect(missing.status).toBe(404)
    expect(errorField(missing.body).code).toBe('not_found')

    const nonNumeric = await requestJson(
      '/api/practice/sessions/abc/answers',
      bearerPost(tokenA, validBody),
    )
    expect(nonNumeric.status).toBe(404)
    expect(errorField(nonNumeric.body).code).toBe('not_found')

    // 三者同文案（防存在性探测，不区分原因）
    const messages = [foreign, missing, nonNumeric].map((outcome) => errorField(outcome.body).message)
    expect(new Set(messages).size).toBe(1)

    // 悬空：清单内 id 但题目行已被内容重删（先建会话再直删 questions 行）
    const danglingQuestionId = content.politicalQuestionIds[1]
    const danglingSessionId = await insertSession(aliceId, 'political_theory', [danglingQuestionId])
    await db.delete(questions).where(eq(questions.id, danglingQuestionId))
    const dangling = await submitAnswer(danglingSessionId, tokenA, {
      questionId: danglingQuestionId,
      answer: 'A',
      durationMs: 1000,
    })
    expect(dangling.status).toBe(404)
    expect(errorField(dangling.body).code).toBe('not_found')
    expect(errorField(dangling.body).message).toBe('题目不存在')
  })

  it('缺 token：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson(
      '/api/practice/sessions/1/answers',
      postJson({ questionId: 1, answer: 'A', durationMs: 1000 }),
    )
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })
})
