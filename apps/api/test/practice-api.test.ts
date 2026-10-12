import { beforeEach, describe, expect, it } from 'vitest'
import type { QuestionOption, RichContent, RichSegment } from '@ncse/shared'
import { examTypes, users } from '../src/db/schema'
import {
  bearerGet,
  bearerPost,
  errorField,
  numberField,
  ORIGIN,
  postJson,
  questionList,
  registerForToken,
  requestJson,
} from './api-helpers'
import {
  db,
  fakeImageKey,
  insertContentFixture,
  insertRecord,
  insertSession,
  LEGACY_IMAGE_PATH,
  userIdOf,
  type ContentFixture,
} from './practice-fixtures'

/**
 * 专项刷题·练习会话 API 集成测试（T1-08b）：经 worker 入口走真实 fetch
 * （含 CORS、路由挂载、onError 错误信封），D1 为 workerd 内的本地实例。
 * 已答状态经直插 practice_records 模拟（判分端点见 practice-answer.test.ts，T1-08c）。
 * 请求/断言助手与内容夹具抽至 test/api-helpers.ts 与 test/practice-fixtures.ts
 * （civil_service/xingce 链下 political_theory 12 题 + common_sense 2 题 + judgement 1 题
 * + verbal 模块行不插题，验证「模块暂无题目」分支）。
 */

let content: ContentFixture

beforeEach(async () => {
  // 清空 users（级联清 practice_sessions / practice_records / wrong_book）与 exam_types（级联清内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
  content = await insertContentFixture()
})

describe('POST /api/practice/sessions（建会话与抽题）', () => {
  it('缺省 count：201，total=10、10 题均属该模块、answered 全 null、mode/moduleCode 正确', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/practice/sessions', bearerPost(token, { module: 'political_theory' }))

    expect(status).toBe(201)
    expect(numberField(body, 'id')).toBeGreaterThan(0)
    expect(body.mode).toBe('module')
    expect(body.moduleCode).toBe('political_theory')
    expect(body.status).toBe('in_progress')
    expect(numberField(body, 'total')).toBe(10)
    expect(numberField(body, 'answeredCount')).toBe(0)
    const list = questionList(body)
    expect(list).toHaveLength(10)
    for (const question of list) {
      expect(content.politicalQuestionIds).toContain(numberField(question, 'id'))
      expect(question.kind).toBe('single_choice')
      expect(question.answered).toBeNull()
    }
  })

  it('题量不足：按实际数建会话不报错（common_sense 仅 2 题、请求 count=5 → total=2）', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/practice/sessions', bearerPost(token, { module: 'common_sense', count: 5 }))

    expect(status).toBe(201)
    expect(numberField(body, 'total')).toBe(2)
    const ids = questionList(body).map((question) => numberField(question, 'id'))
    expect(ids.every((id) => content.commonQuestionIds.includes(id))).toBe(true)
    expect(new Set(ids).size).toBe(2)
  })

  it('模块无题目（verbal 有模块行无题）：400 bad_request，消息含模块 code 与「暂无题目」', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/practice/sessions', bearerPost(token, { module: 'verbal' }))

    expect(status).toBe(400)
    const error = errorField(body)
    expect(error.code).toBe('bad_request')
    expect(error.message).toContain('verbal')
    expect(error.message).toContain('暂无题目')
  })

  it.each([
    { case: 'count 非法值 7', requestBody: { module: 'political_theory', count: 7 } },
    { case: 'count 类型非法', requestBody: { module: 'political_theory', count: '10' } },
    { case: 'module 非法', requestBody: { module: 'nope' } },
    { case: 'module 缺失', requestBody: {} },
  ])('入参不合法（$case）：400 + bad_request', async ({ requestBody }) => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/practice/sessions', bearerPost(token, requestBody))
    expect(status).toBe(400)
    expect(errorField(body).code).toBe('bad_request')
  })

  it('未做过优先：已答 2 题不入新会话（12 - 2 = 10 恰好全取未做过）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const answeredIds = content.politicalQuestionIds.slice(0, 2)
    for (const [index, questionId] of answeredIds.entries()) {
      await insertRecord(userId, questionId, null, `2026-01-01T00:00:${String(index + 1).padStart(2, '0')}.000Z`)
    }

    const { status, body } = await requestJson('/api/practice/sessions', bearerPost(token, { module: 'political_theory' }))

    expect(status).toBe(201)
    expect(numberField(body, 'total')).toBe(10)
    const ids = questionList(body).map((question) => numberField(question, 'id'))
    // 抽中题目与已答 2 题的交集为空，且恰为剩余 10 题（未做过的在前、全量取尽）
    expect(ids.filter((id) => answeredIds.includes(id))).toEqual([])
    expect([...new Set(ids)].sort((a, b) => a - b)).toEqual(
      content.politicalQuestionIds.filter((id) => !answeredIds.includes(id)).sort((a, b) => a - b),
    )
  })

  it('不足补齐：全部已答时按最近作答最旧优先取已答题（断言最旧 5 题在集合内，顺序允许）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    // 12 题全插作答记录，created_at 随索引递增（索引 0 最旧）
    for (const [index, questionId] of content.politicalQuestionIds.entries()) {
      await insertRecord(userId, questionId, null, `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`)
    }

    const { status, body } = await requestJson(
      '/api/practice/sessions',
      bearerPost(token, { module: 'political_theory', count: 5 }),
    )

    expect(status).toBe(201)
    expect(numberField(body, 'total')).toBe(5)
    const ids = questionList(body).map((question) => numberField(question, 'id'))
    // MAX(created_at) ASC：恰为作答时间最旧的 5 题（随机并列，集合断言）
    expect([...ids].sort((a, b) => a - b)).toEqual(content.politicalQuestionIds.slice(0, 5))
  })
})

