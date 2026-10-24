import { eq } from 'drizzle-orm'
import type { XingceModuleCode } from '@ncse/shared'
import { DEFAULT_BLUEPRINT_CODE } from '@ncse/shared'
import {
  blueprintModules,
  blueprints,
  mockAnswers,
  mockSessions,
  modules,
  papers,
  questionPapers,
} from '../src/db/schema'
import { db, insertContentFixture, type ContentFixture } from './practice-fixtures'

/**
 * 整卷模考 API 集成测试共享夹具（T2-01b，papers-api.test.ts 与 mock-api.test.ts 共用）：
 * 内容题库复用 practice-fixtures 的 insertContentFixture（civil_service/xingce 链 + 15 题，
 * 含 KEYED 图片段题与源相对路径题），本文件在其上补蓝图/试卷/归属/模考会话/模考作答夹具
 * （照 mock-session.test.ts 的直插模式；不搅乱练习域夹具）。
 */

/** 试卷行直插覆盖项（questionCount 缺省按 pairs 数由 linkPaperQuestions 前调用方给出） */
export interface PaperRowOverrides {
  year?: number | null
  region?: string | null
  paperType?: string | null
  questionCount?: number
}

/** 插入一条试卷行（papers 无外键，无内容链也可直插），返回 papers.id */
export async function insertPaperRow(name: string, overrides: PaperRowOverrides = {}): Promise<number> {
  const rows = await db
    .insert(papers)
    .values({
      name,
      year: overrides.year ?? null,
      region: overrides.region ?? null,
      paperType: overrides.paperType ?? null,
      questionCount: overrides.questionCount ?? 0,
    })
    .returning({ id: papers.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('papers 插入未返回 id')
  return id
}

/** 把题目按给定顺序挂到试卷（question_papers.sequence = 序号 + 1；传入序即卷内题序，
 * 与题目 id 大小序无关——测试故意传乱序以验证快照按 sequence 取序） */
export async function linkPaperQuestions(paperId: number, questionIds: number[]): Promise<void> {
  for (const [index, questionId] of questionIds.entries()) {
    await db.insert(questionPapers).values({ paperId, questionId, sequence: index + 1 })
  }
}

/** 插入一条蓝图行（挂内容链的 xingce 科目；缺省 code = 默认蓝图，与种子 SQL 同 code） */
export async function insertBlueprintRow(subjectId: number, code: string = DEFAULT_BLUEPRINT_CODE): Promise<number> {
  const rows = await db
    .insert(blueprints)
    .values({ subjectId, code, name: `${code} 蓝图` })
    .returning({ id: blueprints.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('blueprints 插入未返回 id')
  return id
}

/** 蓝图模块明细直插项（与 shared BlueprintModulePlan 同构；序 = 插入序 = 蓝图模块序） */
export interface BlueprintModulePlanInput {
  module: XingceModuleCode
  questionCount: number
  timeLimitMinutes: number
}

/**
 * 给既有蓝图行挂模块明细（交卷判分超时推导与成绩单模块排序的夹具；insertBlueprintRow
 * 缺省不挂明细——空明细即蓝图防御分支夹具）。每题秒数由被测端点经 shared 推导：
 * floor(questionCount→时长/题量) 钳 1，选小值让边界断言更清晰。
 */
export async function linkBlueprintModules(
  blueprintId: number,
  moduleIds: Map<XingceModuleCode, number>,
  plans: BlueprintModulePlanInput[],
): Promise<void> {
  for (const plan of plans) {
    const moduleId = moduleIds.get(plan.module)
    if (moduleId === undefined) throw new Error(`模块 ${plan.module} 的模块行 id 缺失`)
    await db.insert(blueprintModules).values({
      blueprintId,
      moduleId,
      questionCount: plan.questionCount,
      timeLimitMinutes: plan.timeLimitMinutes,
    })
  }
}

/** 模考夹具整体（insertMockFixture 的产出） */
export interface MockFixture {
  /** 练习域内容夹具（题目 id 与模块 id 映射复用其形状） */
  content: ContentFixture
  /** 默认蓝图行 id（mock_sessions.blueprintId 用） */
  blueprintId: number
  /** 测试卷 papers.id */
  paperId: number
  /** 卷题集（序 = question_papers.sequence 卷内序，刻意与题目 id 大小序不同） */
  paperQuestionIds: number[]
}

/** 造模考夹具整体：内容链 15 题 + 默认蓝图行 + 7 题测试卷（乱序挂卷） */
export async function insertMockFixture(): Promise<MockFixture> {
  const content = await insertContentFixture()

  // 科目 id 经模块行反查（内容链上一科目，蓝图挂它）
  const politicalModuleId = content.moduleIds.get('political_theory')
  if (politicalModuleId === undefined) throw new Error('模块 id 缺失')
  const subjectRow = (await db.select({ subjectId: modules.subjectId }).from(modules).where(eq(modules.id, politicalModuleId))).at(0)
  const subjectId = subjectRow?.subjectId
  if (subjectId === undefined) throw new Error('subjects 反查失败')

  const blueprintId = await insertBlueprintRow(subjectId)

  // 卷题集：序（sequence）刻意与题目 id 大小序不同；含 KEYED 图片段题（political 第 1 题）
  // 与源相对路径图片段题（political 第 12 题）各一，覆盖投影两分支
  const paperQuestionIds = [
    content.judgementQuestionIds[0],
    content.politicalQuestionIds[3],
    content.commonQuestionIds[0],
    content.politicalQuestionIds[0],
    content.commonQuestionIds[1],
    content.politicalQuestionIds[7],
    content.politicalQuestionIds[11],
  ]
  const paperId = await insertPaperRow('2026年虚构省联考《行测》卷（模考 API 测试卷）', {
    year: 2026,
    region: 'fictionland',
    paperType: '联考',
    questionCount: paperQuestionIds.length,
  })
  await linkPaperQuestions(paperId, paperQuestionIds)
  return { content, blueprintId, paperId, paperQuestionIds }
}

/** 模考会话直插覆盖项（缺省 elapsedMs 0、status in_progress、createdAt 见 signature） */
export interface MockSessionOverrides {
  status?: 'in_progress' | 'submitted' | 'abandoned'
  elapsedMs?: number
  createdAt?: string
}

/** 直插一条模考会话（绕过 POST，用于列表/详情夹具），返回 mock_sessions.id */
export async function insertMockSessionRow(input: {
  userId: number
  blueprintId: number
  paperId: number
  questionIds: number[]
  totalMinutes: number
  overrides?: MockSessionOverrides
}): Promise<number> {
  const rows = await db
    .insert(mockSessions)
    .values({
      userId: input.userId,
      blueprintId: input.blueprintId,
      paperId: input.paperId,
      questionIds: input.questionIds,
      totalMinutes: input.totalMinutes,
      elapsedMs: input.overrides?.elapsedMs,
      status: input.overrides?.status,
      createdAt: input.overrides?.createdAt,
    })
    .returning({ id: mockSessions.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('mock_sessions 插入未返回 id')
  return id
}

/** 模考作答直插覆盖项（缺省 answer 'A'、durationMs 3000；isCorrect 缺省不落值=未判分） */
export interface MockAnswerOverrides {
  answer?: string
  durationMs?: number
  isCorrect?: boolean
}

/** 直插一条模考作答行（已答回显/已答计数夹具；isCorrect 显式落值用于验证判分字段不下发） */
export async function insertMockAnswerRow(
  sessionId: number,
  questionId: number,
  overrides: MockAnswerOverrides = {},
): Promise<void> {
  await db.insert(mockAnswers).values({
    sessionId,
    questionId,
    answer: overrides.answer ?? 'A',
    durationMs: overrides.durationMs ?? 3000,
    ...(overrides.isCorrect === undefined ? {} : { isCorrect: overrides.isCorrect }),
  })
}

/** mock_answers 行（直查断言用，列类型由 schema 推导） */
export type MockAnswerRow = typeof mockAnswers.$inferSelect

/** 直查会话内全部作答行（作答端点的落库断言用，questionId 升序——每题至多一行，键即序） */
export async function mockAnswerRowsOf(sessionId: number): Promise<MockAnswerRow[]> {
  return db.select().from(mockAnswers).where(eq(mockAnswers.sessionId, sessionId)).orderBy(mockAnswers.questionId)
}
