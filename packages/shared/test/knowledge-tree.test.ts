/**
 * 知识点树单测（M3/T3-01a，ADR-0013）：目录完整性与节点计数、validateKnowledgeTree 逐类违规捕获。
 * 从 '../src/index.js' 导入，同时验证 index.ts 的再导出接线。纯函数，无网络/文件系统/凭据。
 */
import { describe, expect, it } from 'vitest'
import type { ModuleKnowledgeTree } from '../src/index.js'
import { XINGCE_KNOWLEDGE_TREE, validateKnowledgeTree } from '../src/index.js'

/** 合法树克隆基座（单模块单考点单知识点；违规用例在其上定向破坏一个维度） */
function makeTree(): ModuleKnowledgeTree[] {
  return XINGCE_KNOWLEDGE_TREE.map((entry) => ({
    module: entry.module,
    topics: entry.topics.map((topic) => ({
      code: topic.code,
      name: topic.name,
      points: topic.points.map((point) => ({ code: point.code, name: point.name })),
    })),
  }))
}

describe('目录完整性与计数', () => {
  it('XINGCE_KNOWLEDGE_TREE validateKnowledgeTree 通过（空问题清单）', () => {
    expect(validateKnowledgeTree(XINGCE_KNOWLEDGE_TREE)).toEqual([])
  })

  it('节点总数 137 = 36 考点 + 101 知识点；六模块各一条', () => {
    expect(XINGCE_KNOWLEDGE_TREE).toHaveLength(6)
    const topics = XINGCE_KNOWLEDGE_TREE.reduce((sum, entry) => sum + entry.topics.length, 0)
    const points = XINGCE_KNOWLEDGE_TREE.reduce(
      (sum, entry) => sum + entry.topics.reduce((topicSum, topic) => topicSum + topic.points.length, 0),
      0,
    )
    expect(topics).toBe(36)
    expect(points).toBe(101)
    expect(topics + points).toBe(137)
    // 模块 code 无重复（全集断言由 validateKnowledgeTree 的缺失分支兜底）
    const moduleCodes = XINGCE_KNOWLEDGE_TREE.map((entry) => entry.module)
    expect(new Set(moduleCodes).size).toBe(moduleCodes.length)
  })

  it('合法克隆树亦通过（序不限：打乱模块序仍空问题清单）', () => {
    const tree = makeTree()
    tree.reverse()
    expect(validateKnowledgeTree(tree)).toEqual([])
  })
})

describe('validateKnowledgeTree 逐类违规捕获', () => {
  it('模块缺失 / 模块重复', () => {
    const missing = makeTree().slice(0, 5)
    expect(validateKnowledgeTree(missing)).toEqual(['模块缺失：data_analysis'])

    const duplicated = makeTree()
    duplicated.push({ module: 'verbal', topics: [] })
    const problems = validateKnowledgeTree(duplicated)
    expect(problems).toContain('模块重复：verbal')
    expect(problems).toHaveLength(1) // 六模块均在，无缺失
  })

  it('code 重复：考点与知识点同一命名空间（跨层级同报）', () => {
    const tree = makeTree()
    const verbal = tree.find((entry) => entry.module === 'verbal')
    if (verbal === undefined) throw new Error('克隆树应含 verbal 模块')
    // 跨层级：知识点 code 与既有考点 code 相同
    verbal.topics[0].points.push({ code: verbal.topics[1].code, name: '与考点撞码的知识点' })
    expect(validateKnowledgeTree(tree)).toContain(
      `verbal code 重复（考点与知识点同一命名空间）：${verbal.topics[1].code}`,
    )
  })

  it('知识点 code 前缀与所属考点不符', () => {
    const tree = makeTree()
    const quantitative = tree.find((entry) => entry.module === 'quantitative')
    if (quantitative === undefined) throw new Error('克隆树应含 quantitative 模块')
    quantitative.topics[0].points.push({ code: 'other-topic.wrong-prefix', name: '前缀不符知识点' })
    expect(validateKnowledgeTree(tree)).toContain(
      `quantitative 知识点 code 须以「${quantitative.topics[0].code}.」为前缀：other-topic.wrong-prefix`,
    )
  })

  it('code 格式非法：考点含大写/下划线；知识点 slug 段含点号', () => {
    const tree = makeTree()
    const judgement = tree.find((entry) => entry.module === 'judgement')
    if (judgement === undefined) throw new Error('克隆树应含 judgement 模块')
    judgement.topics[0] = {
      code: 'Bad_Code',
      name: judgement.topics[0].name,
      points: [{ code: 'Bad_Code.legal-slug', name: '合法 slug 段' }],
    }
    const problems = validateKnowledgeTree(tree)
    expect(problems).toContain('judgement 考点 code 格式非法（应为小写 kebab-case）：Bad_Code')
    // 前缀与格式双维度均须报（此处前缀匹配、slug 段合法，只报考点格式一处）
    expect(problems).toHaveLength(1)

    const dotted = makeTree()
    const verbal = dotted.find((entry) => entry.module === 'verbal')
    if (verbal === undefined) throw new Error('克隆树应含 verbal 模块')
    verbal.topics[0].points.push({ code: `${verbal.topics[0].code}.two.dots`, name: 'slug 段含点号' })
    expect(validateKnowledgeTree(dotted)).toContain(
      `verbal 知识点 code 格式非法（应为「${verbal.topics[0].code}.<slug>」）：${verbal.topics[0].code}.two.dots`,
    )
  })

  it('name 空白：考点与知识点各自点名', () => {
    const tree = makeTree()
    const common = tree.find((entry) => entry.module === 'common_sense')
    if (common === undefined) throw new Error('克隆树应含 common_sense 模块')
    common.topics[0] = { ...common.topics[0], name: '  ' }
    common.topics[0].points[0] = { ...common.topics[0].points[0], name: '\t' }
    const problems = validateKnowledgeTree(tree)
    expect(problems).toContain(`${common.module} 考点 name 不能为空：${common.topics[0].code}`)
    expect(problems).toContain(`${common.module} 知识点 name 不能为空：${common.topics[0].points[0].code}`)
  })

  it('考点零知识点', () => {
    const tree = makeTree()
    const data = tree.find((entry) => entry.module === 'data_analysis')
    if (data === undefined) throw new Error('克隆树应含 data_analysis 模块')
    data.topics[0] = { code: data.topics[0].code, name: data.topics[0].name, points: [] }
    expect(validateKnowledgeTree(tree)).toContain(
      `data_analysis 考点至少需要 1 个知识点：${data.topics[0].code}`,
    )
  })

  it('空树：六模块全部缺失', () => {
    expect(validateKnowledgeTree([])).toEqual([
      '模块缺失：political_theory',
      '模块缺失：common_sense',
      '模块缺失：verbal',
      '模块缺失：quantitative',
      '模块缺失：judgement',
      '模块缺失：data_analysis',
    ])
  })
})
