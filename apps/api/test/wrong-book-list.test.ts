import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { RichContent } from '@ncse/shared'
import { examTypes, questions, users } from '../src/db/schema'
import { bearerGet, errorField, numberField, registerForToken, requestJson, stringField } from './api-helpers'
import { db, insertContentFixture, insertQuestion, insertWrongBookEntry, userIdOf, type ContentFixture } from './practice-fixtures'
import { IMAGE_ONLY_PREVIEW, buildStemPreview, STEM_PREVIEW_MAX_LENGTH } from '../src/routes/stem-preview'

/**
 * 错题本/难点本列表 API 集成测试（T1-10a）：GET /api/wrong-book?status=active|hard
 * 经 worker 真实入口。status 过滤与缺省/非法 400、eliminated 永不列出（软移除语义）、
 * 悬空题行整条跳过、stemPreview 截断与「（图片题）」、排序 updatedAt 倒序、用户隔离、401。
 * stemPreview 规则另以纯函数直测（截断边界：恰 80 不加省略号、81 截断）。
 * 助手与夹具见 test/api-helpers.ts 与 test/practice-fixtures.ts（错题经直插 wrong_book 行——
 * 状态机本身的落库行为已在 practice-answer.test.ts 覆盖，此处选更直接的合法路径）。
 */

let content: ContentFixture

beforeEach(async () => {
  // 清空 users（级联清 wrong_book）与 exam_types（级联清内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
  content = await insertContentFixture()
})

describe('stemPreview 纯函数规则（src/routes/stem-preview.ts）', () => {
  it('text 段以空格连接；恰 80 字符不加省略号；81 字符截为 80 +「…」', () => {
    const twoParts: RichContent = [
      { type: 'text', text: '第一段' },
      { type: 'image', path: 'img/x.webp' },
      { type: 'text', text: '第二段' },
    ]
    expect(buildStemPreview(twoParts)).toBe('第一段 第二段')

    const atLimit: RichContent = [{ type: 'text', text: 'a'.repeat(STEM_PREVIEW_MAX_LENGTH) }]
    expect(buildStemPreview(atLimit)).toBe('a'.repeat(STEM_PREVIEW_MAX_LENGTH))

    const overLimit: RichContent = [{ type: 'text', text: 'a'.repeat(STEM_PREVIEW_MAX_LENGTH + 1) }]
    expect(buildStemPreview(overLimit)).toBe(`${'a'.repeat(STEM_PREVIEW_MAX_LENGTH)}…`)
  })

  it('纯图题（无 text 段）返回「（图片题）」占位', () => {
    expect(buildStemPreview([{ type: 'image', path: 'img/y.webp', alt: '图' }])).toBe(IMAGE_ONLY_PREVIEW)
    expect(buildStemPreview([])).toBe(IMAGE_ONLY_PREVIEW)
  })
})

