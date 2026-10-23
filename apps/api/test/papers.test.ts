import { asc, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { createDb, type DbClient } from '../src/db'
import { examTypes, modules, papers, questionPapers, questions, subjects } from '../src/db/schema'

/**
 * papers / question_papers 表结构冒烟（T2-01a，ADR-0012）：两表默认值、papers.name
 * 唯一拦截、(paper_id, question_id) 唯一拦截、双 FK 级联删除与 sequence 卷内序往返。
 * 建表迁移由套件 setup（apply-migrations.ts）自动应用——本文件用例即隐式验证
 * 0003 迁移可在真实 D1（workerd 内 miniflare）应用与执行。
 * 试卷与题目行直插（题目挂 exam_type→subject→module 完整链，合成虚构内容）。
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
      analysis: [{ type: 'text', text: '解析' }],
    })
    .returning({ id: questions.id })
  const questionId = questionRows.at(0)?.id
  if (questionId === undefined) throw new Error('questions 插入未返回 id')
  return questionId
}

/** 插入一条最小试卷行并返回新行 id（来源元数据可空场景） */
async function insertPaper(name: string): Promise<number> {
  const rows = await db.insert(papers).values({ name, questionCount: 0 }).returning({ id: papers.id })
  const id = rows.at(0)?.id
  if (id === undefined) throw new Error('papers 插入未返回 id')
  return id
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
  // 清空 papers（级联清掉 question_papers）与 exam_types（级联清掉内容域链条），用例互不依赖
  await db.delete(papers)
  await db.delete(examTypes)
})

describe('papers / question_papers 表（T2-01a，ADR-0012）', () => {
  it('插入试卷行：来源元数据可空落 NULL，created_at/updated_at 落库端默认 ISO 时间戳', async () => {
    const paperId = await insertPaper('2024年虚构省联考《行测》题（测试卷）')

    const row = (await db.select().from(papers).where(eq(papers.id, paperId))).at(0)
    expect(row).toBeDefined()
    expect(row?.name).toBe('2024年虚构省联考《行测》题（测试卷）')
    expect(row?.year).toBeNull()
    expect(row?.region).toBeNull()
    expect(row?.paperType).toBeNull()
    expect(row?.questionCount).toBe(0)
    // common.ts 约定：TEXT 存 ISO-8601 UTC（库端 strftime 计算，不依赖写入方时钟）
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('papers.name 唯一拦截：同名卷二次插入被 UNIQUE 约束拒绝', async () => {
    await insertPaper('重复卷名测试')
    await expectUniqueRejection(db.insert(papers).values({ name: '重复卷名测试', questionCount: 0 }))
  })

  it('question_papers (paper_id, question_id) 唯一拦截：同卷同题二次挂靠被拒绝', async () => {
    const paperId = await insertPaper('唯一约束测试卷')
    const questionId = await insertQuestion('paper-schema-test-qid-1')
    await db.insert(questionPapers).values({ paperId, questionId, sequence: 1 })
    await expectUniqueRejection(db.insert(questionPapers).values({ paperId, questionId, sequence: 2 }))
  })

  it('sequence 卷内序写入/读回往返一致（ORDER BY sequence 按卷内序取整卷题集）', async () => {
    const paperId = await insertPaper('序号往返测试卷')
    const q1 = await insertQuestion('paper-schema-test-qid-2')
    const q2 = await insertQuestion('paper-schema-test-qid-3')
    // 卷内序允许空隙（质量门跳过留真实卷序），此处 1/3 两值验证原样往返
    await db.insert(questionPapers).values({ paperId, questionId: q1, sequence: 1 })
    await db.insert(questionPapers).values({ paperId, questionId: q2, sequence: 3 })

    const rows = await db
      .select({ qid: questions.qid, sequence: questionPapers.sequence })
      .from(questionPapers)
      .innerJoin(questions, eq(questions.id, questionPapers.questionId))
      .where(eq(questionPapers.paperId, paperId))
      .orderBy(asc(questionPapers.sequence))
    expect(rows).toEqual([
      { qid: 'paper-schema-test-qid-2', sequence: 1 },
      { qid: 'paper-schema-test-qid-3', sequence: 3 },
    ])
  })

  it('paper 外键级联：删除 papers 行后其归属 pair 随之消失，其他卷的 pair 不受影响', async () => {
    const paperA = await insertPaper('级联测试甲卷')
    const paperB = await insertPaper('级联测试乙卷')
    const questionId = await insertQuestion('paper-schema-test-qid-4')
    await db.insert(questionPapers).values({ paperId: paperA, questionId, sequence: 1 })
    await db.insert(questionPapers).values({ paperId: paperB, questionId, sequence: 1 })

    await db.delete(papers).where(eq(papers.id, paperA))

    const remaining = await db
      .select({ paperId: questionPapers.paperId })
      .from(questionPapers)
      .where(eq(questionPapers.questionId, questionId))
    expect(remaining).toEqual([{ paperId: paperB }])
  })

  it('question 外键级联：删除 questions 行后其全部归属 pair 随之消失', async () => {
    const paperA = await insertPaper('级联测试丙卷')
    const paperB = await insertPaper('级联测试丁卷')
    const questionId = await insertQuestion('paper-schema-test-qid-5')
    const otherQuestionId = await insertQuestion('paper-schema-test-qid-6')
    await db.insert(questionPapers).values({ paperId: paperA, questionId, sequence: 1 })
    await db.insert(questionPapers).values({ paperId: paperB, questionId, sequence: 1 })
    await db.insert(questionPapers).values({ paperId: paperA, questionId: otherQuestionId, sequence: 1 })

    await db.delete(questions).where(eq(questions.id, questionId))

    const remaining = await db
      .select({ paperId: questionPapers.paperId, questionId: questionPapers.questionId })
      .from(questionPapers)
    expect(remaining).toEqual([{ paperId: paperA, questionId: otherQuestionId }])
  })
})
