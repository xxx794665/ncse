import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import type { XingceModuleCode } from '@ncse/shared'
import { createDb, type DbClient } from '../src/db'
import { examTypes, modules, practiceRecords, practiceSessions, questions, subjects, users } from '../src/db/schema'

/**
 * practice_sessions 表结构冒烟（T1-08a，ADR-0009）：建表迁移、默认值、JSON 列、
 * 外键级联与 practice_records.session_id 的纯 TEXT 衔接形态（业务端点为 T1-08b，不在本片）。
 * 建表迁移由套件 setup（apply-migrations.ts）自动应用——本文件用例即隐式验证迁移可应用。
 * 用户行直插 users（密码哈希为合成值，测试不触发登录）。
 */

const db: DbClient = createDb(env)

/** 直插 users 并返回新行 id（密码哈希为合成占位，不构成可用凭据） */
async function insertUser(username: string): Promise<number> {
  const rows = await db.insert(users).values({ username, passwordHash: 'synthetic-placeholder' }).returning({ id: users.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('users 插入未返回 id')
  return id
}

/** 造一颗最小单选题（挂 exam_type→subject→module 完整链），返回 questions.id */
async function insertQuestion(): Promise<number> {
  const examTypeRows = await db.insert(examTypes).values({ code: 'civil_service', name: '公务员' }).returning({ id: examTypes.id })
  const examTypeId = examTypeRows.at(0)?.id
  if (examTypeId === undefined) throw new Error('exam_types 插入未返回 id')
  const subjectRows = await db.insert(subjects).values({ examTypeId, code: 'xingce', name: '行测' }).returning({ id: subjects.id })
  const subjectId = subjectRows.at(0)?.id
  if (subjectId === undefined) throw new Error('subjects 插入未返回 id')
  const moduleRows = await db.insert(modules).values({ subjectId, code: 'verbal', name: '言语理解' }).returning({ id: modules.id })
  const moduleId = moduleRows.at(0)?.id
  if (moduleId === undefined) throw new Error('modules 插入未返回 id')
  const questionRows = await db
    .insert(questions)
    .values({
      moduleId,
      qid: 'practice-session-test-qid',
      kind: 'single_choice',
      stem: [{ type: 'text', text: '题干' }],
      options: [{ key: 'A', content: [{ type: 'text', text: '选项 A' }] }],
      answer: 'A',
      analysis: [{ type: 'text', text: '解析' }],
    })
    .returning({ id: questions.id })
  const questionId = questionRows.at(0)?.id
  if (questionId === undefined) throw new Error('questions 插入未返回 id')
  return questionId
}

/** 插入一条最小会话并返回新行 id（moduleCode 可省：库层可空，mode='module' 必填约束在应用层，T1-08b） */
async function insertSession(userId: number, questionIds: number[], moduleCode?: XingceModuleCode): Promise<number> {
  const rows = await db
    .insert(practiceSessions)
    .values({ userId, mode: 'module', moduleCode, questionIds })
    .returning({ id: practiceSessions.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('practice_sessions 插入未返回 id')
  return id
}

beforeEach(async () => {
  // 清空 users（级联清掉 practice_sessions / practice_records）与 exam_types（级联清掉内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
})

describe('practice_sessions 表（T1-08a，ADR-0009）', () => {
  it('插入会话行：status 默认 in_progress，created_at/updated_at 落库端默认 ISO 时间戳', async () => {
    const userId = await insertUser('alice')
    const sessionId = await insertSession(userId, [1], 'verbal')

    const row = (await db.select().from(practiceSessions).where(eq(practiceSessions.id, sessionId))).at(0)
    expect(row).toBeDefined()
    expect(row?.status).toBe('in_progress')
    // common.ts 约定：TEXT 存 ISO-8601 UTC（库端 strftime 计算，不依赖写入方时钟）
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('questionIds JSON 数组写入/读回往返一致', async () => {
    const userId = await insertUser('alice')
    const sessionId = await insertSession(userId, [1, 42, 999], 'verbal')

    const rows = await db
      .select({ questionIds: practiceSessions.questionIds })
      .from(practiceSessions)
      .where(eq(practiceSessions.id, sessionId))
    expect(rows.at(0)?.questionIds).toEqual([1, 42, 999])
  })

  it('用户外键级联：删除 users 行后该用户的会话行随之消失，其他用户不受影响', async () => {
    const alice = await insertUser('alice')
    const bob = await insertUser('bob')
    await insertSession(alice, [1], 'verbal')
    await insertSession(bob, [2], 'verbal')

    await db.delete(users).where(eq(users.id, alice))

    const remaining = await db.select({ userId: practiceSessions.userId }).from(practiceSessions)
    expect(remaining).toEqual([{ userId: bob }])
  })

  it('moduleCode 可空落 NULL 且 mode 落值正确；practice_records.session_id 挂会话 id 字符串写入/读回', async () => {
    const userId = await insertUser('alice')
    const sessionId = await insertSession(userId, [5])

    const sessionRow = (await db.select().from(practiceSessions).where(eq(practiceSessions.id, sessionId))).at(0)
    expect(sessionRow?.moduleCode).toBeNull()
    expect(sessionRow?.mode).toBe('module')

    // 两表衔接形态：无外键纯 TEXT，session_id 存 practice_sessions.id 的字符串形式
    const questionId = await insertQuestion()
    const recordRows = await db
      .insert(practiceRecords)
      .values({
        userId,
        questionId,
        answer: 'A',
        isCorrect: true,
        durationMs: 1000,
        mode: 'module',
        sessionId: String(sessionId),
      })
      .returning({ sessionId: practiceRecords.sessionId })
    expect(recordRows.at(0)?.sessionId).toBe(String(sessionId))
  })

  it('updated_at 经 Drizzle ORM 更新时刷新（created_at 不动）', async () => {
    const userId = await insertUser('alice')
    const sessionId = await insertSession(userId, [1], 'verbal')
    const before = (await db.select().from(practiceSessions).where(eq(practiceSessions.id, sessionId))).at(0)

    // $onUpdate 取毫秒精度时间戳，隔一小段时间保证前后值可观测差异
    await new Promise((resolve) => setTimeout(resolve, 25))

    await db.update(practiceSessions).set({ status: 'finished' }).where(eq(practiceSessions.id, sessionId))
    const after = (await db.select().from(practiceSessions).where(eq(practiceSessions.id, sessionId))).at(0)

    expect(after?.status).toBe('finished')
    expect(after?.createdAt).toBe(before?.createdAt)
    expect(after?.updatedAt).not.toBe(before?.updatedAt)
  })
})
