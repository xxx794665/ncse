import { beforeEach, describe, expect, it } from 'vitest'
import { STATS_TREND_DAYS } from '@ncse/shared'
import { examTypes, users } from '../src/db/schema'
import { bearerGet, errorField, numberField, registerForToken, requestJson, stringField } from './api-helpers'
import { db, insertContentFixture, insertRecord, userIdOf, type ContentFixture } from './practice-fixtures'
import { STATS_TIMEZONE_OFFSET_HOURS } from '../src/routes/stats'

/**
 * 统计汇总 API 集成测试（T1-11a）：GET /api/stats/summary 经 worker 真实入口。
 * 覆盖：401、新用户空数据（daily 恰 30 项全零、末项 = 北京时间今日）、overall/modules 聚合精确断言、
 * 北京时间日界（16:00 UTC 前后分归两日）、窗口外记录（计入 overall 不入 daily）、零填空、多用户隔离。
 * 日界相关夹具日期按运行时北京时间今日推算（与路由共用同一偏移常量，单一来源）；
 * 边界用例围绕 D-2 的北京午夜（两侧分归 D-2/D-1，均远离今日），规避测试执行跨北京午夜的竞态。
 */

let content: ContentFixture

beforeEach(async () => {
  // 清空 users（级联清 practice_records）与 exam_types（级联清内容域链条），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
  content = await insertContentFixture()
})

