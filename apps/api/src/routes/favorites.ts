import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { and, desc, eq } from 'drizzle-orm'
import type { FavoriteSummary, FavoriteToggleResponse, XingceModuleCode } from '@ncse/shared'
import { createDb } from '../db'
import { favorites, modules, questions } from '../db/schema'
import { requireAuth } from '../auth/middleware'
import { buildStemPreview } from './stem-preview'
import type { AppEnv } from '../types'

/**
 * 收藏域路由（T1-10a，挂载于 /api/favorites，见 src/routes/api.ts）：
 * - GET /：当前用户收藏列表，join questions（悬空题行整条跳过）+ modules 取 code，
 *   createdAt 倒序（最近收藏在前）、id 倒序并列稳定；stemPreview 与错题本列表共用
 *   src/routes/stem-preview.ts（勿复制两份）；
 * - POST /:questionId：收藏（幂等——唯一冲突经 onConflictDoNothing 吸收，恒 200）；
 * - DELETE /:questionId：取消收藏（幂等删行，行在或不在恒 200；用户自身数据无存在性探测面）。
 * 全端点 requireAuth；业务错误一律抛 HTTPException（中文 message），
 * 由组合根 onError 统一收敛为 ApiErrorBody（沿用既有错误码，不新增）。
 */

/** 题目 404 文案：与 practice 域判分 404 同句照抄（防存在性探测，不区分原因） */
const QUESTION_NOT_FOUND_MESSAGE = '题目不存在'

export const favoritesRoute = new Hono<AppEnv>()

// 本域无公开端点：三端点一律经 requireAuth（401 由组合根收敛为 unauthorized 信封）
favoritesRoute.use(requireAuth)

favoritesRoute.get('/', async (c) => {
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // inner join：题目行悬空（内容重删的罕见态）整条跳过；模块行随题目级联删除，同理由跳过
  const rows = await db
    .select({
      questionId: favorites.questionId,
      stem: questions.stem,
      moduleCode: modules.code,
      favoritedAt: favorites.createdAt,
    })
    .from(favorites)
    .innerJoin(questions, eq(questions.id, favorites.questionId))
    .innerJoin(modules, eq(modules.id, questions.moduleId))
    .where(eq(favorites.userId, authUser.id))
    // createdAt 倒序（最近收藏在前）；id 倒序兜底：同毫秒行保持稳定序
    .orderBy(desc(favorites.createdAt), desc(favorites.id))

  const body: FavoriteSummary[] = rows.map((row) => ({
    questionId: row.questionId,
    // modules.code 库层为无域类型的 TEXT（M1 内容域即行测模块编码），读取处按域值断言
    //（与 practice_sessions.moduleCode 的 $type<XingceModuleCode> 同一约定）
    moduleCode: row.moduleCode as XingceModuleCode,
    stemPreview: buildStemPreview(row.stem),
    favoritedAt: row.favoritedAt,
  }))
  return c.json(body, 200)
})

favoritesRoute.post('/:questionId', async (c) => {
  // 非数字 id 一律 404（与「不存在」同文案，不区分原因）
  const questionIdParam = c.req.param('questionId')
  if (!/^\d+$/.test(questionIdParam)) {
    throw new HTTPException(404, { message: QUESTION_NOT_FOUND_MESSAGE })
  }
  const questionId = Number(questionIdParam)

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 题目行存在性：不存在 → 404（与 practice 域判分 404 同文案，防收藏端点探测题库存在性）
  const questionRows = await db.select({ id: questions.id }).from(questions).where(eq(questions.id, questionId))
  if (questionRows.length === 0) {
    throw new HTTPException(404, { message: QUESTION_NOT_FOUND_MESSAGE })
  }

  // 幂等收藏：唯一冲突经 onConflictDoNothing 吸收（已收藏与新建同回 200，不区分、不报 409）
  await db
    .insert(favorites)
    .values({ userId: authUser.id, questionId })
    .onConflictDoNothing({ target: [favorites.userId, favorites.questionId] })

  const responseBody: FavoriteToggleResponse = { questionId, favorited: true }
  return c.json(responseBody, 200)
})

favoritesRoute.delete('/:questionId', async (c) => {
  // 非数字 id 一律 404（与 POST 同文案；DELETE 仅此一种 404，行不在恒 200）
  const questionIdParam = c.req.param('questionId')
  if (!/^\d+$/.test(questionIdParam)) {
    throw new HTTPException(404, { message: QUESTION_NOT_FOUND_MESSAGE })
  }
  const questionId = Number(questionIdParam)

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 幂等删行：归属条件并入 where（他人行不可达），行在删 1 行、行不在删 0 行，均恒 200
  await db.delete(favorites).where(and(eq(favorites.userId, authUser.id), eq(favorites.questionId, questionId)))

  const responseBody: FavoriteToggleResponse = { questionId, favorited: false }
  return c.json(responseBody, 200)
})
