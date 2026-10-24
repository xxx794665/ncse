/**
 * 整卷模考推导单测（T2-01b）：试卷完整度三档分界与默认整卷时长推导（取整到 5 分钟、下限钳 5）。
 * 从 '../src/index.js' 导入，同时验证 index.ts 的再导出接线。纯函数，无网络/文件系统/凭据。
 */
import { describe, expect, it } from 'vitest'
import {
  classifyPaperCompleteness,
  deriveMockTotalMinutes,
  MOCK_TOTAL_MINUTES_MAX,
  MOCK_TOTAL_MINUTES_MIN,
  PAPER_FULL_MIN_QUESTIONS,
  PAPER_PARTIAL_MIN_QUESTIONS,
} from '../src/index.js'

describe('classifyPaperCompleteness 三档分界', () => {
  it('full：题数 110（含）起', () => {
    expect(classifyPaperCompleteness(110)).toBe('full')
    expect(classifyPaperCompleteness(PAPER_FULL_MIN_QUESTIONS)).toBe('full')
    expect(classifyPaperCompleteness(135)).toBe('full')
  })

  it('partial 边界：109 与 30', () => {
    expect(classifyPaperCompleteness(109)).toBe('partial')
    expect(classifyPaperCompleteness(30)).toBe('partial')
    expect(classifyPaperCompleteness(PAPER_PARTIAL_MIN_QUESTIONS)).toBe('partial')
  })

  it('fragment：29（含）以下', () => {
    expect(classifyPaperCompleteness(29)).toBe('fragment')
    expect(classifyPaperCompleteness(1)).toBe('fragment')
    expect(classifyPaperCompleteness(0)).toBe('fragment')
  })
})

describe('deriveMockTotalMinutes 推导', () => {
  it('1 题 → 5（钳下限）；120 题 → 120（恰整除不变）', () => {
    expect(deriveMockTotalMinutes(1)).toBe(MOCK_TOTAL_MINUTES_MIN)
    expect(deriveMockTotalMinutes(120)).toBe(120)
  })

  it('123 题 → 125（向上取整到 5 的倍数）；7 题 → 10', () => {
    expect(deriveMockTotalMinutes(123)).toBe(125)
    expect(deriveMockTotalMinutes(7)).toBe(10)
  })

  it('0 题 → 5（钳下限，不产出 0 分钟卷）', () => {
    expect(deriveMockTotalMinutes(0)).toBe(MOCK_TOTAL_MINUTES_MIN)
  })
})

describe('显式时长合法区间常量', () => {
  it('区间为 [5, 600]（与建会话入参校验共用）', () => {
    expect(MOCK_TOTAL_MINUTES_MIN).toBe(5)
    expect(MOCK_TOTAL_MINUTES_MAX).toBe(600)
  })
})
