import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { KnowledgeMasteryModule } from '@ncse/shared'
import {
  examTypes,
  knowledgePoints,
  masteryStats,
  modules,
  papers,
  questionKnowledge,
  reinforceQueue,
  users,
} from '../src/db/schema'
import {
  bearerGet,
  bearerPost,
  errorField,
  numberField,
  registerForToken,
  requestJson,
} from './api-helpers'
import { db, insertSession, insertWrongBookEntry, userIdOf } from './practice-fixtures'
import {
  insertMockAnswerRow,
  insertMockFixture,
  insertMockSessionRow,
  type MockFixture,
} from './mock-fixtures'

/**
 * 知识点掌握度 API 集成测试（M3/T3-01d）：判分/交卷 → mastery-machine 增量汇入 →
 * GET /api/stats/knowledge 查询。经 worker 真实入口覆盖：
 * - 练习判分汇入：单题精确值（库行 + 端点逐字段含 mastery 数值精确）、两条记录增量加权均值、
 *   同题连续作答演进、未打标题不产生行（打标跨天执行中属正常态）、wrong_redo / reinforce
 *   会话判分同样汇入；
 * - 模考交卷批量汇入：多题共享知识点聚合单行、未作答/未打标不计、专项与模考同权重混合演进（D4）；
 * - 查询端点：空态 []、模块序（modules.sort_order）与点序（sort_order + id）、跨模块打标按
 *   知识点模块分组、卷外模块 timeLimitSec null（用时得分按 0）、needsReinforce 阈值口径、
 *   用户隔离、401。
 * 夹具：mock-fixtures.insertMockFixture（内容 15 题 + 蓝图 + 试卷，模考交卷用）+ 本文件
 * seedMasteryTagging（知识点 + question_knowledge 打标 + 模块 sortOrder 定序）。
 * 超时推导基准：省考联考·标准卷——political_theory 每题 40s、verbal 50s。
 * 题库答案缺省 'B'：B 答对、A 答错。
 */

/** 卷外模块编码（不在默认蓝图六模块内——timeLimitSec null 分支夹具；库层 TEXT 无域约束可直插） */
const EXTRA_MODULE_CODE = 'fixture_extra_module'

/** political_theory 模块主知识点编码（挂题 0/1/2/6 + 题 7 双打标） */
const MAIN_KP_CODE = 'fixture-mastery-main'
/** political_theory 模块次知识点编码（挂题 3） */
const SECOND_KP_CODE = 'fixture-mastery-second'
/** verbal 模块知识点编码（挂题 4 与题 7——跨模块/双打标夹具） */
const VERBAL_KP_CODE = 'fixture-mastery-verbal'
/** 卷外模块知识点编码（挂题 5） */
const EXTRA_KP_CODE = 'fixture-mastery-extra'

/** 打标夹具（M3/T3-01d）：seedMasteryTagging 的产出 */
interface MasteryTaggingFixture {
  /** political_theory 主知识点 id（political 第 0/1/2/6/7 题挂它） */
  mainKpId: number
  /** political_theory 次知识点 id（political 第 3 题挂它） */
  secondKpId: number
  /** verbal 模块知识点 id（political 第 4/7 题挂它——知识点在 verbal、题在 political，验证按知识点模块分组） */
  verbalKpId: number
  /** 卷外模块知识点 id（political 第 5 题挂它） */
  extraKpId: number
}

let fixture: MockFixture
let tagging: MasteryTaggingFixture

beforeEach(async () => {
  // 先清 users（级联清 practice_sessions / mock_sessions / mock_answers / mastery_stats / reinforce_queue，
  // 解除对蓝图/试卷的 restrict），再清 papers 与 exam_types（级联清内容域链条含知识点与打标），用例互不依赖
  await db.delete(users)
  await db.delete(papers)
  await db.delete(examTypes)
  fixture = await insertMockFixture()
  tagging = await seedMasteryTagging(fixture)
})

