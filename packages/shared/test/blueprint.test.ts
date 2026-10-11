/**
 * 考试蓝图单测（T1-07）：目录完整性与数值、总时长/每题时限推导、floor 与下限钳 1、校验逐类捕获。
 * 从 '../src/index.js' 导入，同时验证 index.ts 的再导出接线。纯函数，无网络/文件系统/凭据。
 */
import { describe, expect, it } from 'vitest'
import type { BlueprintModulePlan, ExamBlueprint } from '../src/index.js'
import {
  XINGCE_BLUEPRINTS,
  deriveQuestionTimeLimit,
  deriveQuestionTimeLimits,
  deriveTotalMinutes,
  validateBlueprint,
} from '../src/index.js'

/** 取目录卷型（缺失即视为目录损坏，测试失败） */
function blueprintOf(code: string): ExamBlueprint {
  const blueprint = XINGCE_BLUEPRINTS.find((item) => item.code === code)
  if (blueprint === undefined) throw new Error(`目录应含卷型：${code}`)
  return blueprint
}

/** 合成蓝图（仅覆盖被测维度，其余字段取合法默认） */
function makeBlueprint(
  modules: BlueprintModulePlan[],
  totalMinutes: number,
  code = 'synthetic_test',
  name = '合成卷',
): ExamBlueprint {
  return { code, name, totalMinutes, modules }
}

/** 题量合计 */
function questionTotal(blueprint: ExamBlueprint): number {
  return blueprint.modules.reduce((sum, plan) => sum + plan.questionCount, 0)
}

