/**
 * 掌握度推导单测（M3/T3-01d）：精确值、钳 0、权重合成、阈值边界、非法入参防御。
 * 从 '../src/index.js' 导入，同时验证 index.ts 的再导出接线。纯函数，无网络/文件系统/凭据。
 */
import { describe, expect, it } from 'vitest'
import { MASTERY_REINFORCE_THRESHOLD, deriveMastery, needsReinforce } from '../src/index.js'

describe('MASTERY_REINFORCE_THRESHOLD', () => {
  it('阈值为 0.6（两端同锚）', () => {
    expect(MASTERY_REINFORCE_THRESHOLD).toBe(0.6)
  })
})

describe('deriveMastery 精确值', () => {
  it('满分：accuracy=1、avg=0ms → 1（0.7 + 0.3×1）', () => {
    expect(deriveMastery(1, 0, 40)).toBeCloseTo(1)
  })

  it('accuracy=1、平均用时恰为时限一半 → 0.85（0.7 + 0.3×0.5）', () => {
    expect(deriveMastery(1, 20_000, 40)).toBeCloseTo(0.7 + 0.15)
  })

  it('全零：accuracy=0、avg=0ms → 0.3（仅用时得分）', () => {
    expect(deriveMastery(0, 0, 60)).toBeCloseTo(0.3)
  })

  it('权重合成：accuracy=0.5、用时得分 0.5 → 0.5', () => {
    expect(deriveMastery(0.5, 30_000, 60)).toBeCloseTo(0.5)
  })
})

describe('用时得分边界', () => {
  it('平均用时恰达时限（不超）→ 用时得分 0（0ms 才得 1 分的对称端）', () => {
    expect(deriveMastery(1, 40_000, 40)).toBeCloseTo(0.7)
  })

  it('平均用时超时限 → 钳 0（超一倍与恰超同值）', () => {
    expect(deriveMastery(1, 40_001, 40)).toBeCloseTo(0.7)
    expect(deriveMastery(1, 80_000, 40)).toBeCloseTo(0.7)
  })
})

describe('timeLimitSec 非法与卷外口径', () => {
  it('timeLimitSec = 0 → 用时得分 0（掌握度退化为 0.7×正确率）', () => {
    expect(deriveMastery(1, 0, 0)).toBeCloseTo(0.7)
  })

  it('timeLimitSec 为负 → 同 0 口径', () => {
    expect(deriveMastery(0.5, 100, -3)).toBeCloseTo(0.35)
  })

  it('timeLimitSec 非有限（NaN/Infinity）→ 同 0 口径', () => {
    expect(deriveMastery(1, 0, Number.NaN)).toBeCloseTo(0.7)
    expect(deriveMastery(1, 0, Number.POSITIVE_INFINITY)).toBeCloseTo(0.7)
  })
})

describe('非法入参防御（返回值恒 [0,1] 且不出 NaN）', () => {
  it('accuracy 非有限（NaN/±Infinity）按 0 计', () => {
    expect(deriveMastery(Number.NaN, 0, 40)).toBeCloseTo(0.3)
    expect(deriveMastery(Number.POSITIVE_INFINITY, 0, 40)).toBeCloseTo(0.3)
    expect(deriveMastery(Number.NEGATIVE_INFINITY, 0, 40)).toBeCloseTo(0.3)
  })

  it('accuracy 超出 [0,1] 钳回（1.5→1、-0.2→0）', () => {
    expect(deriveMastery(1.5, 0, 40)).toBeCloseTo(1)
    expect(deriveMastery(-0.2, 0, 40)).toBeCloseTo(0.3)
  })

  it('avgDurationMs 非有限或为负 → 用时得分 0（脏数据不奖励满分）', () => {
    expect(deriveMastery(1, Number.NaN, 40)).toBeCloseTo(0.7)
    expect(deriveMastery(1, Number.POSITIVE_INFINITY, 40)).toBeCloseTo(0.7)
    expect(deriveMastery(1, -5, 40)).toBeCloseTo(0.7)
  })

  it('全非法组合仍出有限值（[0,1] 域内）', () => {
    const value = deriveMastery(Number.NaN, Number.NaN, Number.NaN)
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThanOrEqual(1)
  })
})

describe('needsReinforce 阈值边界', () => {
  it('严格小于 0.6 → true；恰等于 0.6 → false（等于不算，恰好达标）', () => {
    expect(needsReinforce(0)).toBe(true)
    expect(needsReinforce(0.599999)).toBe(true)
    expect(needsReinforce(0.6)).toBe(false)
    expect(needsReinforce(0.600001)).toBe(false)
    expect(needsReinforce(1)).toBe(false)
  })

  it('与 deriveMastery 组合：卷外口径下 accuracy=0.5（mastery=0.35）判需加强', () => {
    expect(needsReinforce(deriveMastery(0.5, 0, 0))).toBe(true)
  })
})