/**
 * 造打标夹具：political 两点（sort 1/2）+ verbal 一点 + 卷外模块一点，political 前 8 题打标
 * （0/1/2/6 挂主点、3 挂次点、4 挂言语点、5 挂卷外点、7 双打标主点+言语点），其余题不打标
 * （未打标分支夹具）。模块 sortOrder 显式定序（缺省全 0）：political 1 / common 2 / verbal 3 /
 * judgement 4 / 卷外 9——模块序断言不依赖插入序。
 */
async function seedMasteryTagging(source: MockFixture): Promise<MasteryTaggingFixture> {
  const content = source.content
  const politicalModuleId = content.moduleIds.get('political_theory')
  const commonModuleId = content.moduleIds.get('common_sense')
  const verbalModuleId = content.moduleIds.get('verbal')
  const judgementModuleId = content.moduleIds.get('judgement')
  if (
    politicalModuleId === undefined ||
    commonModuleId === undefined ||
    verbalModuleId === undefined ||
    judgementModuleId === undefined
  ) {
    throw new Error('模块 id 缺失')
  }

  await db.update(modules).set({ sortOrder: 1 }).where(eq(modules.id, politicalModuleId))
  await db.update(modules).set({ sortOrder: 2 }).where(eq(modules.id, commonModuleId))
  await db.update(modules).set({ sortOrder: 3 }).where(eq(modules.id, verbalModuleId))
  await db.update(modules).set({ sortOrder: 4 }).where(eq(modules.id, judgementModuleId))

  // 卷外模块（挂 xingce 科目——经 political 模块行反查科目 id，mock-fixtures 同手法）
  const subjectRow = (
    await db
      .select({ subjectId: modules.subjectId })
      .from(modules)
      .where(eq(modules.id, politicalModuleId))
  ).at(0)
  const subjectId = subjectRow?.subjectId
  if (subjectId === undefined) throw new Error('subjects 反查失败')
  const extraModuleRows = await db
    .insert(modules)
    .values({ subjectId, code: EXTRA_MODULE_CODE, name: '卷外模块', sortOrder: 9 })
    .returning({ id: modules.id })
  const extraModuleId = extraModuleRows.at(0)?.id
  if (extraModuleId === undefined) throw new Error('modules 插入未返回 id')

  const pointRows = await db
    .insert(knowledgePoints)
    .values([
      {
        moduleId: politicalModuleId,
        parentId: null,
        code: MAIN_KP_CODE,
        name: '虚构主知识点',
        sortOrder: 1,
      },
      {
        moduleId: politicalModuleId,
        parentId: null,
        code: SECOND_KP_CODE,
        name: '虚构次知识点',
        sortOrder: 2,
      },
      {
        moduleId: verbalModuleId,
        parentId: null,
        code: VERBAL_KP_CODE,
        name: '虚构言语知识点',
        sortOrder: 1,
      },
      {
        moduleId: extraModuleId,
        parentId: null,
        code: EXTRA_KP_CODE,
        name: '虚构卷外知识点',
        sortOrder: 1,
      },
    ])
    .returning({ id: knowledgePoints.id, code: knowledgePoints.code })
  const idOfCode = (code: string): number => {
    const id = pointRows.find((row) => row.code === code)?.id
    if (id === undefined) throw new Error(`知识点 ${code} 插入未返回 id`)
    return id
  }
  const mainKpId = idOfCode(MAIN_KP_CODE)
  const secondKpId = idOfCode(SECOND_KP_CODE)
  const verbalKpId = idOfCode(VERBAL_KP_CODE)
  const extraKpId = idOfCode(EXTRA_KP_CODE)

  // 打标（tagVersion 1 / source official——两列非空无库缺省）
  const political = content.politicalQuestionIds
  await db.insert(questionKnowledge).values([
    { questionId: political[0], knowledgePointId: mainKpId, tagVersion: 1, source: 'official' },
    { questionId: political[1], knowledgePointId: mainKpId, tagVersion: 1, source: 'official' },
    { questionId: political[2], knowledgePointId: mainKpId, tagVersion: 1, source: 'official' },
    { questionId: political[3], knowledgePointId: secondKpId, tagVersion: 1, source: 'official' },
    { questionId: political[4], knowledgePointId: verbalKpId, tagVersion: 1, source: 'official' },
    { questionId: political[5], knowledgePointId: extraKpId, tagVersion: 1, source: 'official' },
    { questionId: political[6], knowledgePointId: mainKpId, tagVersion: 1, source: 'official' },
    // 第 7 题双打标：一题计入两个知识点，各自独立聚合
    { questionId: political[7], knowledgePointId: mainKpId, tagVersion: 1, source: 'official' },
    { questionId: political[7], knowledgePointId: verbalKpId, tagVersion: 1, source: 'official' },
  ])
  return { mainKpId, secondKpId, verbalKpId, extraKpId }
}

