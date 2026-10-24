import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { createDb, type DbClient } from '../src/db'
import {
  blueprints,
  examTypes,
  mockAnswers,
  mockSessions,
  modules,
  papers,
  questions,
  subjects,
  users,
} from '../src/db/schema'

/**
 * mock_sessions 扩列表结构冒烟（T2-01b，M2 拆片定稿 D3/D6/D7，ADR-0012）：
 * paperId/questionIds/totalMinutes/elapsedMs 四新列落值与 JSON 往返、paper/blueprint
 * 双 restrict、mock_answers 挂会话与 user 级联等既有行为回归（API 行为为后续片）。
 * 建表迁移由套件 setup（apply-migrations.ts）自动应用——本文件用例即隐式验证
 * 0004 扩列迁移可在真实 D1（workerd 内 miniflare）应用与执行。
 * 夹具链：users + exam_types→subjects→modules→questions + papers + blueprints（挂 subject）。
 */

const db: DbClient = createDb(env)

/** 直插 users 并返回新行 id（密码哈希为合成占位，不构成可用凭据） */
async function insertUser(username: string): Promise<number> {
  const rows = await db.insert(users).values({ username, passwordHash: 'synthetic-placeholder' }).returning({ id: users.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('users 插入未返回 id')
  return id
}

/** 造内容域链条（exam_type→subject→module，同测试内已存在则复用），返回 { subjectId, moduleId } */
async function ensureContentChain(): Promise<{ subjectId: number; moduleId: number }> {
  const examTypeRow = (await db.select({ id: examTypes.id }).from(examTypes).where(eq(examTypes.code, 'civil_service'))).at(0)
  let examTypeId = examTypeRow?.id
  if (examTypeId === undefined) {
    examTypeId = (await db.insert(examTypes).values({ code: 'civil_service', name: '公务员' }).returning({ id: examTypes.id })).at(0)?.id
  }
  if (examTypeId === undefined) throw new Error('exam_types 插入未返回 id')
  const subjectRow = (await db.select({ id: subjects.id }).from(subjects).where(eq(subjects.examTypeId, examTypeId)).limit(1)).at(0)
  let subjectId = subjectRow?.id
  if (subjectId === undefined) {
    subjectId = (await db.insert(subjects).values({ examTypeId, code: 'xingce', name: '行测' }).returning({ id: subjects.id })).at(0)?.id
  }
  if (subjectId === undefined) throw new Error('subjects 插入未返回 id')
  const moduleRow = (await db.select({ id: modules.id }).from(modules).where(eq(modules.subjectId, subjectId)).limit(1)).at(0)
  let moduleId = moduleRow?.id
  if (moduleId === undefined) {
    moduleId = (await db.insert(modules).values({ subjectId, code: 'verbal', name: '言语理解' }).returning({ id: modules.id })).at(0)?.id
  }
  if (moduleId === undefined) throw new Error('modules 插入未返回 id')
  return { subjectId, moduleId }
}

/** 造一颗最小单选题（复用内容域链条；多题同测试不重复建链），返回 questions.id */
async function insertQuestion(qid: string): Promise<number> {
  const { moduleId } = await ensureContentChain()
  const rows = await db
    .insert(questions)
    .values({
      moduleId,
      qid,
      kind: 'single_choice',
      stem: [{ type: 'text', text: '题干' }],
      options: [{ key: 'A', content: [{ type: 'text', text: '选项 A' }] }],
      answer: 'A',
      analysis: [{ type: 'text', text: '解析' }],
    })
    .returning({ id: questions.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('questions 插入未返回 id')
  return id
}

/** 插入一条最小试卷行并返回新行 id */
async function insertPaper(name: string): Promise<number> {
  const rows = await db.insert(papers).values({ name, questionCount: 2 }).returning({ id: papers.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('papers 插入未返回 id')
  return id
}

/** 插入一条最小蓝图行（挂科目）并返回新行 id */
async function insertBlueprint(subjectId: number, code: string): Promise<number> {
  const rows = await db.insert(blueprints).values({ subjectId, code, name: `${code} 蓝图` }).returning({ id: blueprints.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('blueprints 插入未返回 id')
  return id
}

/** 插入一条最小整卷会话并返回新行 id（elapsedMs 可省：D6 计时累计默认 0） */
async function insertMockSession(input: {
  userId: number
  blueprintId: number
  paperId: number
  questionIds: number[]
  totalMinutes: number
  elapsedMs?: number
}): Promise<number> {
  const rows = await db
    .insert(mockSessions)
    .values({
      userId: input.userId,
      blueprintId: input.blueprintId,
      paperId: input.paperId,
      questionIds: input.questionIds,
      totalMinutes: input.totalMinutes,
      elapsedMs: input.elapsedMs,
    })
    .returning({ id: mockSessions.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('mock_sessions 插入未返回 id')
  return id
}

/** 断言删除触发 FOREIGN KEY 约束拦截（drizzle 可能包装 cause，消息两层都查） */
async function expectFkRejection(promise: Promise<unknown>): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeDefined()
  const causes = [caught, caught instanceof Error ? caught.cause : undefined]
  const messages = causes.filter((entry): entry is Error => entry instanceof Error).map((entry) => entry.message)
  expect(messages.join('\n')).toMatch(/FOREIGN KEY constraint failed/)
}

beforeEach(async () => {
  // 先清 users（级联清掉 mock_sessions / mock_answers，解除对蓝图/试卷的 restrict），再清 papers 与 exam_types（级联清掉内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(papers)
  await db.delete(examTypes)
})

describe('mock_sessions 扩列（T2-01b，M2 拆片定稿 D3/D6/D7）', () => {
  it('建会话全列落值：questionIds JSON 往返保序，totalMinutes 落值，elapsedMs 缺省 0', async () => {
    const userId = await insertUser('alice')
    const { subjectId } = await ensureContentChain()
    const blueprintId = await insertBlueprint(subjectId, 'national_provincial')
    const paperId = await insertPaper('2024年虚构省联考《行测》题（整卷会话测试卷）')
    const q1 = await insertQuestion('mock-session-test-qid-1')
    const q2 = await insertQuestion('mock-session-test-qid-2')
    const q3 = await insertQuestion('mock-session-test-qid-3')
    const sessionId = await insertMockSession({
      userId,
      blueprintId,
      paperId,
      questionIds: [q3, q1, q2],
      totalMinutes: 120,
    })

    const row = (await db.select().from(mockSessions).where(eq(mockSessions.id, sessionId))).at(0)
    expect(row).toBeDefined()
    // D7 快照：题目清单 JSON 往返且保卷内序（此处故意乱序插入验证原样读回）
    expect(row?.questionIds).toEqual([q3, q1, q2])
    expect(row?.paperId).toBe(paperId)
    expect(row?.blueprintId).toBe(blueprintId)
    // D3 开考锁定时长；D6 计时累计缺省 0
    expect(row?.totalMinutes).toBe(120)
    expect(row?.elapsedMs).toBe(0)
    expect(row?.status).toBe('in_progress')
    expect(row?.submittedAt).toBeNull()
    // common.ts 约定：TEXT 存 ISO-8601 UTC（库端 strftime 计算，不依赖写入方时钟）
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('paperId restrict：删除被会话引用的 papers 行被外键拦截；会话不在后删卷成功（对照）', async () => {
    const userId = await insertUser('alice')
    const { subjectId } = await ensureContentChain()
    const blueprintId = await insertBlueprint(subjectId, 'bp_for_paper_restrict')
    const paperId = await insertPaper('restrict 测试卷')
    const questionId = await insertQuestion('mock-session-test-qid-4')
    const sessionId = await insertMockSession({
      userId,
      blueprintId,
      paperId,
      questionIds: [questionId],
      totalMinutes: 5,
    })

    await expectFkRejection(db.delete(papers).where(eq(papers.id, paperId)))

    // 会话处置后（删会话即「处理」），删卷成功
    await db.delete(mockSessions).where(eq(mockSessions.id, sessionId))
    await db.delete(papers).where(eq(papers.id, paperId))
    expect((await db.select({ id: papers.id }).from(papers).where(eq(papers.id, paperId))).length).toBe(0)
  })

  it('blueprintId restrict 既有行为保持：删除被会话引用的蓝图被外键拦截', async () => {
    const userId = await insertUser('alice')
    const { subjectId } = await ensureContentChain()
    const blueprintId = await insertBlueprint(subjectId, 'bp_for_blueprint_restrict')
    const paperId = await insertPaper('restrict 对照卷')
    const questionId = await insertQuestion('mock-session-test-qid-5')
    await insertMockSession({ userId, blueprintId, paperId, questionIds: [questionId], totalMinutes: 5 })

    await expectFkRejection(db.delete(blueprints).where(eq(blueprints.id, blueprintId)))
  })

  it('mockAnswers 挂会话不受扩列影响：既有列缺省值正确，删会话级联清作答', async () => {
    const userId = await insertUser('alice')
    const { subjectId } = await ensureContentChain()
    const blueprintId = await insertBlueprint(subjectId, 'bp_for_answers')
    const paperId = await insertPaper('作答冒烟卷')
    const q1 = await insertQuestion('mock-session-test-qid-6')
    const q2 = await insertQuestion('mock-session-test-qid-7')
    const sessionId = await insertMockSession({
      userId,
      blueprintId,
      paperId,
      questionIds: [q1, q2],
      totalMinutes: 5,
      elapsedMs: 654_321,
    })

    // 一行全缺省（未作答未判分），一行显式落值
    await db.insert(mockAnswers).values({ sessionId, questionId: q1 })
    await db
      .insert(mockAnswers)
      .values({ sessionId, questionId: q2, answer: 'A', isCorrect: true, durationMs: 8_000, isTimeout: true })

    const rows = await db.select().from(mockAnswers).where(eq(mockAnswers.sessionId, sessionId)).orderBy(mockAnswers.questionId)
    expect(rows.length).toBe(2)
    const [defaulted, explicit] = rows
    expect(defaulted.answer).toBeNull()
    expect(defaulted.isCorrect).toBeNull()
    expect(defaulted.durationMs).toBe(0)
    expect(defaulted.isTimeout).toBe(false)
    expect(explicit.answer).toBe('A')
    expect(explicit.isCorrect).toBe(true)
    expect(explicit.durationMs).toBe(8_000)
    expect(explicit.isTimeout).toBe(true)

    // 扩列后的会话删除路径不变：mock_answers 随会话级联消失
    await db.delete(mockSessions).where(eq(mockSessions.id, sessionId))
    expect((await db.select({ id: mockAnswers.id }).from(mockAnswers).where(eq(mockAnswers.sessionId, sessionId))).length).toBe(0)
  })

  it('elapsedMs 计时累计列可显式落值并更新（D6：续考上报覆盖累计值）', async () => {
    const userId = await insertUser('alice')
    const { subjectId } = await ensureContentChain()
    const blueprintId = await insertBlueprint(subjectId, 'bp_for_elapsed')
    const paperId = await insertPaper('计时累计卷')
    const questionId = await insertQuestion('mock-session-test-qid-8')
    const sessionId = await insertMockSession({
      userId,
      blueprintId,
      paperId,
      questionIds: [questionId],
      totalMinutes: 135,
      elapsedMs: 1_000,
    })

    let row = (await db.select().from(mockSessions).where(eq(mockSessions.id, sessionId))).at(0)
    expect(row?.elapsedMs).toBe(1_000)
    expect(row?.totalMinutes).toBe(135)

    // 续考上报累计绝对值：整列覆盖（不做增量推导）
    await db.update(mockSessions).set({ elapsedMs: 61_800 }).where(eq(mockSessions.id, sessionId))
    row = (await db.select().from(mockSessions).where(eq(mockSessions.id, sessionId))).at(0)
    expect(row?.elapsedMs).toBe(61_800)
  })

  it('user 级联删会话保持：删除 users 行后该用户的整卷会话与作答随之消失，其他用户不受影响', async () => {
    const alice = await insertUser('alice')
    const bob = await insertUser('bob')
    const { subjectId } = await ensureContentChain()
    const blueprintId = await insertBlueprint(subjectId, 'bp_for_user_cascade')
    const paperId = await insertPaper('用户级联卷')
    const questionId = await insertQuestion('mock-session-test-qid-9')
    const aliceSession = await insertMockSession({
      userId: alice,
      blueprintId,
      paperId,
      questionIds: [questionId],
      totalMinutes: 5,
    })
    const bobSession = await insertMockSession({ userId: bob, blueprintId, paperId, questionIds: [questionId], totalMinutes: 5 })
    await db.insert(mockAnswers).values({ sessionId: aliceSession, questionId })

    await db.delete(users).where(eq(users.id, alice))

    const remaining = await db.select({ id: mockSessions.id }).from(mockSessions)
    expect(remaining).toEqual([{ id: bobSession }])
    expect((await db.select({ id: mockAnswers.id }).from(mockAnswers)).length).toBe(0)
  })
})
