import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import type { KnowledgeModuleNode, KnowledgeTopicNode, KnowledgeTreeResponse, XingceModuleCode } from '@ncse/shared'
import { createDb } from '../db'
import { knowledgePoints, modules } from '../db/schema'
import { requireAuth } from '../auth/middleware'
import type { AppEnv } from '../types'

/**
 * 知识点域路由（M3/T3-01a，挂载于 /api/knowledge，见 src/routes/api.ts）：
 * - GET /tree：全量知识点树（模块→考点→知识点三级嵌套，打标前树先入库、掌握度
 *   T3-01d 空态可用——空表返回空数组）。树为全局内容（无用户数据维度）；
 *   模块序 = modules.sort_order，考点/知识点序 = 种子 sort_order + id 并列稳定；
 *   id 为 knowledge_points.id，前端作 mastery_stats 的 target_id 锚点（勿以 code 代替）。
 * 全端点 requireAuth；树数据入库走 importer 种子（XINGCE_KNOWLEDGE_TREE 单一权威，
 * ADR-0013），本域无写入端点。
 */

export const knowledgeRoute = new Hono<AppEnv>()

// 树虽为全局静态内容，仍与 papers 目录同口径一律经 requireAuth（401 由组合根收敛为信封）
knowledgeRoute.use(requireAuth)

knowledgeRoute.get('/tree', async (c) => {
  const db = createDb(c.env)

  const rows = await db
    .select({
      moduleId: modules.id,
      moduleCode: modules.code,
      moduleName: modules.name,
      pointId: knowledgePoints.id,
      parentId: knowledgePoints.parentId,
      pointCode: knowledgePoints.code,
      pointName: knowledgePoints.name,
      pointSort: knowledgePoints.sortOrder,
    })
    .from(knowledgePoints)
    .innerJoin(modules, eq(modules.id, knowledgePoints.moduleId))
    .orderBy(asc(modules.sortOrder), asc(knowledgePoints.sortOrder), asc(knowledgePoints.id))

  // 两遍装配：先考点（parent NULL）后知识点（挂 topicById），悬空父行防御式跳过
  // （种子语义下不出现，防御性保留与错题本/收藏列表同风格）
  const moduleById = new Map<
    number,
    KnowledgeModuleNode & { topicById: Map<number, KnowledgeTopicNode> }
  >()
  for (const row of rows) {
    if (row.parentId !== null) continue
    let entry = moduleById.get(row.moduleId)
    if (entry === undefined) {
      entry = {
        // modules.code 为行测六模块稳定 code（种子侧 XingceModuleCode 同源，断言约定同 practice/stats 域）
        module: row.moduleCode as XingceModuleCode,
        moduleName: row.moduleName,
        topics: [],
        topicById: new Map(),
      }
      moduleById.set(row.moduleId, entry)
    }
    const topic: KnowledgeTopicNode = { id: row.pointId, code: row.pointCode, name: row.pointName, points: [] }
    entry.topics.push(topic)
    entry.topicById.set(row.pointId, topic)
  }
  for (const row of rows) {
    if (row.parentId === null) continue
    const entry = moduleById.get(row.moduleId)
    const topic = entry?.topicById.get(row.parentId)
    if (topic === undefined) continue
    topic.points.push({ id: row.pointId, code: row.pointCode, name: row.pointName })
  }

  const body: KnowledgeTreeResponse = [...moduleById.values()].map(({ module, moduleName, topics }) => ({
    module,
    moduleName,
    topics,
  }))
  return c.json(body, 200)
})
