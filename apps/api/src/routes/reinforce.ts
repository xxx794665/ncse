import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { and, desc, eq } from 'drizzle-orm'
import type { ReinforceEntrySummary, XingceModuleCode } from '@ncse/shared'
import { createDb } from '../db'
import { modules, questions, reinforceQueue } from '../db/schema'
import { requireAuth } from '../auth/middleware'
import { buildStemPreview } from './stem-preview'
import type { AppEnv } from '../types'

/**
 * 需加强清单域路由（T3-01e，挂载于 /api/reinforce，见 src/routes/api.ts）：
 * - GET /：强化队列列表（?status=pending|resolved，缺省 pending，白名单外 400），
 *   join questions（悬空题行整条跳过）+ modules 取 code，updatedAt 倒序、id 倒序并列稳定；
 *   DTO 直返不包壳。
 * 全自动队列（与错题本并存：无任何用户处置动作——汇入/出队由判分联动，口径与理由见
 * reinforce-machine.ts 文件头）；建强化会话走 POST /api/practice/sessions 的 reinforce 分支。
 * 全端点 requireAuth；业务错误一律抛 HTTPException（中文 message），
 * 由组合根 onError 统一收敛为 ApiErrorBody（沿用既有错误码，不新增）。
 */

/** 列表可查状态白名单（与 shared ReinforceStatus 两态对齐，两端勿单方扩值） */
const LISTABLE_STATUSES: readonly ('pending' | 'resolved')[] = ['pending', 'resolved']

/** status 查询参数收窄：是否为两态之一（pending/resolved） */
function isListableStatus(value: string): value is 'pending' | 'resolved' {
  return (LISTABLE_STATUSES as readonly string[]).includes(value)
}

export const reinforceRoute = new Hono<AppEnv>()

// 本域无公开端点：列表一律经 requireAuth（401 由组合根收敛为 unauthorized 信封）
reinforceRoute.use(requireAuth)

reinforceRoute.get('/', async (c) => {
  // status 缺省 pending；仅容 pending/resolved（其余 400，照 wrong-book 列表同文案风格）
  const statusParam = c.req.query('status') ?? 'pending'
  if (!isListableStatus(statusParam)) {
    throw new HTTPException(400, { message: `status 必须是 ${LISTABLE_STATUSES.join(' 或 ')}（字符串）` })
  }

  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // inner join：题目行悬空（内容重删的罕见态）整条跳过；模块行随题目级联删除，同理由跳过
  //（照 wrong-book 列表口径，join 跳过与库层 CASCADE 任一生效，断言口径一致）
  const rows = await db
    .select({
      questionId: reinforceQueue.questionId,
      reason: reinforceQueue.reason,
      status: reinforceQueue.status,
      updatedAt: reinforceQueue.updatedAt,
      stem: questions.stem,
      moduleCode: modules.code,
    })
    .from(reinforceQueue)
    .innerJoin(questions, eq(questions.id, reinforceQueue.questionId))
    .innerJoin(modules, eq(modules.id, questions.moduleId))
    .where(and(eq(reinforceQueue.userId, authUser.id), eq(reinforceQueue.status, statusParam)))
    // updatedAt 倒序（最近汇入在前）；id 倒序兜底：同毫秒行保持稳定序
    .orderBy(desc(reinforceQueue.updatedAt), desc(reinforceQueue.id))

  const body: ReinforceEntrySummary[] = rows.map((row) => ({
    questionId: row.questionId,
    // modules.code 库层为无域类型的 TEXT（M1 内容域即行测模块编码），读取处按域值断言
    //（与 practice_sessions.moduleCode 的 $type<XingceModuleCode> 同一约定，见 wrong-book.ts）
    moduleCode: row.moduleCode as XingceModuleCode,
    stemPreview: buildStemPreview(row.stem),
    reason: row.reason,
    status: row.status,
    updatedAt: row.updatedAt,
  }))
  return c.json(body, 200)
})