describe('GET /api/wrong-book（列表与过滤）', () => {
  it('status 过滤与缺省：缺省/active 只列 active；hard 只列 hard；eliminated 永不列出（软移除语义）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [activeId, hardId, eliminatedId] = content.politicalQuestionIds
    await insertWrongBookEntry(userId, activeId, { status: 'active', updatedAt: '2026-10-11T00:00:00.000Z' })
    await insertWrongBookEntry(userId, hardId, { status: 'hard', updatedAt: '2026-10-11T00:00:01.000Z' })
    await insertWrongBookEntry(userId, eliminatedId, { status: 'eliminated', updatedAt: '2026-10-11T00:00:02.000Z' })

    // 缺省 = active
    const defaulted = await requestJson('/api/wrong-book', bearerGet(token))
    expect(defaulted.status).toBe(200)
    const defaultList = defaulted.body as unknown as Record<string, unknown>[]
    expect(defaultList.map((row) => numberField(row, 'questionId'))).toEqual([activeId])

    // 显式 active 同缺省
    const active = await requestJson('/api/wrong-book?status=active', bearerGet(token))
    expect((active.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      activeId,
    ])

    // hard 只列 hard 条目
    const hard = await requestJson('/api/wrong-book?status=hard', bearerGet(token))
    const hardList = hard.body as unknown as Record<string, unknown>[]
    expect(hardList.map((row) => numberField(row, 'questionId'))).toEqual([hardId])
  })

  it('列表项字段全形状：questionId/moduleCode/stemPreview/wrongCount/redoCount/status/updatedAt', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    const updatedAt = '2026-10-11T08:30:00.000Z'
    await insertWrongBookEntry(userId, questionId, {
      status: 'active',
      wrongCount: 3,
      redoCount: 2,
      updatedAt,
    })

    const { status, body } = await requestJson('/api/wrong-book', bearerGet(token))
    expect(status).toBe(200)
    const list = body as unknown as Record<string, unknown>[]
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({
      questionId,
      moduleCode: 'political_theory',
      // 夹具题干「政治理论第 1 题」+ 图片段：text 段即预览全文（不截断）
      stemPreview: '政治理论第 1 题',
      wrongCount: 3,
      redoCount: 2,
      status: 'active',
      updatedAt,
    })
  })

  it('无在册条目：200 空数组', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/wrong-book', bearerGet(token))
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it.each([
    { case: 'status=eliminated（软移除不可列出）', query: 'status=eliminated' },
    { case: 'status 非法值', query: 'status=bogus' },
    { case: 'status 空串', query: 'status=' },
  ])('status 非法（$case）：400 + bad_request', async ({ query }) => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson(`/api/wrong-book?${query}`, bearerGet(token))
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
  })

  it('排序：updatedAt 倒序（最近变化在前）；同值并列按 id 倒序稳定', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [oldest, middle, tiedFirst, tiedSecond] = content.politicalQuestionIds.slice(0, 4)
    await insertWrongBookEntry(userId, oldest, { updatedAt: '2026-10-11T01:00:00.000Z' })
    await insertWrongBookEntry(userId, middle, { updatedAt: '2026-10-11T03:00:00.000Z' })
    // 同 updatedAt 并列：后插者 id 更大，应排在前（id 倒序兜底）
    await insertWrongBookEntry(userId, tiedFirst, { updatedAt: '2026-10-11T05:00:00.000Z' })
    await insertWrongBookEntry(userId, tiedSecond, { updatedAt: '2026-10-11T05:00:00.000Z' })

    const { status, body } = await requestJson('/api/wrong-book', bearerGet(token))
    expect(status).toBe(200)
    const list = body as unknown as Record<string, unknown>[]
    expect(list.map((row) => numberField(row, 'questionId'))).toEqual([tiedSecond, tiedFirst, middle, oldest])
  })

  it('stemPreview：超 80 字符截断加「…」；纯图题为「（图片题）」；跨模块 moduleCode 正确', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const politicalModuleId = content.moduleIds.get('political_theory')
    if (politicalModuleId === undefined) throw new Error('夹具缺 political_theory 模块行')
    // 超长题干：81 个汉字 → 截为 80 + 「…」
    const longStem: RichContent = [{ type: 'text', text: '题'.repeat(STEM_PREVIEW_MAX_LENGTH + 1) }]
    const longId = await insertQuestion(politicalModuleId, 'pt-list-long', longStem)
    // 纯图题：stem 无 text 段
    const imageOnlyStem: RichContent = [{ type: 'image', path: 'img/preview-figure.webp', alt: '纯图' }]
    const commonModuleId = content.moduleIds.get('common_sense')
    if (commonModuleId === undefined) throw new Error('夹具缺 common_sense 模块行')
    const imageOnlyId = await insertQuestion(commonModuleId, 'cs-list-image', imageOnlyStem)
    await insertWrongBookEntry(userId, longId, { updatedAt: '2026-10-11T00:00:01.000Z' })
    await insertWrongBookEntry(userId, imageOnlyId, { updatedAt: '2026-10-11T00:00:02.000Z' })

    const { status, body } = await requestJson('/api/wrong-book', bearerGet(token))
    expect(status).toBe(200)
    const list = body as unknown as Record<string, unknown>[]
    expect(list.map((row) => stringField(row, 'stemPreview'))).toEqual([
      IMAGE_ONLY_PREVIEW,
      `${'题'.repeat(STEM_PREVIEW_MAX_LENGTH)}…`,
    ])
    // moduleCode 取题目当前所属模块（跨模块各归其位）
    expect(list.map((row) => stringField(row, 'moduleCode'))).toEqual(['common_sense', 'political_theory'])
  })

  it('悬空题行整条跳过：条目在册但题目行已删 → 不出现在列表', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [danglingId, keptId] = content.politicalQuestionIds.slice(0, 2)
    await insertWrongBookEntry(userId, danglingId, { updatedAt: '2026-10-11T00:00:01.000Z' })
    await insertWrongBookEntry(userId, keptId, { updatedAt: '2026-10-11T00:00:02.000Z' })
    // 直删题目行（内容重删的罕见态；库层 ON DELETE CASCADE 与 join 跳过任一生效，断言口径一致）
    await db.delete(questions).where(eq(questions.id, danglingId))

    const { status, body } = await requestJson('/api/wrong-book', bearerGet(token))
    expect(status).toBe(200)
    const list = body as unknown as Record<string, unknown>[]
    expect(list.map((row) => numberField(row, 'questionId'))).toEqual([keptId])
  })

  it('用户隔离：他人条目不出现（bob 的 active 不入 alice 列表，反之亦然）', async () => {
    const tokenAlice = await registerForToken('alice')
    const tokenBob = await registerForToken('bob')
    const aliceId = await userIdOf('alice')
    const bobId = await userIdOf('bob')
    const [aliceQuestion, bobQuestion] = [content.politicalQuestionIds[0], content.politicalQuestionIds[1]]
    await insertWrongBookEntry(aliceId, aliceQuestion, { updatedAt: '2026-10-11T00:00:01.000Z' })
    await insertWrongBookEntry(bobId, bobQuestion, { updatedAt: '2026-10-11T00:00:02.000Z' })

    const aliceList = await requestJson('/api/wrong-book', bearerGet(tokenAlice))
    expect((aliceList.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      aliceQuestion,
    ])
    const bobList = await requestJson('/api/wrong-book', bearerGet(tokenBob))
    expect((bobList.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      bobQuestion,
    ])
  })

  it('缺 token：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson('/api/wrong-book', { method: 'GET' })
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })
})
