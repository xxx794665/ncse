import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { RichContent } from '@ncse/shared'
import { examTypes, questions, users } from '../src/db/schema'
import { bearerGet, errorField, numberField, registerForToken, requestJson, stringField } from './api-helpers'
import {
  db,
  favoriteCountOf,
  insertContentFixture,
  insertFavorite,
  insertQuestion,
  userIdOf,
  type ContentFixture,
} from './practice-fixtures'
import { IMAGE_ONLY_PREVIEW } from '../src/routes/stem-preview'

/**
 * 收藏 API 集成测试（T1-10a）：GET/POST/DELETE /api/favorites 经 worker 真实入口。
 * 幂等语义（POST 重收/DELETE 行不在恒 200）、不存在题与非数字 id 404 同文案
 * （与 practice 域判分 404 一致，防存在性探测）、列表排序 createdAt 倒序、
 * 悬空题行整条跳过、用户隔离、401。助手与夹具见 test/api-helpers.ts 与 test/practice-fixtures.ts。
 */

let content: ContentFixture

beforeEach(async () => {
  // 清空 users（级联清 favorites）与 exam_types（级联清内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
  content = await insertContentFixture()
})

/** 收藏/取消请求（简写；POST 与 DELETE 同路径） */
function favorite(token: string, method: 'POST' | 'DELETE', questionId: number | string) {
  return requestJson(`/api/favorites/${questionId}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe('POST /api/favorites/:questionId（收藏）', () => {
  it('收藏：200 { questionId, favorited: true }，库落一行', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]

    const { status, body } = await favorite(token, 'POST', questionId)

    expect(status).toBe(200)
    expect(numberField(body, 'questionId')).toBe(questionId)
    expect(body.favorited).toBe(true)
    expect(await favoriteCountOf(userId)).toBe(1)
  })

  it('幂等重收：再次 POST 同题恒 200 同响应，库仍只一行（onConflictDoNothing 吸收唯一冲突）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]

    const first = await favorite(token, 'POST', questionId)
    const second = await favorite(token, 'POST', questionId)

    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(await favoriteCountOf(userId)).toBe(1)
  })

  it('不存在题/非数字 id → 404 同文案（与 practice 域判分 404 一致，防存在性探测）', async () => {
    const token = await registerForToken('alice')

    const missing = await favorite(token, 'POST', 999999)
    expect(missing.status).toBe(404)
    expect(errorField(missing.body).code).toBe('not_found')

    const nonNumeric = await favorite(token, 'POST', 'abc')
    expect(nonNumeric.status).toBe(404)
    expect(errorField(nonNumeric.body).code).toBe('not_found')

    // 两者同文案（不区分原因）
    expect(errorField(missing.body).message).toBe(errorField(nonNumeric.body).message)
    expect(errorField(missing.body).message).toBe('题目不存在')
  })
})

describe('DELETE /api/favorites/:questionId（取消收藏）', () => {
  it('取消：200 { questionId, favorited: false }，库行删除', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await favorite(token, 'POST', questionId)
    expect(await favoriteCountOf(userId)).toBe(1)

    const { status, body } = await favorite(token, 'DELETE', questionId)

    expect(status).toBe(200)
    expect(numberField(body, 'questionId')).toBe(questionId)
    expect(body.favorited).toBe(false)
    expect(await favoriteCountOf(userId)).toBe(0)
  })

  it('幂等取消：行不在（含从未收藏的题）恒 200 同响应，不报错不落行', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await favorite(token, 'POST', questionId)

    // 取消后再取消：恒 200
    const repeat = await favorite(token, 'DELETE', questionId)
    expect(repeat.status).toBe(200)
    expect(repeat.body.favorited).toBe(false)
    // 从未收藏过的题（含库中不存在的题 id）：删 0 行亦恒 200（用户自身数据无探测面）
    const never = await favorite(token, 'DELETE', content.politicalQuestionIds[1])
    expect(never.status).toBe(200)
    expect(never.body.favorited).toBe(false)
    const missingQuestion = await favorite(token, 'DELETE', 999999)
    expect(missingQuestion.status).toBe(200)
    expect(missingQuestion.body.favorited).toBe(false)
    expect(await favoriteCountOf(userId)).toBe(0)
  })

  it('非数字 id → 404 同文案（与 POST 一致）', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await favorite(token, 'DELETE', 'abc')
    expect(status).toBe(404)
    expect(errorField(body).code).toBe('not_found')
    expect(errorField(body).message).toBe('题目不存在')
  })
})

describe('GET /api/favorites（收藏列表）', () => {
  it('排序 createdAt 倒序（最近收藏在前）、stemPreview/moduleCode/favoritedAt 字段全形状', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [oldest, middle, tiedFirst, tiedSecond] = content.politicalQuestionIds.slice(0, 4)
    await insertFavorite(userId, oldest, { createdAt: '2026-10-11T01:00:00.000Z' })
    await insertFavorite(userId, middle, { createdAt: '2026-10-11T03:00:00.000Z' })
    // 同 createdAt 并列：后插者 id 更大，应排在前（id 倒序兜底）
    await insertFavorite(userId, tiedFirst, { createdAt: '2026-10-11T05:00:00.000Z' })
    await insertFavorite(userId, tiedSecond, { createdAt: '2026-10-11T05:00:00.000Z' })

    const { status, body } = await requestJson('/api/favorites', bearerGet(token))
    expect(status).toBe(200)
    const list = body as unknown as Record<string, unknown>[]
    expect(list.map((row) => numberField(row, 'questionId'))).toEqual([tiedSecond, tiedFirst, middle, oldest])
    // 全形状：夹具题干 text 段即预览、moduleCode 归属正确（tiedSecond 为第 4 题索引 3）
    expect(list[0]).toEqual({
      questionId: tiedSecond,
      moduleCode: 'political_theory',
      stemPreview: '政治理论第 4 题',
      favoritedAt: '2026-10-11T05:00:00.000Z',
    })
  })

  it('纯图题 stemPreview 为「（图片题）」；无收藏：200 空数组', async () => {
    const token = await registerForToken('alice')
    const empty = await requestJson('/api/favorites', bearerGet(token))
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual([])

    const userId = await userIdOf('alice')
    const politicalModuleId = content.moduleIds.get('political_theory')
    if (politicalModuleId === undefined) throw new Error('夹具缺 political_theory 模块行')
    const imageOnlyStem: RichContent = [{ type: 'image', path: 'img/favorite-figure.webp', alt: '纯图' }]
    const imageOnlyId = await insertQuestion(politicalModuleId, 'pt-fav-image', imageOnlyStem)
    await insertFavorite(userId, imageOnlyId, { createdAt: '2026-10-11T02:00:00.000Z' })

    const { status, body } = await requestJson('/api/favorites', bearerGet(token))
    expect(status).toBe(200)
    const list = body as unknown as Record<string, unknown>[]
    expect(list).toHaveLength(1)
    expect(stringField(list[0], 'stemPreview')).toBe(IMAGE_ONLY_PREVIEW)
  })

  it('悬空题行整条跳过：收藏在册但题目行已删 → 不出现在列表', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [danglingId, keptId] = content.politicalQuestionIds.slice(0, 2)
    await insertFavorite(userId, danglingId, { createdAt: '2026-10-11T01:00:00.000Z' })
    await insertFavorite(userId, keptId, { createdAt: '2026-10-11T02:00:00.000Z' })
    // 直删题目行（内容重删的罕见态；库层 ON DELETE CASCADE 与 join 跳过任一生效，断言口径一致）
    await db.delete(questions).where(eq(questions.id, danglingId))

    const { status, body } = await requestJson('/api/favorites', bearerGet(token))
    expect(status).toBe(200)
    const list = body as unknown as Record<string, unknown>[]
    expect(list.map((row) => numberField(row, 'questionId'))).toEqual([keptId])
  })

  it('用户隔离：他人收藏不出现；他人 DELETE 不动我的行', async () => {
    const tokenAlice = await registerForToken('alice')
    const tokenBob = await registerForToken('bob')
    const aliceId = await userIdOf('alice')
    const bobId = await userIdOf('bob')
    const [aliceQuestion, bobQuestion] = [content.politicalQuestionIds[0], content.politicalQuestionIds[1]]
    await insertFavorite(aliceId, aliceQuestion, { createdAt: '2026-10-11T01:00:00.000Z' })
    await insertFavorite(bobId, bobQuestion, { createdAt: '2026-10-11T02:00:00.000Z' })

    const aliceList = await requestJson('/api/favorites', bearerGet(tokenAlice))
    expect((aliceList.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      aliceQuestion,
    ])

    // bob 取消 alice 的收藏：删 0 行恒 200，alice 的行原样保留
    const foreignDelete = await favorite(tokenBob, 'DELETE', aliceQuestion)
    expect(foreignDelete.status).toBe(200)
    expect(await favoriteCountOf(aliceId)).toBe(1)
    const afterList = await requestJson('/api/favorites', bearerGet(tokenAlice))
    expect((afterList.body as unknown as Record<string, unknown>[]).map((row) => numberField(row, 'questionId'))).toEqual([
      aliceQuestion,
    ])
  })
})

describe('鉴权（三端点）', () => {
  it('缺 token：401 + unauthorized 信封', async () => {
    const outcomes = [
      await requestJson('/api/favorites', { method: 'GET' }),
      await requestJson('/api/favorites/1', { method: 'POST' }),
      await requestJson('/api/favorites/1', { method: 'DELETE' }),
    ]
    for (const { status, body } of outcomes) {
      expect(status).toBe(401)
      expect(errorField(body).code).toBe('unauthorized')
    }
  })
})