describe('GET /api/practice/sessions/:id（详情与投影）', () => {
  it('DTO 不泄答案：POST 与 GET 响应逐题无 answer/analysis 字段（服务端判分共识）', async () => {
    const token = await registerForToken('alice')
    const created = await requestJson('/api/practice/sessions', bearerPost(token, { module: 'political_theory' }))
    expect(created.status).toBe(201)

    const detail = await requestJson(`/api/practice/sessions/${numberField(created.body, 'id')}`, bearerGet(token))
    expect(detail.status).toBe(200)

    for (const responseBody of [created.body, detail.body]) {
      const list = questionList(responseBody)
      expect(list.length).toBeGreaterThan(0)
      for (const question of list) {
        expect(question).not.toHaveProperty('answer')
        expect(question).not.toHaveProperty('analysis')
      }
    }
  })

  it('图片段 URL 投影：KEYED 形态拼 /api/img 绝对 URL、text 段与非键形态原样', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    // 直插会话钉死题目序：[KEYED 题目, 源相对路径题目]
    const [keyedId, legacyId] = [content.politicalQuestionIds[0], content.politicalQuestionIds[11]]
    const sessionId = await insertSession(userId, 'political_theory', [keyedId, legacyId])

    const { status, body } = await requestJson(`/api/practice/sessions/${sessionId}`, bearerGet(token))

    expect(status).toBe(200)
    const list = questionList(body)
    expect(list.map((question) => numberField(question, 'id'))).toEqual([keyedId, legacyId])
    const [keyed, legacy] = list

    const stem = keyed.stem as RichContent
    expect(stem).toHaveLength(2)
    expect(stem[0]).toEqual({ type: 'text', text: '政治理论第 1 题' })
    const imageSegment = stem[1] as Extract<RichSegment, { type: 'image' }>
    // 请求 origin + /api/img/ + 裸键（键本身以 img/ 开头 → 双 img 段），前端 <img> 直渲染零逻辑
    expect(imageSegment.path).toBe(`${ORIGIN}/api/img/${fakeImageKey(0)}`)
    expect(imageSegment.alt).toBe('图 1')
    // 选项富片段原样（纯文本）
    const options = keyed.options as QuestionOption[]
    expect(options[0]).toEqual({ key: 'A', content: [{ type: 'text', text: '选项 A' }] })

    // 非键形态（源相对路径历史数据）保持原样，防误构造
    const legacyStem = legacy.stem as RichContent
    expect(legacyStem[0]).toEqual({ type: 'text', text: '政治理论历史数据题' })
    expect((legacyStem[1] as Extract<RichSegment, { type: 'image' }>).path).toBe(LEGACY_IMAGE_PATH)
  })

  it('续做回显：已答题挂最近一条记录（同题多条取最新）、answeredCount 去重、未答题 null', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const ids = content.politicalQuestionIds.slice(0, 5)
    const sessionId = await insertSession(userId, 'political_theory', ids)
    await insertRecord(userId, ids[0], sessionId, '2026-01-01T00:00:01.000Z', {
      answer: 'A',
      isCorrect: false,
      durationMs: 5000,
      isTimeout: true,
    })
    await insertRecord(userId, ids[1], sessionId, '2026-01-01T00:00:02.000Z')
    // ids[0] 再插一条更晚的记录：回显须取最近一条
    await insertRecord(userId, ids[0], sessionId, '2026-01-01T00:00:03.000Z', {
      answer: 'C',
      isCorrect: false,
      durationMs: 9000,
    })

    const { status, body } = await requestJson(`/api/practice/sessions/${sessionId}`, bearerGet(token))

    expect(status).toBe(200)
    expect(numberField(body, 'answeredCount')).toBe(2)
    const list = questionList(body)
    expect(list.map((question) => numberField(question, 'id'))).toEqual(ids)
    expect(list[0].answered).toEqual({ answer: 'C', isCorrect: false, isTimeout: false, durationMs: 9000 })
    expect(list[1].answered).toEqual({ answer: 'B', isCorrect: true, isTimeout: false, durationMs: 1234 })
    for (const question of list.slice(2)) {
      expect(question.answered).toBeNull()
    }
  })

  it('会话隔离：他人会话/不存在 id/非数字 id 一律 404 not_found（防存在性探测）', async () => {
    const tokenA = await registerForToken('alice')
    const tokenB = await registerForToken('bob')
    const created = await requestJson('/api/practice/sessions', bearerPost(tokenA, { module: 'political_theory' }))
    expect(created.status).toBe(201)
    const sessionId = numberField(created.body, 'id')

    const foreign = await requestJson(`/api/practice/sessions/${sessionId}`, bearerGet(tokenB))
    expect(foreign.status).toBe(404)
    expect(errorField(foreign.body).code).toBe('not_found')

    const missing = await requestJson('/api/practice/sessions/999999', bearerGet(tokenA))
    expect(missing.status).toBe(404)
    expect(errorField(missing.body).code).toBe('not_found')

    const nonNumeric = await requestJson('/api/practice/sessions/abc', bearerGet(tokenA))
    expect(nonNumeric.status).toBe(404)
    expect(errorField(nonNumeric.body).code).toBe('not_found')
  })
})

