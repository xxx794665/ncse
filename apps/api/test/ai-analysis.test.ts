import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { createDb, type DbClient } from '../src/db'
import { examTypes, modules, questionAiAnalysis, questions, subjects } from '../src/db/schema'

/**
 * question_ai_analysis 表结构冒烟（M3/T3-01g 一期，AI 解析开发期批量增强）：
 * 默认值（ai_version 缺省 1、时间戳库端 ISO）、questionId 唯一拦截（一对一）、
 * question 外键级联删除、onConflictDoUpdate 版本覆盖语义（吸收管线幂等 upsert
 * 的 schema 侧印证）。官方解析列（questions.analysis）不受影响——AI 解析为后置
 * 增强层，不动题库主体。
 * 建表迁移由套件 setup（apply-migrations.ts）自动应用——本文件用例即隐式验证
 * 0005 迁移可在真实 D1（workerd 内 miniflare）应用与执行。
 * 题目行直插（题目挂 exam_type→subject→module 完整链，合成虚构内容）。
 */

const db: DbClient = createDb(env)

/** 造内容域链条（exam_type→subject→module，同测试内已存在则复用），返回 modules.id */
async function ensureModule(): Promise<number> {
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
  return moduleId
}

/** 造一颗最小单选题（复用内容域链条；多题同测试不重复建链），返回 questions.id */
async function insertQuestion(qid: string): Promise<number> {
  const moduleId = await ensureModule()
  const questionRows = await db
    .insert(questions)
    .values({
      moduleId,
      qid,
      kind: 'single_choice',
      stem: [{ type: 'text', text: '题干' }],
      options: [{ key: 'A', content: [{ type: 'text', text: '选项 A' }] }],
      answer: 'A',
      analysis: [{ type: 'text', text: '官方解析' }],
    })
    .returning({ id: questions.id })
  const questionId = questionRows.at(0)?.id
  if (questionId === undefined) throw new Error('questions 插入未返回 id')
  return questionId
}

/** 断言插入触发 UNIQUE 约束（drizzle 可能包装 cause，消息两层都查） */
async function expectUniqueRejection(promise: Promise<unknown>): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeDefined()
  const causes = [caught, caught instanceof Error ? caught.cause : undefined]
  const messages = causes.filter((entry): entry is Error => entry instanceof Error).map((entry) => entry.message)
  expect(messages.join('\n')).toMatch(/UNIQUE constraint failed/)
}

beforeEach(async () => {
  // 清空 exam_types（级联清掉内容域链条与 AI 解析行），用例互不依赖
  await db.delete(examTypes)
})

describe('question_ai_analysis 表（M3/T3-01g）', () => {
  it('插入行：ai_version 缺省 1、content 多行纯文本往返、created_at/updated_at 落库端默认 ISO 时间戳', async () => {
    const questionId = await insertQuestion('ai-schema-test-qid-1')
    const content = '方法论：先抓限定词。\n\n多角度：干扰项错在范围扩大。'
    const rows = await db.insert(questionAiAnalysis).values({ questionId, content }).returning()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe(content)
    expect(rows[0]?.aiVersion).toBe(1)
    // common.ts 约定：TEXT 存 ISO-8601 UTC（库端 strftime 计算，不依赖写入方时钟）
    expect(rows[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(rows[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('question_id 唯一拦截：同题二次插入被 UNIQUE 约束拒绝（一对一语义）', async () => {
    const questionId = await insertQuestion('ai-schema-test-qid-2')
    await db.insert(questionAiAnalysis).values({ questionId, content: '讲解一' })
    await expectUniqueRejection(db.insert(questionAiAnalysis).values({ questionId, content: '讲解二' }))
  })

  it('onConflictDoUpdate 版本覆盖：同题重写原地更新 content/ai_version、不换行不重复', async () => {
    const questionId = await insertQuestion('ai-schema-test-qid-3')
    const first = await db
      .insert(questionAiAnalysis)
      .values({ questionId, content: '旧版讲解', aiVersion: 5 })
      .returning({ id: questionAiAnalysis.id })
    const id = first.at(0)?.id
    await db
      .insert(questionAiAnalysis)
      .values({ questionId, content: '新版讲解\n换角度。', aiVersion: 9 })
      .onConflictDoUpdate({
        target: questionAiAnalysis.questionId,
        set: { content: '新版讲解\n换角度。', aiVersion: 9 },
      })
    const rows = await db.select().from(questionAiAnalysis).where(eq(questionAiAnalysis.questionId, questionId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(id) // ON CONFLICT 原地更新不换行
    expect(rows[0]?.content).toBe('新版讲解\n换角度。')
    expect(rows[0]?.aiVersion).toBe(9)
  })

  it('question 外键级联：删除 questions 行后其 AI 解析行随之消失，他题不受影响', async () => {
    const questionIdA = await insertQuestion('ai-schema-test-qid-4')
    const questionIdB = await insertQuestion('ai-schema-test-qid-5')
    await db.insert(questionAiAnalysis).values({ questionId: questionIdA, content: '甲题讲解' })
    await db.insert(questionAiAnalysis).values({ questionId: questionIdB, content: '乙题讲解' })

    await db.delete(questions).where(eq(questions.id, questionIdA))

    const remaining = await db
      .select({ questionId: questionAiAnalysis.questionId, content: questionAiAnalysis.content })
      .from(questionAiAnalysis)
    expect(remaining).toEqual([{ questionId: questionIdB, content: '乙题讲解' }])
  })
})
