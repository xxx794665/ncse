import { beforeEach, describe, expect, it } from 'vitest'
import { examTypes, knowledgePoints, modules, subjects, users } from '../src/db/schema'
import { bearerGet, errorField, registerForToken, requestJson } from './api-helpers'
import { db } from './practice-fixtures'

/**
 * 知识点树 API 集成测试（M3/T3-01a）：GET /api/knowledge/tree 经 worker 真实入口。
 * 覆盖：401、空表空数组（打标前掌握度空态可用）、种子后三级嵌套结构与排序
 * （模块序 = modules.sort_order、节点序 = sort_order + id 并列稳定）。
 * 悬空父行不可测：parent_id 为真实 FK，数据库层面不可能悬空（路由防御式跳过仅兜底）。
 * 树为全局内容无用户数据维度；夹具全部合成虚构（ADR-0004）。
 */

beforeEach(async () => {
  // 清空 users 与 exam_types（级联清掉内容域链条含 knowledge_points），用例互不依赖
  await db.delete(users)
  await db.delete(examTypes)
})

/** 造两模块知识点树夹具（verbal sort 3 先于 judgement sort 5；悬空父行一并预插） */
async function seedKnowledgeTree(): Promise<void> {
  const examTypeRows = await db
    .insert(examTypes)
    .values({ code: 'civil_service', name: '公务员' })
    .returning({ id: examTypes.id })
  const examTypeId = examTypeRows.at(0)?.id
  if (examTypeId === undefined) throw new Error('exam_types 插入未返回 id')
  const subjectRows = await db
    .insert(subjects)
    .values({ examTypeId, code: 'xingce', name: '行测' })
    .returning({ id: subjects.id })
  const subjectId = subjectRows.at(0)?.id
  if (subjectId === undefined) throw new Error('subjects 插入未返回 id')
  const moduleRows = await db
    .insert(modules)
    .values([
      { subjectId, code: 'verbal', name: '言语理解与表达', sortOrder: 3 },
      { subjectId, code: 'judgement', name: '判断推理', sortOrder: 5 },
    ])
    .returning({ id: modules.id, code: modules.code })

  const topicRows = await db
    .insert(knowledgePoints)
    .values([
      { moduleId: moduleRows[0].id, parentId: null, code: 'fixture-topic-a', name: '虚构考点甲', sortOrder: 1 },
      { moduleId: moduleRows[0].id, parentId: null, code: 'fixture-topic-b', name: '虚构考点乙', sortOrder: 2 },
      { moduleId: moduleRows[1].id, parentId: null, code: 'fixture-topic-c', name: '虚构考点丙', sortOrder: 1 },
    ])
    .returning({ id: knowledgePoints.id, code: knowledgePoints.code })
  const topicA = topicRows.find((row) => row.code === 'fixture-topic-a')?.id
  const topicB = topicRows.find((row) => row.code === 'fixture-topic-b')?.id
  const topicC = topicRows.find((row) => row.code === 'fixture-topic-c')?.id
  if (topicA === undefined || topicB === undefined || topicC === undefined) {
    throw new Error('考点插入未返回 id')
  }
  await db.insert(knowledgePoints).values([
    { moduleId: moduleRows[0].id, parentId: topicA, code: 'fixture-topic-a.p1', name: '虚构知识点一', sortOrder: 1 },
    { moduleId: moduleRows[0].id, parentId: topicA, code: 'fixture-topic-a.p2', name: '虚构知识点二', sortOrder: 2 },
    { moduleId: moduleRows[0].id, parentId: topicB, code: 'fixture-topic-b.p1', name: '虚构知识点三', sortOrder: 1 },
    { moduleId: moduleRows[1].id, parentId: topicC, code: 'fixture-topic-c.p1', name: '虚构知识点四', sortOrder: 1 },
  ])
}

describe('GET /api/knowledge/tree（M3/T3-01a）', () => {
  it('无 token 401（unauthorized 信封）', async () => {
    const { status, body } = await requestJson('/api/knowledge/tree')
    expect(status).toBe(401)
    expect(errorField(body).code).toBe('unauthorized')
  })

  it('空表 200 返回空数组（打标前掌握度空态可用）', async () => {
    const token = await registerForToken('kp_tree_empty')
    const { status, body } = await requestJson('/api/knowledge/tree', bearerGet(token))
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('种子后三级嵌套：模块序按 sort_order、考点/知识点嵌套与序正确、id 为正整数', async () => {
    await seedKnowledgeTree()
    const token = await registerForToken('kp_tree_seeded')
    const { status, body } = await requestJson('/api/knowledge/tree', bearerGet(token))
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const tree = body as unknown as Array<Record<string, unknown>>

    // 模块序 = modules.sort_order（verbal 3 先于 judgement 5）
    expect(tree).toHaveLength(2)
    expect(tree[0]).toMatchObject({ module: 'verbal', moduleName: '言语理解与表达' })
    expect(tree[1]).toMatchObject({ module: 'judgement', moduleName: '判断推理' })

    // 考点嵌套与序（verbal 两考点按 sort_order）
    const verbalTopics = tree[0].topics as Array<Record<string, unknown>>
    expect(verbalTopics).toHaveLength(2)
    expect(verbalTopics[0]).toMatchObject({ code: 'fixture-topic-a', name: '虚构考点甲' })
    expect(verbalTopics[1]).toMatchObject({ code: 'fixture-topic-b', name: '虚构考点乙' })

    // 知识点嵌套与序（考点甲两点按 sort_order；id 为 knowledge_points.id 正整数）
    const topicAPoints = verbalTopics[0].points as Array<Record<string, unknown>>
    expect(topicAPoints.map((point) => point.code)).toEqual(['fixture-topic-a.p1', 'fixture-topic-a.p2'])
    // id 为 knowledge_points.id 正整数（考点与知识点节点；模块节点无 id 属 DTO 设计）
    for (const node of [verbalTopics[0], verbalTopics[1], topicAPoints[0]] as Array<Record<string, unknown>>) {
      expect(typeof node.id).toBe('number')
      expect(node.id as number).toBeGreaterThan(0)
    }

    // judgement 仅考点丙一点
    const judgementTopics = tree[1].topics as Array<Record<string, unknown>>
    expect(judgementTopics).toHaveLength(1)
    expect(judgementTopics[0]).toMatchObject({ code: 'fixture-topic-c' })
    const topicCPoints = judgementTopics[0].points as unknown as Array<Record<string, unknown>>
    expect(topicCPoints).toHaveLength(1)
  })
})