describe('GET /api/practice/sessions（活动会话列表）', () => {
  it('只列 in_progress、createdAt 倒序、answeredCount 去重正确、不含他人会话与独立练习记录', async () => {
    const tokenAlice = await registerForToken('alice')
    await registerForToken('bob')
    const aliceId = await userIdOf('alice')
    const bobId = await userIdOf('bob')
    const political = content.politicalQuestionIds
    const common = content.commonQuestionIds

    const older = await insertSession(aliceId, 'political_theory', political.slice(0, 5), {
      createdAt: '2026-10-11T01:00:00.000Z',
    })
    const newer = await insertSession(aliceId, 'common_sense', common, {
      createdAt: '2026-10-11T02:00:00.000Z',
    })
    // finished 会话不入列表；bob 的会话不出现
    await insertSession(aliceId, 'political_theory', political.slice(5, 8), {
      status: 'finished',
      createdAt: '2026-10-11T03:00:00.000Z',
    })
    await insertSession(bobId, 'political_theory', political.slice(0, 2), {
      createdAt: '2026-10-11T04:00:00.000Z',
    })

    // older：2 题去重已答（ids[1] 两条作答 → 去重）；newer：1 题；null 会话的独立练习不计入任何会话
    await insertRecord(aliceId, political[0], older, '2026-10-11T01:10:00.000Z')
    await insertRecord(aliceId, political[1], older, '2026-10-11T01:11:00.000Z')
    await insertRecord(aliceId, political[1], older, '2026-10-11T01:12:00.000Z')
    await insertRecord(aliceId, common[0], newer, '2026-10-11T02:10:00.000Z')
    await insertRecord(aliceId, political[2], null, '2026-10-11T00:30:00.000Z')

    const { status, body } = await requestJson('/api/practice/sessions', bearerGet(tokenAlice))

    expect(status).toBe(200)
    const list = body as unknown as Record<string, unknown>[]
    expect(list.map((row) => numberField(row, 'id'))).toEqual([newer, older])
    expect(list[0]).toEqual({
      id: newer,
      mode: 'module',
      moduleCode: 'common_sense',
      status: 'in_progress',
      total: 2,
      answeredCount: 1,
      createdAt: '2026-10-11T02:00:00.000Z',
    })
    expect(list[1]).toEqual({
      id: older,
      mode: 'module',
      moduleCode: 'political_theory',
      status: 'in_progress',
      total: 5,
      answeredCount: 2,
      createdAt: '2026-10-11T01:00:00.000Z',
    })
  })

  it('无活动会话：200 空数组', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/practice/sessions', bearerGet(token))
    expect(status).toBe(200)
    expect(body).toEqual([])
  })
})

describe('鉴权（三端点）', () => {
  it('缺 token：401 + unauthorized 信封', async () => {
    const outcomes = [
      await requestJson('/api/practice/sessions', postJson({ module: 'political_theory' })),
      await requestJson('/api/practice/sessions', { method: 'GET' }),
      await requestJson('/api/practice/sessions/1', { method: 'GET' }),
    ]
    for (const { status, body } of outcomes) {
      expect(status).toBe(401)
      expect(errorField(body).code).toBe('unauthorized')
    }
  })
})
