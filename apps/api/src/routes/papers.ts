import { Hono } from 'hono'
import { asc, desc } from 'drizzle-orm'
import { classifyPaperCompleteness, type PaperSummary } from '@ncse/shared'
import { createDb } from '../db'
import { papers } from '../db/schema'
import { requireAuth } from '../auth/middleware'
import type { AppEnv } from '../types'

/**
 * 试卷目录域路由（T2-01b，挂载于 /api/papers，见 src/routes/api.ts）：
 * - GET /：全量卷目录（D2：全部卷开放并标注完整度，自用 515 卷规模一次下发不分页），
 *   completeness 由 shared classifyPaperCompleteness(questionCount) 派生——前后端同一口径；
 *   「完整卷置顶推荐」由前端二次排，后端不掺推荐逻辑。
 * 全端点 requireAuth；业务错误一律抛 HTTPException（中文 message），
 * 由组合根 onError 统一收敛为 ApiErrorBody（沿用既有错误码，不新增）。
 */

export const papersRoute = new Hono<AppEnv>()

// 本域无公开端点：目录读取一律经 requireAuth（401 由组合根收敛为 unauthorized 信封）
papersRoute.use(requireAuth)

papersRoute.get('/', async (c) => {
  const db = createDb(c.env)

  // 排序稳定：year DESC → questionCount DESC → name ASC。
  // SQLite NULL 视为最小值，DESC 恰把未标定年份排到最后，无需额外 NULLS LAST 表达式（D1/SQLite 语义，勿换 ASC）。
  const rows = await db
    .select()
    .from(papers)
    .orderBy(desc(papers.year), desc(papers.questionCount), asc(papers.name))

  const body: PaperSummary[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    year: row.year,
    region: row.region,
    paperType: row.paperType,
    questionCount: row.questionCount,
    completeness: classifyPaperCompleteness(row.questionCount),
  }))
  return c.json(body, 200)
})