/** 北京时间「今日」日期串（'YYYY-MM-DD'）：Date.now() 加偏移后取 ISO 日期，与路由同一偏移常量 */
function beijingToday(): string {
  return new Date(Date.now() + STATS_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 北京时间今日往前 n 天的日期串（UTC 毫秒退算纯日期，与时区无关） */
function beijingDaysAgo(n: number, today: string): string {
  return new Date(Date.parse(`${today}T00:00:00.000Z`) - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 从响应体取嵌套对象字段（形状不符先失败给出可读信息，风格同 api-helpers 的叶子助手） */
function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key]
  expect(typeof value).toBe('object')
  expect(value).not.toBeNull()
  return value as Record<string, unknown>
}

/** 从响应体取数组字段（同上） */
function arrayField(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = body[key]
  expect(Array.isArray(value)).toBe(true)
  return value as Record<string, unknown>[]
}

/** 取 summary 响应（200 断言内聚；后续用例只关心三段形状的断言值） */
async function fetchSummary(token: string): Promise<{
  overall: Record<string, unknown>
  modules: Record<string, unknown>[]
  daily: Record<string, unknown>[]
}> {
  const { status, body } = await requestJson('/api/stats/summary', bearerGet(token))
  expect(status).toBe(200)
  return { overall: objectField(body, 'overall'), modules: arrayField(body, 'modules'), daily: arrayField(body, 'daily') }
}

/** 按日期取 daily 项（缺失时先失败给出可读信息，避免后续 as 断言静默通过） */
function dailyEntry(daily: Record<string, unknown>[], date: string): Record<string, unknown> {
  const entry = daily.find((row) => stringField(row, 'date') === date)
  expect(entry, `daily 缺日期 ${date}`).toBeDefined()
  return entry as Record<string, unknown>
}

describe('GET /api/stats/summary', () => {
  it('缺 token：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson('/api/stats/summary', { method: 'GET' })
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })

  it('新用户空数据：overall 四零、modules 空数组、daily 恰 30 项全零、末项日期 = 北京时间今日', async () => {
    const token = await registerForToken('alice')
    const { overall, modules, daily } = await fetchSummary(token)
    expect(overall).toEqual({ answered: 0, correct: 0, totalDurationMs: 0, timeoutCount: 0 })
    expect(modules).toEqual([])
    expect(daily).toHaveLength(STATS_TREND_DAYS)
    // 末项 = 北京时间今日（响应已返回后再取今日，与路由计算至多差一次跨午夜竞态，概率可忽略）
    expect(stringField(daily[daily.length - 1], 'date')).toBe(beijingToday())
    for (const day of daily) {
      expect(numberField(day, 'answered')).toBe(0)
      expect(numberField(day, 'correct')).toBe(0)
    }
  })

  it('overall 聚合：多条记录（含答对/答错/超时/不同用时）精确断言各总数', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    // 5 条：3 对 2 错、2 条超时、用时合计 15000；落 D-2 北京正午（overall 全历史，日期无窗口依赖）
    const day = `${beijingDaysAgo(2, beijingToday())}T04:00:00.000Z`
    const [q1, q2, q3, q4, q5] = content.politicalQuestionIds.slice(0, 5)
    await insertRecord(userId, q1, null, day, { isCorrect: true, durationMs: 1000 })
    await insertRecord(userId, q2, null, day, { isCorrect: false, durationMs: 2000, isTimeout: true })
    await insertRecord(userId, q3, null, day, { isCorrect: true, durationMs: 3000 })
    await insertRecord(userId, q4, null, day, { isCorrect: false, durationMs: 4000 })
    await insertRecord(userId, q5, null, day, { isCorrect: true, durationMs: 5000, isTimeout: true })

    const { overall } = await fetchSummary(token)
    expect(overall).toEqual({ answered: 5, correct: 3, totalDurationMs: 15000, timeoutCount: 2 })
  })

  it('modules 聚合：跨两模块恰两行、moduleCode 升序、各模块计数正确；无记录模块（judgement）不出现', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const day = `${beijingDaysAgo(2, beijingToday())}T04:00:00.000Z`
    // political_theory 3 条：2 对 1 错、1 超时、合计 6000ms
    const [p1, p2, p3] = content.politicalQuestionIds.slice(0, 3)
    await insertRecord(userId, p1, null, day, { isCorrect: true, durationMs: 1000 })
    await insertRecord(userId, p2, null, day, { isCorrect: false, durationMs: 2000, isTimeout: true })
    await insertRecord(userId, p3, null, day, { isCorrect: true, durationMs: 3000 })
    // common_sense 1 条：答错超时
    await insertRecord(userId, content.commonQuestionIds[0], null, day, {
      isCorrect: false,
      durationMs: 5000,
      isTimeout: true,
    })

    const { modules } = await fetchSummary(token)
    // 升序：common_sense < political_theory；judgement 有题但无作答记录 → 不出现
    expect(modules.map((row) => stringField(row, 'moduleCode'))).toEqual(['common_sense', 'political_theory'])
    expect(modules[0]).toEqual({
      moduleCode: 'common_sense',
      answered: 1,
      correct: 0,
      totalDurationMs: 5000,
      timeoutCount: 1,
    })
    expect(modules[1]).toEqual({
      moduleCode: 'political_theory',
      answered: 3,
      correct: 2,
      totalDurationMs: 6000,
      timeoutCount: 1,
    })
  })

  it('北京时间日界：UTC 15:59（北京 23:59）与 UTC 16:30（北京次日 00:30）分归两日', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const today = beijingToday()
    const [q1, q2] = content.politicalQuestionIds.slice(0, 2)
    // 边界取 D-2 的北京午夜（UTC 16:00），两条记录分置两侧、均远离今日规避跨午夜竞态：
    // D-2 15:59:00Z = 北京 D-2 23:59 → 归 D-2 日；D-2 16:30:00Z = 北京 D-1 00:30 → 归 D-1 日
    //（16:30 + 8h 跨入次日凌晨，D-2 的次一日是 D-1）
    await insertRecord(userId, q1, null, `${beijingDaysAgo(2, today)}T15:59:00.000Z`, { isCorrect: true })
    await insertRecord(userId, q2, null, `${beijingDaysAgo(2, today)}T16:30:00.000Z`, { isCorrect: false })

    const { daily } = await fetchSummary(token)
    expect(daily).toHaveLength(STATS_TREND_DAYS)
    expect(dailyEntry(daily, beijingDaysAgo(2, today))).toEqual({ date: beijingDaysAgo(2, today), answered: 1, correct: 1 })
    expect(dailyEntry(daily, beijingDaysAgo(1, today))).toEqual({ date: beijingDaysAgo(1, today), answered: 1, correct: 0 })
  })

  it('窗口外：31 天前（北京时间）记录不入 daily（长度仍 30）但计入 overall', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const today = beijingToday()
    // 北京时间 D-31 正午（UTC D-31 04:00）：窗口 [D-29, D] 之外
    await insertRecord(userId, content.politicalQuestionIds[0], null, `${beijingDaysAgo(31, today)}T04:00:00.000Z`, {
      isCorrect: true,
      durationMs: 4321,
    })

    const { overall, daily } = await fetchSummary(token)
    // 计入 overall 全历史聚合
    expect(overall).toEqual({ answered: 1, correct: 1, totalDurationMs: 4321, timeoutCount: 0 })
    // 不入 daily：30 项全零（窗口外日期本就不在骨架内）
    expect(daily).toHaveLength(STATS_TREND_DAYS)
    for (const day of daily) {
      expect(numberField(day, 'answered')).toBe(0)
      expect(numberField(day, 'correct')).toBe(0)
    }
  })

  it('零填空：仅有记录的天有计数、其余天全零；日期序列升序连续（最旧在前今日在末）', async () => {
    const token = await registerForToken('alice')
    const userId = await userIdOf('alice')
    const today = beijingToday()
    const [q1, q2] = content.politicalQuestionIds.slice(0, 2)
    // D-5 两条（1 对 1 错）
    await insertRecord(userId, q1, null, `${beijingDaysAgo(5, today)}T04:00:00.000Z`, { isCorrect: true })
    await insertRecord(userId, q2, null, `${beijingDaysAgo(5, today)}T05:00:00.000Z`, { isCorrect: false })

    const { daily } = await fetchSummary(token)
    // 完整日期骨架 = 今日往前 29 天到今日、升序
    const expectedDates: string[] = []
    for (let i = STATS_TREND_DAYS - 1; i >= 0; i--) {
      expectedDates.push(beijingDaysAgo(i, today))
    }
    expect(daily.map((row) => stringField(row, 'date'))).toEqual(expectedDates)
    for (const row of daily) {
      const isRecordDay = stringField(row, 'date') === beijingDaysAgo(5, today)
      expect(numberField(row, 'answered')).toBe(isRecordDay ? 2 : 0)
      expect(numberField(row, 'correct')).toBe(isRecordDay ? 1 : 0)
    }
  })

  it('多用户隔离：他人记录不出现在当前用户汇总', async () => {
    const tokenAlice = await registerForToken('alice')
    const tokenBob = await registerForToken('bob')
    const aliceId = await userIdOf('alice')
    const bobId = await userIdOf('bob')
    const day = `${beijingDaysAgo(2, beijingToday())}T04:00:00.000Z`
    // alice 1 条 political_theory；bob 2 条（political/common 各一）——bob 的记录不得进 alice 汇总
    await insertRecord(aliceId, content.politicalQuestionIds[0], null, day, { isCorrect: true, durationMs: 1000 })
    await insertRecord(bobId, content.politicalQuestionIds[1], null, day, {
      isCorrect: false,
      durationMs: 2000,
      isTimeout: true,
    })
    await insertRecord(bobId, content.commonQuestionIds[0], null, day, { isCorrect: false, durationMs: 3000 })

    const aliceSummary = await fetchSummary(tokenAlice)
    expect(aliceSummary.overall).toEqual({ answered: 1, correct: 1, totalDurationMs: 1000, timeoutCount: 0 })
    expect(aliceSummary.modules.map((row) => stringField(row, 'moduleCode'))).toEqual(['political_theory'])

    const bobSummary = await fetchSummary(tokenBob)
    expect(bobSummary.overall).toEqual({ answered: 2, correct: 0, totalDurationMs: 5000, timeoutCount: 1 })
  })
})