describe('目录完整性', () => {
  it('XINGCE_BLUEPRINTS 恰两条且 code 唯一', () => {
    expect(XINGCE_BLUEPRINTS).toHaveLength(2)
    const codes = XINGCE_BLUEPRINTS.map((blueprint) => blueprint.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('每条目录卷型 validateBlueprint 通过（空问题清单）', () => {
    for (const blueprint of XINGCE_BLUEPRINTS) {
      expect(validateBlueprint(blueprint)).toEqual([])
    }
  })
})

describe('目录数值', () => {
  it('标准卷：总时长 120 分钟、题量合计 120', () => {
    const std = blueprintOf('province_joint_std')
    expect(deriveTotalMinutes(std)).toBe(120)
    expect(questionTotal(std)).toBe(120)
  })

  it('紧凑卷：总时长 100 分钟、题量合计 100', () => {
    const compact = blueprintOf('province_joint_compact')
    expect(deriveTotalMinutes(compact)).toBe(100)
    expect(questionTotal(compact)).toBe(100)
  })
})

describe('deriveQuestionTimeLimit 精确值', () => {
  it('标准卷六模块：verbal=50、quantitative=90、data_analysis=90、political_theory=40、common_sense=40、judgement=60', () => {
    const std = blueprintOf('province_joint_std')
    expect(deriveQuestionTimeLimit(std, 'verbal')).toBe(50)
    expect(deriveQuestionTimeLimit(std, 'quantitative')).toBe(90)
    expect(deriveQuestionTimeLimit(std, 'data_analysis')).toBe(90)
    expect(deriveQuestionTimeLimit(std, 'political_theory')).toBe(40)
    expect(deriveQuestionTimeLimit(std, 'common_sense')).toBe(40)
    expect(deriveQuestionTimeLimit(std, 'judgement')).toBe(60)
  })

  it('紧凑卷：verbal=48、data_analysis=75', () => {
    const compact = blueprintOf('province_joint_compact')
    expect(deriveQuestionTimeLimit(compact, 'verbal')).toBe(48)
    expect(deriveQuestionTimeLimit(compact, 'data_analysis')).toBe(75)
  })
})

describe('floor 行为与下限钳 1', () => {
  it('floor：10 分钟 7 题 → 85（floor(600/7)）', () => {
    const blueprint = makeBlueprint([{ module: 'verbal', questionCount: 7, timeLimitMinutes: 10 }], 10)
    expect(deriveQuestionTimeLimit(blueprint, 'verbal')).toBe(85)
  })

  it('下限钳 1：1 分钟 120 题 → 1', () => {
    const blueprint = makeBlueprint([{ module: 'common_sense', questionCount: 120, timeLimitMinutes: 1 }], 1)
    expect(deriveQuestionTimeLimit(blueprint, 'common_sense')).toBe(1)
  })

  it('卷型未含该模块 → undefined', () => {
    const blueprint = makeBlueprint([{ module: 'verbal', questionCount: 30, timeLimitMinutes: 25 }], 25)
    expect(deriveQuestionTimeLimit(blueprint, 'quantitative')).toBeUndefined()
  })
})

describe('deriveQuestionTimeLimits', () => {
  it('标准卷：六模块全在映射且值正确', () => {
    const std = blueprintOf('province_joint_std')
    expect(deriveQuestionTimeLimits(std)).toEqual({
      political_theory: 40,
      common_sense: 40,
      verbal: 50,
      quantitative: 90,
      judgement: 60,
      data_analysis: 90,
    })
  })

  it('映射仅含卷内模块，键序 = blueprint.modules 序', () => {
    const blueprint = makeBlueprint(
      [
        { module: 'judgement', questionCount: 30, timeLimitMinutes: 30 },
        { module: 'data_analysis', questionCount: 20, timeLimitMinutes: 30 },
      ],
      60,
    )
    const limits = deriveQuestionTimeLimits(blueprint)
    expect(Object.keys(limits)).toEqual(['judgement', 'data_analysis'])
    expect(limits.verbal).toBeUndefined()
  })
})

describe('deriveTotalMinutes 汇总', () => {
  it('多模块明细汇总正确；空明细为 0', () => {
    const blueprint = makeBlueprint(
      [
        { module: 'verbal', questionCount: 30, timeLimitMinutes: 25 },
        { module: 'quantitative', questionCount: 10, timeLimitMinutes: 15 },
      ],
      40,
    )
    expect(deriveTotalMinutes(blueprint)).toBe(40)
    expect(deriveTotalMinutes(makeBlueprint([], 0))).toBe(0)
  })
})

describe('validateBlueprint 逐类捕获', () => {
  const singleModule: BlueprintModulePlan[] = [{ module: 'verbal', questionCount: 30, timeLimitMinutes: 25 }]

  it('空 code / 空 name', () => {
    expect(validateBlueprint(makeBlueprint(singleModule, 25, ''))).toContain('code 不能为空')
    expect(validateBlueprint(makeBlueprint(singleModule, 25, 'synthetic_test', ''))).toContain('name 不能为空')
  })

  it('空 modules', () => {
    expect(validateBlueprint(makeBlueprint([], 0))).toContain('modules 至少需要 1 条明细')
  })

  it('模块重复', () => {
    const duplicated: BlueprintModulePlan[] = [
      { module: 'verbal', questionCount: 30, timeLimitMinutes: 25 },
      { module: 'verbal', questionCount: 10, timeLimitMinutes: 10 },
    ]
    expect(validateBlueprint(makeBlueprint(duplicated, 35))).toContain('模块重复：verbal')
  })

  it('questionCount = 0', () => {
    const blueprint = makeBlueprint([{ module: 'verbal', questionCount: 0, timeLimitMinutes: 25 }], 25)
    expect(validateBlueprint(blueprint)).toContain('verbal 的 questionCount 必须 ≥ 1')
  })

  it('timeLimitMinutes = 0', () => {
    const blueprint = makeBlueprint([{ module: 'verbal', questionCount: 30, timeLimitMinutes: 0 }], 0)
    expect(validateBlueprint(blueprint)).toContain('verbal 的 timeLimitMinutes 必须 ≥ 1')
  })

  it('totalMinutes 与模块时限汇总不符', () => {
    const blueprint = makeBlueprint(singleModule, 99)
    expect(validateBlueprint(blueprint)).toContain('totalMinutes(99) 与模块时限汇总(25)不一致')
  })
})