/** mastery_stats 行（直查断言用，列类型由 schema 推导） */
type MasteryRow = typeof masteryStats.$inferSelect

/** 直查用户全部掌握度行（判分/交卷汇入的落库断言用） */
async function masteryRowsOf(userId: number): Promise<MasteryRow[]> {
  return db.select().from(masteryStats).where(eq(masteryStats.userId, userId))
}

/** 建练习会话（直插，缺省 in_progress） */
async function practiceSession(userId: number, questionIds: number[]): Promise<number> {
  return insertSession(userId, 'political_theory', questionIds)
}

/** 提交练习作答（判分端点的简写） */
function submitAnswer(sessionId: number, token: string, body: unknown) {
  return requestJson(`/api/practice/sessions/${sessionId}/answers`, bearerPost(token, body))
}

/** 建模考会话（直插，缺省 in_progress / totalMinutes 10） */
async function mockSession(userId: number, questionIds: number[]): Promise<number> {
  return insertMockSessionRow({
    userId,
    blueprintId: fixture.blueprintId,
    paperId: fixture.paperId,
    questionIds,
    totalMinutes: 10,
  })
}

/** 模考交卷（无请求体——端点无入参） */
function submitMock(sessionId: number, token: string) {
  return requestJson(`/api/mock/sessions/${sessionId}/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

/** 查询知识点掌握度（GET /api/stats/knowledge 的简写，响应断言用） */
async function fetchKnowledge(token: string): Promise<KnowledgeMasteryModule[]> {
  const { status, body } = await requestJson('/api/stats/knowledge', bearerGet(token))
  expect(status).toBe(200)
  return body as unknown as KnowledgeMasteryModule[]
}

describe('GET /api/stats/knowledge 基础（M3/T3-01d）', () => {
  it('无 token 401（unauthorized 信封）', async () => {
    const { status, body } = await requestJson('/api/stats/knowledge')
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })

  it('空态：内容与打标在但无作答 → 200 返回 []（打标前掌握度空态可用）', async () => {
    const token = await registerForToken('mastery_empty')
    expect(await fetchKnowledge(token)).toEqual([])
  })
})

describe('练习判分汇入（判分端点 → mastery-machine）', () => {
  it('判分后单题精确值：库行 total/correct/accuracy/avg 与 targetType/targetId 精确；端点逐字段（mastery=0.85 数值精确、needsReinforce false）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = fixture.content.politicalQuestionIds[3]
    const sessionId = await practiceSession(userId, [questionId])

    // 答对（B）、用时恰为 political 40s 时限一半 → timeLimitSec=40、用时得分 0.5
    const { status, body } = await submitAnswer(sessionId, token, {
      questionId,
      answer: 'B',
      durationMs: 20_000,
    })
    expect(status).toBe(200)
    expect(body.isCorrect).toBe(true)

    const rows = await masteryRowsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      targetType: 'knowledge_point',
      targetId: tagging.secondKpId,
      totalCount: 1,
      correctCount: 1,
      accuracy: 1,
      avgDurationMs: 20_000,
    })

    const list = await fetchKnowledge(token)
    expect(list).toHaveLength(1)
    expect(list[0].module).toBe('political_theory')
    expect(list[0].timeLimitSec).toBe(40)
    expect(list[0].points).toHaveLength(1)
    // 原始计数逐字段精确（mastery/needsReinforce 因浮点尾差单独断言）
    expect(list[0].points[0]).toEqual({
      knowledgePointId: tagging.secondKpId,
      code: SECOND_KP_CODE,
      name: '虚构次知识点',
      totalCount: 1,
      correctCount: 1,
      accuracy: 1,
      avgDurationMs: 20_000,
      mastery: expect.closeTo(0.85),
      needsReinforce: false,
    })
    // 0.7×1 + 0.3×0.5 = 0.85（浮点尾差用 toBeCloseTo 双保险断言数值精确）
    expect(list[0].points[0].mastery).toBeCloseTo(0.85)
  })

  it('两条记录增量加权均值：先答对 4000ms 再答错 6000ms → total 2 / correct 1 / accuracy 0.5 / avg (4000×1+6000)/2=5000', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [first, second] = fixture.content.politicalQuestionIds
    const sessionId = await practiceSession(userId, [first, second])

    await submitAnswer(sessionId, token, { questionId: first, answer: 'B', durationMs: 4_000 })
    let rows = await masteryRowsOf(userId)
    expect(rows[0]).toMatchObject({ totalCount: 1, correctCount: 1, avgDurationMs: 4_000 })

    await submitAnswer(sessionId, token, { questionId: second, answer: 'A', durationMs: 6_000 })
    rows = await masteryRowsOf(userId)
    // 增量加权均值走冲突分支：avg_duration_ms×total_count + sumMs / (total_count + n)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      totalCount: 2,
      correctCount: 1,
      accuracy: 0.5,
      avgDurationMs: 5_000,
    })

    // accuracy 0.5、avg 5000 → mastery = 0.7×0.5 + 0.3×(1−5000/40000) = 0.6125（高于阈值不判需加强）
    const list = await fetchKnowledge(token)
    const point = list[0].points[0]
    expect(point.mastery).toBeCloseTo(0.7 * 0.5 + 0.3 * 0.875)
    expect(point.needsReinforce).toBe(false)
  })

  it('同题连续作答增量演进（append-only 三次）：1000/2000/3999ms → avg 逐次 1000→1500→2333、correct 1/3', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = fixture.content.politicalQuestionIds[0]
    const sessionId = await practiceSession(userId, [questionId])

    // 同题多次提交每次一行记录（判分端点 append-anytime 语义），掌握度逐次加权演进
    await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 1_000 })
    await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 2_000 })
    await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 3_999 })

    const rows = await masteryRowsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetId: tagging.mainKpId, totalCount: 3, correctCount: 1 })
    // (1000×1+2000)/2 = 1500 → (1500×2+3999)/3 = 2333（ROUND 后整数值精确）
    expect(rows[0].avgDurationMs).toBe(2_333)
    expect(rows[0].accuracy).toBeCloseTo(1 / 3)
  })

  it('未打标题不产生行（打标跨天执行中属正常态）：答未打标题 → 库无行、端点 []', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    // 第 9 题起未打标（judgement/common 题亦未打标）
    const questionId = fixture.content.politicalQuestionIds[9]
    const sessionId = await practiceSession(userId, [questionId])

    const { status } = await submitAnswer(sessionId, token, {
      questionId,
      answer: 'B',
      durationMs: 1_000,
    })
    expect(status).toBe(200)
    expect(await masteryRowsOf(userId)).toHaveLength(0)
    expect(await fetchKnowledge(token)).toEqual([])
  })

  it('wrong_redo 会话判分同样汇入：错题重做答对 → 掌握度行照建', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = fixture.content.politicalQuestionIds[0]
    await insertWrongBookEntry(userId, questionId)

    const created = await requestJson(
      '/api/practice/sessions',
      bearerPost(token, { mode: 'wrong_redo', source: 'active', count: 10 }),
    )
    expect(created.status).toBe(201)
    const sessionId = numberField(created.body, 'id')

    const { status } = await submitAnswer(sessionId, token, {
      questionId,
      answer: 'B',
      durationMs: 5_000,
    })
    expect(status).toBe(200)
    const rows = await masteryRowsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      targetId: tagging.mainKpId,
      totalCount: 1,
      correctCount: 1,
      avgDurationMs: 5_000,
    })
  })

  it('reinforce 会话判分同样汇入：强化重做答错 → 掌握度行照建（correct 0）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = fixture.content.politicalQuestionIds[1]
    await db.insert(reinforceQueue).values({
      userId,
      questionId,
      reason: 'wrong',
      status: 'pending',
      updatedAt: '2026-10-25T00:00:00.000Z',
    })

    const created = await requestJson(
      '/api/practice/sessions',
      bearerPost(token, { mode: 'reinforce', count: 10 }),
    )
    expect(created.status).toBe(201)
    const sessionId = numberField(created.body, 'id')

    const { status } = await submitAnswer(sessionId, token, {
      questionId,
      answer: 'A',
      durationMs: 7_000,
    })
    expect(status).toBe(200)
    const rows = await masteryRowsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      targetId: tagging.mainKpId,
      totalCount: 1,
      correctCount: 0,
      avgDurationMs: 7_000,
    })
  })

  it('一题多知识点（双打标 pair）：一次作答计入两个知识点，各自独立聚合', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    // 第 7 题双打标：主点（political 模块）+ 言语点（verbal 模块）
    const questionId = fixture.content.politicalQuestionIds[7]
    const sessionId = await practiceSession(userId, [questionId])

    await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 5_000 })
    const rows = await masteryRowsOf(userId)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.targetId))).toEqual(
      new Set([tagging.mainKpId, tagging.verbalKpId]),
    )
    for (const row of rows) {
      expect(row).toMatchObject({ totalCount: 1, correctCount: 1, avgDurationMs: 5_000 })
    }
  })
})

describe('模考交卷批量汇入（D4：模考作答计入掌握度、与专项同权重）', () => {
  it('整卷批量聚合：3 题共享主知识点聚合成单行（total 3/correct 2/accuracy 2/3/avg 8000）；未作答的已打标题与未打标题不计', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const political = fixture.content.politicalQuestionIds
    // 卷快照含：3 题挂主点（0/1/2）、1 题挂主点但未作答（6）、1 题未打标（judgement）
    const sessionId = await mockSession(userId, [
      political[0],
      political[1],
      political[2],
      political[6],
      fixture.content.judgementQuestionIds[0],
    ])
    await insertMockAnswerRow(sessionId, political[0], { answer: 'B', durationMs: 4_000 })
    await insertMockAnswerRow(sessionId, political[1], { answer: 'A', durationMs: 8_000 })
    await insertMockAnswerRow(sessionId, political[2], { answer: 'B', durationMs: 12_000 })

    const { status } = await submitMock(sessionId, token)
    expect(status).toBe(200)

    // 聚合单行：3 题共享知识点只落 1 行（整卷一次传入、每知识点仅 1 条 upsert）
    const rows = await masteryRowsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      targetType: 'knowledge_point',
      targetId: tagging.mainKpId,
      totalCount: 3,
      correctCount: 2,
      avgDurationMs: (4_000 + 8_000 + 12_000) / 3,
    })
    expect(rows[0].accuracy).toBeCloseTo(2 / 3)

    // 端点逐点核对：未作答的第 6 题不计（total 3 非 4）；mastery = 0.7×2/3 + 0.3×(1−8000/40000)
    const list = await fetchKnowledge(token)
    expect(list).toHaveLength(1)
    const point = list[0].points[0]
    expect(point.totalCount).toBe(3)
    expect(point.mastery).toBeCloseTo(0.7 * (2 / 3) + 0.3 * 0.8)
  })

  it('专项与模考同权重混合演进：专项答对 4000ms 后模考答错 6000ms → 同一行 total 2 / avg 5000', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [first, second] = fixture.content.politicalQuestionIds

    // 专项判分先建行（n=1 单事件路径）
    const practiceId = await practiceSession(userId, [first])
    await submitAnswer(practiceId, token, { questionId: first, answer: 'B', durationMs: 4_000 })

    // 模考交卷再增量（整卷聚合路径，同一知识点行加权合并）
    const mockId = await mockSession(userId, [second])
    await insertMockAnswerRow(mockId, second, { answer: 'A', durationMs: 6_000 })
    const { status } = await submitMock(mockId, token)
    expect(status).toBe(200)

    const rows = await masteryRowsOf(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ totalCount: 2, correctCount: 1, avgDurationMs: 5_000 })
  })
})

describe('GET /api/stats/knowledge 聚合口径（打标后）', () => {
  it('模块序 = modules.sort_order、模块内点序 = sort_order + id；跨模块打标按知识点所属模块分组（verbal 点出现在 verbal 模块组）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const political = fixture.content.politicalQuestionIds
    // 三题分别挂：主点（political sort 1）、次点（political sort 2）、言语点（verbal 模块）
    const sessionId = await practiceSession(userId, [political[0], political[3], political[4]])
    await submitAnswer(sessionId, token, {
      questionId: political[0],
      answer: 'B',
      durationMs: 1_000,
    })
    await submitAnswer(sessionId, token, {
      questionId: political[3],
      answer: 'B',
      durationMs: 1_000,
    })
    await submitAnswer(sessionId, token, {
      questionId: political[4],
      answer: 'B',
      durationMs: 1_000,
    })

    const list = await fetchKnowledge(token)
    // 模块序：political_theory（sort 1）先于 verbal（sort 3）——不依赖插入序/字典序
    expect(list.map((entry) => entry.module)).toEqual(['political_theory', 'verbal'])
    expect(list[0].timeLimitSec).toBe(40)
    expect(list[1].timeLimitSec).toBe(50)
    // political 模块内点序：主点（sort 1）先于次点（sort 2）
    expect(list[0].points.map((point) => point.code)).toEqual([MAIN_KP_CODE, SECOND_KP_CODE])
    // 言语点挂的是 political 题，但按知识点所属模块分组进 verbal 模块
    expect(list[1].points.map((point) => point.code)).toEqual([VERBAL_KP_CODE])
    expect(list[1].points[0].knowledgePointId).toBe(tagging.verbalKpId)
  })

  it('卷外模块 timeLimitSec null：mastery 用时得分按 0 → 0.7×正确率（答对 → 0.7、不判需加强）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = fixture.content.politicalQuestionIds[5]
    const sessionId = await practiceSession(userId, [questionId])
    await submitAnswer(sessionId, token, { questionId, answer: 'B', durationMs: 10_000 })

    const list = await fetchKnowledge(token)
    expect(list).toHaveLength(1)
    expect(list[0].module).toBe(EXTRA_MODULE_CODE)
    expect(list[0].timeLimitSec).toBeNull()
    const point = list[0].points[0]
    expect(point.avgDurationMs).toBe(10_000)
    // 用时得分按 0：mastery = 0.7×1 = 0.7（高于 0.6 阈值不判需加强）
    expect(point.mastery).toBeCloseTo(0.7)
    expect(point.needsReinforce).toBe(false)
  })

  it('needsReinforce 阈值口径：答错且用时恰达时限 → accuracy 0 / 用时得分 0 → mastery 0 判需加强', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = fixture.content.politicalQuestionIds[2]
    const sessionId = await practiceSession(userId, [questionId])
    // 40000ms 恰达 political 40s 时限：用时得分 1−1 = 0（且不判超时——严格大于才超）
    await submitAnswer(sessionId, token, { questionId, answer: 'A', durationMs: 40_000 })

    const list = await fetchKnowledge(token)
    const point = list[0].points[0]
    expect(point.accuracy).toBe(0)
    expect(point.mastery).toBe(0)
    expect(point.needsReinforce).toBe(true)
  })

  it('用户隔离：alice 的掌握度对 bob 不可见（多用户隔离，bob 空态 []）', async () => {
    const aliceToken = await registerForToken('alice')
    const bobToken = await registerForToken('bob')
    const aliceId = await userIdOf('alice')
    const bobId = await userIdOf('bob')
    const questionId = fixture.content.politicalQuestionIds[0]
    const sessionId = await practiceSession(aliceId, [questionId])
    await submitAnswer(sessionId, aliceToken, { questionId, answer: 'B', durationMs: 1_000 })

    // bob 视角空态（mastery_stats.userId 归属过滤）；alice 视角不受影响
    expect(await fetchKnowledge(bobToken)).toEqual([])
    expect(await masteryRowsOf(bobId)).toHaveLength(0)
    const aliceList = await fetchKnowledge(aliceToken)
    expect(aliceList).toHaveLength(1)
    expect(aliceList[0].points[0].totalCount).toBe(1)
  })
})
