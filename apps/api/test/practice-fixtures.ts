import { and, eq } from 'drizzle-orm'
import { env } from 'cloudflare:workers'
import type { QuestionOption, RichContent, WrongBookStatus, XingceModuleCode } from '@ncse/shared'
import { createDb, type DbClient } from '../src/db'
import {
  examTypes,
  modules,
  practiceRecords,
  practiceSessions,
  questions,
  subjects,
  users,
  wrongBook,
} from '../src/db/schema'

/**
 * 练习域集成测试共享夹具（T1-08b 起从 practice-api.test.ts 抽出，判分/错题处置测试共用）：
 * db 客户端经 env.DB 直连（与被测 worker 路由同一 D1 绑定，直插前置态/直查落库断言；
 * vitest isolatedStorage 按测试文件隔离存储，各文件 beforeEach 清库互不串扰）。
 * 内容夹具全虚构：civil_service/xingce 链下 political_theory 12 题 + common_sense 2 题
 * + judgement 1 题（判分超时推导的模块差异用例：标准卷每题时限 60s = floor(30×60/30)）
 * + verbal 模块行不插题（验证「模块暂无题目」分支）。
 */

/** 共享 db 客户端（直插夹具与直查断言用） */
export const db: DbClient = createDb(env)

/** 合成内容寻址键（img/<64hex>.webp 形态，测试虚构） */
export function fakeImageKey(index: number): string {
  return `img/${String(index).padStart(64, '0')}.webp`
}

/** 标准四选项 A–D（纯文本富片段） */
export function standardOptions(): QuestionOption[] {
  return ['A', 'B', 'C', 'D'].map((key) => ({ key, content: [{ type: 'text', text: `选项 ${key}` }] }))
}

/** 源仓库相对路径图片段（历史数据形态，不应被投影为 /api/img URL） */
export const LEGACY_IMAGE_PATH = 'attachments/figure.png'

export interface ContentFixture {
  /** political_theory 12 题（插入序即索引序；末题为含源相对路径段的历史数据形态） */
  politicalQuestionIds: number[]
  /** common_sense 2 题 */
  commonQuestionIds: number[]
  /** judgement 1 题（模块差异用例：标准卷每题时限 60s，political_theory 为 40s） */
  judgementQuestionIds: number[]
  /** 模块行 id（键为模块 code；测试补插自定义题目挂模块用） */
  moduleIds: Map<XingceModuleCode, number>
}

/** 直插题目覆盖项（缺省 answer='B'、analysis 纯文本；判分测试需要富解析时覆盖） */
export interface QuestionOverrides {
  answer?: string
  analysis?: RichContent
}

