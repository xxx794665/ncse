/**
 * 行测六模块展示元数据（T1-08f，模块选择页数据源）
 * - code 与 @ncse/shared 的 XingceModuleCode 一一对应，数组顺序即页面展示顺序
 * - 中文显示名 / 图标 / 简介为页面侧展示映射：shared 暂无显示名契约，未来跨端复用时再上移
 * - sessionDisplayName（T1-10b）：会话显示名单一入口（wrong_redo 会话无 moduleCode，显「错题重做」）
 */

import type { LucideIcon } from 'lucide-react'
import { Brain, Calculator, ChartPie, Landmark, Lightbulb, MessagesSquare } from 'lucide-react'
import type { PracticeMode, XingceModuleCode } from '@ncse/shared'

/** 模块 code → 中文显示名（六模块全量；显示名的单一权威来源） */
export const XINGCE_MODULE_NAMES: Record<XingceModuleCode, string> = {
  political_theory: '政治理论',
  common_sense: '常识判断',
  verbal: '言语理解与表达',
  quantitative: '数量关系',
  judgement: '判断推理',
  data_analysis: '资料分析',
}

export interface XingceModuleMeta {
  /** 模块稳定 code（建会话请求参数） */
  code: XingceModuleCode
  /** 模块中文显示名（取自 XINGCE_MODULE_NAMES，保持一致） */
  name: string
  /** 入口卡图标（§5，24px 功能入口档） */
  icon: LucideIcon
  /** 入口卡一句简介 */
  tagline: string
}

/** 六模块入口（顺序即页面栅格展示顺序） */
export const XINGCE_MODULES: readonly XingceModuleMeta[] = [
  {
    code: 'political_theory',
    name: XINGCE_MODULE_NAMES.political_theory,
    icon: Landmark,
    tagline: '时政要闻与理论要点',
  },
  {
    code: 'common_sense',
    name: XINGCE_MODULE_NAMES.common_sense,
    icon: Lightbulb,
    tagline: '法律、历史、科技等广谱常识',
  },
  {
    code: 'verbal',
    name: XINGCE_MODULE_NAMES.verbal,
    icon: MessagesSquare,
    tagline: '片段阅读、逻辑填空与语句表达',
  },
  {
    code: 'quantitative',
    name: XINGCE_MODULE_NAMES.quantitative,
    icon: Calculator,
    tagline: '数学运算与数字推理',
  },
  {
    code: 'judgement',
    name: XINGCE_MODULE_NAMES.judgement,
    icon: Brain,
    tagline: '图形、定义、类比与逻辑判断',
  },
  {
    code: 'data_analysis',
    name: XINGCE_MODULE_NAMES.data_analysis,
    icon: ChartPie,
    tagline: '统计图表材料的速算与推断',
  },
]

/** 会话卡片按 moduleCode 反查显示名；mode 非 module / 历史数据缺省时给兜底文案 */
export function moduleDisplayName(code: XingceModuleCode | null): string {
  return code === null ? '专项练习' : XINGCE_MODULE_NAMES[code]
}

/** 会话显示名（T1-10b）：wrong_redo 会话 moduleCode 为 null，按 mode 显「错题重做」；其余按模块反查 */
export function sessionDisplayName(mode: PracticeMode, moduleCode: XingceModuleCode | null): string {
  return mode === 'wrong_redo' ? '错题重做' : moduleDisplayName(moduleCode)
}
