import { beforeEach, describe, expect, it } from 'vitest'
import { examTypes, users } from '../src/db/schema'
import { bearerPost, errorField, numberField, registerForToken, requestJson, stringField } from './api-helpers'
import { db, insertContentFixture, insertWrongBookEntry, userIdOf, wrongBookRowOf, type ContentFixture } from './practice-fixtures'

/**
 * 错题本处置 API 集成测试（T1-08c，ADR-0010）：POST /api/wrong-book/:questionId/disposal
 * 经 worker 真实入口。remove → eliminated（软移除保计数）/ to_hard → hard；
 * 任意在册状态（active/hard/eliminated）均可跨状态处置（幂等，用户自主管理）。
 * 助手与夹具见 test/api-helpers.ts 与 test/practice-fixtures.ts。
 */

let content: ContentFixture

beforeEach(async () => {
  // 清空 users（级联清 wrong_book）与 exam_types（级联清内容域链条，题目 id 重新自增），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
  content = await insertContentFixture()
})

/** 处置请求（简写） */
function dispose(token: string, questionId: number | string, body: unknown) {
  return requestJson(`/api/wrong-book/${questionId}/disposal`, bearerPost(token, body))
}

describe('POST /api/wrong-book/:questionId/disposal（用户处置）', () => {
  it('remove：active → eliminated，wrongCount/redoCount/consecutiveCorrect 原值保留（响应与库行一致）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await insertWrongBookEntry(userId, questionId, { status: 'active', wrongCount: 3, redoCount: 2, consecutiveCorrect: 1 })

    const { status, body } = await dispose(token, questionId, { action: 'remove' })

    expect(status).toBe(200)
    expect(numberField(body, 'questionId')).toBe(questionId)
    expect(stringField(body, 'status')).toBe('eliminated')
    expect(numberField(body, 'wrongCount')).toBe(3)
    expect(numberField(body, 'redoCount')).toBe(2)
    expect(numberField(body, 'consecutiveCorrect')).toBe(1)

    const entry = await wrongBookRowOf(userId, questionId)
    expect(entry?.status).toBe('eliminated')
    expect(entry?.wrongCount).toBe(3)
    expect(entry?.redoCount).toBe(2)
    expect(entry?.consecutiveCorrect).toBe(1)
  })

  it('to_hard：active → hard', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await insertWrongBookEntry(userId, questionId)

    const { status, body } = await dispose(token, questionId, { action: 'to_hard' })

    expect(status).toBe(200)
    expect(stringField(body, 'status')).toBe('hard')
    const entry = await wrongBookRowOf(userId, questionId)
    expect(entry?.status).toBe('hard')
  })

  it('跨状态处置（幂等）：hard 行再 remove → eliminated；eliminated 行再 to_hard → hard', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const [hardId, eliminatedId] = [content.politicalQuestionIds[0], content.politicalQuestionIds[1]]
    await insertWrongBookEntry(userId, hardId, { status: 'hard' })
    await insertWrongBookEntry(userId, eliminatedId, { status: 'eliminated' })

    const hardToRemove = await dispose(token, hardId, { action: 'remove' })
    expect(hardToRemove.status).toBe(200)
    expect(stringField(hardToRemove.body, 'status')).toBe('eliminated')
    expect((await wrongBookRowOf(userId, hardId))?.status).toBe('eliminated')

    const eliminatedToHard = await dispose(token, eliminatedId, { action: 'to_hard' })
    expect(eliminatedToHard.status).toBe(200)
    expect(stringField(eliminatedToHard.body, 'status')).toBe('hard')
    expect((await wrongBookRowOf(userId, eliminatedId))?.status).toBe('hard')
  })

  it('不存在/非数字/他人条目 → 404 not_found 同文案（防存在性探测）', async () => {
    const tokenA = await registerForToken('alice')
    const tokenB = await registerForToken('bob')
    const aliceId = await userIdOf('alice')
    const bobId = await userIdOf('bob')
    const questionId = content.politicalQuestionIds[0]
    await insertWrongBookEntry(aliceId, questionId)

    // 不存在（无任何用户在册）
    const missing = await dispose(tokenA, content.politicalQuestionIds[1], { action: 'remove' })
    expect(missing.status).toBe(404)
    expect(errorField(missing.body).code).toBe('not_found')

    // 非数字 id
    const nonNumeric = await dispose(tokenA, 'abc', { action: 'remove' })
    expect(nonNumeric.status).toBe(404)
    expect(errorField(nonNumeric.body).code).toBe('not_found')

    // 他人条目（bob 对 alice 的在册条目处置）
    const foreign = await dispose(tokenB, questionId, { action: 'remove' })
    expect(foreign.status).toBe(404)
    expect(errorField(foreign.body).code).toBe('not_found')

    // 三者同文案（不存在与他人条目不区分）
    const messages = [missing, nonNumeric, foreign].map((outcome) => errorField(outcome.body).message)
    expect(new Set(messages).size).toBe(1)

    // 他人处置不改变原行（幂等隔离）
    expect((await wrongBookRowOf(aliceId, questionId))?.status).toBe('active')
    // bob 自己的条目照常可处置
    await insertWrongBookEntry(bobId, questionId)
    const own = await dispose(tokenB, questionId, { action: 'to_hard' })
    expect(own.status).toBe(200)
    expect((await wrongBookRowOf(bobId, questionId))?.status).toBe('hard')
  })

  it.each([
    { case: 'action 非法值 keep', requestBody: { action: 'keep' } },
    { case: 'action 缺失', requestBody: {} },
    { case: 'action 类型错（数字）', requestBody: { action: 1 } },
  ])('action 非法（$case）：400 + bad_request', async ({ requestBody }) => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await insertWrongBookEntry(userId, questionId)

    const { status, body } = await dispose(token, questionId, requestBody)
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
    // 处置失败不改状态
    expect((await wrongBookRowOf(userId, questionId))?.status).toBe('active')
  })

  it('body 非 JSON：400 + bad_request', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const questionId = content.politicalQuestionIds[0]
    await insertWrongBookEntry(userId, questionId)

    const { status, body } = await requestJson(`/api/wrong-book/${questionId}/disposal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: 'not-json',
    })
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
  })

  it('缺 token：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson('/api/wrong-book/1/disposal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove' }),
    })
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })
})