/** 直插一颗最小单选题（挂模块），返回 questions.id */
export async function insertQuestion(
  moduleId: number,
  qid: string,
  stem: RichContent,
  overrides: QuestionOverrides = {},
): Promise<number> {
  const rows = await db
    .insert(questions)
    .values({
      moduleId,
      qid,
      kind: 'single_choice',
      stem,
      options: standardOptions(),
      answer: overrides.answer ?? 'B',
      analysis: overrides.analysis ?? [{ type: 'text', text: '解析' }],
    })
    .returning({ id: questions.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('questions 插入未返回 id')
  return id
}

/** 造整链内容夹具：civil_service → xingce → 四模块 + 15 题（形状见 ContentFixture 字段注释） */
export async function insertContentFixture(): Promise<ContentFixture> {
  const examTypeRows = await db.insert(examTypes).values({ code: 'civil_service', name: '公务员' }).returning({ id: examTypes.id })
  const examTypeId = examTypeRows.at(0)?.id
  if (examTypeId === undefined) throw new Error('exam_types 插入未返回 id')
  const subjectRows = await db.insert(subjects).values({ examTypeId, code: 'xingce', name: '行测' }).returning({ id: subjects.id })
  const subjectId = subjectRows.at(0)?.id
  if (subjectId === undefined) throw new Error('subjects 插入未返回 id')

  const moduleCodes: XingceModuleCode[] = ['political_theory', 'common_sense', 'verbal', 'judgement']
  const moduleIds = new Map<XingceModuleCode, number>()
  for (const code of moduleCodes) {
    const rows = await db
      .insert(modules)
      .values({ subjectId, code, name: `模块 ${code}` })
      .returning({ id: modules.id })
    const id = rows.at(0)?.id
    if (id === undefined) throw new Error('modules 插入未返回 id')
    moduleIds.set(code, id)
  }
  const politicalModuleId = moduleIds.get('political_theory')
  const commonModuleId = moduleIds.get('common_sense')
  const judgementModuleId = moduleIds.get('judgement')
  if (politicalModuleId === undefined || commonModuleId === undefined || judgementModuleId === undefined) {
    throw new Error('模块 id 缺失')
  }

  const politicalQuestionIds: number[] = []
  for (let i = 0; i < 11; i++) {
    // 前 11 题：文本段 + KEYED 图片段混合
    politicalQuestionIds.push(
      await insertQuestion(politicalModuleId, `pt-${String(i + 1).padStart(2, '0')}`, [
        { type: 'text', text: `政治理论第 ${i + 1} 题` },
        { type: 'image', path: fakeImageKey(i), alt: `图 ${i + 1}` },
      ]),
    )
  }
  // 第 12 题：含源相对路径图片段（非键形态，验证不投影）
  politicalQuestionIds.push(
    await insertQuestion(politicalModuleId, 'pt-12', [
      { type: 'text', text: '政治理论历史数据题' },
      { type: 'image', path: LEGACY_IMAGE_PATH, alt: '源相对路径图' },
    ]),
  )

  const commonQuestionIds: number[] = []
  for (let i = 0; i < 2; i++) {
    commonQuestionIds.push(
      await insertQuestion(commonModuleId, `cs-${String(i + 1).padStart(2, '0')}`, [
        { type: 'text', text: `常识第 ${i + 1} 题` },
      ]),
    )
  }

  const judgementQuestionIds: number[] = [
    await insertQuestion(judgementModuleId, 'jd-01', [{ type: 'text', text: '判断第 1 题' }]),
  ]
  return { politicalQuestionIds, commonQuestionIds, judgementQuestionIds, moduleIds }
}

export interface RecordOverrides {
  answer?: string
  isCorrect?: boolean
  isTimeout?: boolean
  durationMs?: number
}

/** 直插一条作答记录（预置历史作答/已答状态用；判分端点自身走 HTTP 路径）；sessionId null = 单题独立练习 */
export async function insertRecord(
  userId: number,
  questionId: number,
  sessionId: number | null,
  createdAt: string,
  overrides: RecordOverrides = {},
): Promise<void> {
  await db.insert(practiceRecords).values({
    userId,
    questionId,
    answer: overrides.answer ?? 'B',
    isCorrect: overrides.isCorrect ?? true,
    durationMs: overrides.durationMs ?? 1234,
    isTimeout: overrides.isTimeout ?? false,
    mode: 'module',
    sessionId: sessionId === null ? null : String(sessionId),
    createdAt,
  })
}

/** 直插一条会话（绕过 POST，用于列表/详情/续做/判分夹具） */
export async function insertSession(
  userId: number,
  moduleCode: XingceModuleCode,
  questionIds: number[],
  options: { status?: 'in_progress' | 'finished' | 'abandoned'; createdAt?: string } = {},
): Promise<number> {
  const rows = await db
    .insert(practiceSessions)
    .values({
      userId,
      mode: 'module',
      moduleCode,
      questionIds,
      status: options.status ?? 'in_progress',
      createdAt: options.createdAt ?? '2026-10-11T00:00:00.000Z',
    })
    .returning({ id: practiceSessions.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('practice_sessions 插入未返回 id')
  return id
}

/** 按用户名查 users.id（直插 records / sessions / wrong_book 夹具用） */
export async function userIdOf(username: string): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, username))
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error(`未找到用户 ${username}`)
  return id
}

/* ---------- 错题本夹具（T1-08c 判分状态机与处置端点） ---------- */

/** 直插错题本条目覆盖项（缺省为「答错一次后」的形状：active、wrongCount=1、其余 0） */
export interface WrongBookOverrides {
  status?: WrongBookStatus
  wrongCount?: number
  redoCount?: number
  consecutiveCorrect?: number
}

/** wrong_book 行（直查断言用，列类型由 schema 推导） */
export type WrongBookRow = typeof wrongBook.$inferSelect

/** 直插一条错题本条目（判分状态机/处置端点的前置态），返回 wrong_book.id */
export async function insertWrongBookEntry(
  userId: number,
  questionId: number,
  overrides: WrongBookOverrides = {},
): Promise<number> {
  const rows = await db
    .insert(wrongBook)
    .values({
      userId,
      questionId,
      status: overrides.status ?? 'active',
      wrongCount: overrides.wrongCount ?? 1,
      redoCount: overrides.redoCount ?? 0,
      consecutiveCorrect: overrides.consecutiveCorrect ?? 0,
    })
    .returning({ id: wrongBook.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('wrong_book 插入未返回 id')
  return id
}

/** 直查错题本条目行（undefined = 不在册；判分状态机与处置端点的落库断言用） */
export async function wrongBookRowOf(userId: number, questionId: number): Promise<WrongBookRow | undefined> {
  const rows = await db
    .select()
    .from(wrongBook)
    .where(and(eq(wrongBook.userId, userId), eq(wrongBook.questionId, questionId)))
  return rows.at(0)
}
