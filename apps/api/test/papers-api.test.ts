import { beforeEach, describe, expect, it } from 'vitest'
import { papers, users } from '../src/db/schema'
import { bearerGet, errorField, registerForToken, requestJson } from './api-helpers'
import { db } from './practice-fixtures'
import { insertPaperRow } from './mock-fixtures'

/**
 * 试卷目录 API 集成测试（T2-01b，GET /api/papers）：经 worker 入口走真实 fetch，
 * D1 为 workerd 内本地实例。papers 无外键，卷行直插即可（不需要内容链）。
 * 排序口径：year DESC（SQLite NULL 视为最小 → 未标定年份排最后）→ questionCount DESC → name ASC；
 * completeness 三档由 shared classifyPaperCompleteness 派生（阈值边界断言见 packages/shared/test/mock.test.ts）。
 */

beforeEach(async () => {
  // papers 行级联清 question_papers；users 与试卷无外键，清理只为用例独立
  await db.delete(users)
  await db.delete(papers)
})

describe('GET /api/papers（全量卷目录）', () => {
  it('未认证：401 + unauthorized 信封', async () => {
    const { status, body } = await requestJson('/api/papers', { method: 'GET' })
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })

  it('空库：200 空数组（直返不包壳）', async () => {
    const token = await registerForToken('alice')
    const { status, body } = await requestJson('/api/papers', bearerGet(token))
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('字段精确：三卷各覆盖 completeness 三档（110 full / 30 partial / 29 fragment）', async () => {
    const token = await registerForToken('alice')
    await insertPaperRow('2024年国考副省级《行测》卷（目录测试甲）', {
      year: 2024,
      region: 'national',
      paperType: '副省级',
      questionCount: 110,
    })
    await insertPaperRow('2023年虚构省省考《行测》卷（单模块分卷）', {
      year: 2023,
      region: 'fictionland',
      paperType: '省考',
      questionCount: 30,
    })
    await insertPaperRow('2022年残卷（目录测试丙）', {
      year: null,
      region: null,
      paperType: null,
      questionCount: 29,
    })

    const { status, body } = await requestJson('/api/papers', bearerGet(token))
    expect(status).toBe(200)
    const list = body as unknown as Record<string, unknown>[]
    expect(list).toHaveLength(3)

    // 直查库取各卷 id，响应对象逐字段精确断言（含 null 字段显式下发）
    const rows = await db.select({ id: papers.id, name: papers.name }).from(papers)
    const idOf = (name: string): number => {
      const row = rows.find((entry) => entry.name === name)
      if (row === undefined) throw new Error(`未找到卷 ${name}`)
      return row.id
    }
    expect(list).toEqual([
      {
        id: idOf('2024年国考副省级《行测》卷（目录测试甲）'),
        name: '2024年国考副省级《行测》卷（目录测试甲）',
        year: 2024,
        region: 'national',
        paperType: '副省级',
        questionCount: 110,
        completeness: 'full',
      },
      {
        id: idOf('2023年虚构省省考《行测》卷（单模块分卷）'),
        name: '2023年虚构省省考《行测》卷（单模块分卷）',
        year: 2023,
        region: 'fictionland',
        paperType: '省考',
        questionCount: 30,
        completeness: 'partial',
      },
      {
        id: idOf('2022年残卷（目录测试丙）'),
        name: '2022年残卷（目录测试丙）',
        year: null,
        region: null,
        paperType: null,
        questionCount: 29,
        completeness: 'fragment',
      },
    ])
  })

  it('排序：year DESC 未标定最后 → 同年 questionCount DESC → 并列 name ASC', async () => {
    const token = await registerForToken('alice')
    await insertPaperRow('d-2026卷', { year: 2026, questionCount: 30 })
    await insertPaperRow('a-2025多题卷', { year: 2025, questionCount: 130 })
    await insertPaperRow('c-2025少题卷', { year: 2025, questionCount: 100 })
    await insertPaperRow('b-2025少题卷', { year: 2025, questionCount: 100 })
    await insertPaperRow('z-未标定卷', { year: null, questionCount: 135 })

    const { status, body } = await requestJson('/api/papers', bearerGet(token))
    expect(status).toBe(200)
    const list = body as unknown as { name: string }[]
    expect(list.map((row) => row.name)).toEqual([
      'd-2026卷',
      'a-2025多题卷',
      'b-2025少题卷',
      'c-2025少题卷',
      'z-未标定卷',
    ])
  })
})
