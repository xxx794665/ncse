/**
 * 模块映射：源仓库模块目录名（含序号前缀）→ ncse 稳定模块 code。
 * 显式映射表常量——目录名出现新增/改名时在此登记，未登记目录一律忽略。
 */
import type { ModuleCode } from './types.js'

export interface ModuleFolder {
  /** 源仓库模块目录名（如 '01-政治理论'） */
  folder: string
  /** ncse 模块 code（modules 表 code） */
  code: ModuleCode
}

/** 固定模块序（01→06）：产物排序与统计口径的唯一依据 */
export const MODULE_FOLDERS: readonly ModuleFolder[] = [
  { folder: '01-政治理论', code: 'political_theory' },
  { folder: '02-常识判断', code: 'common_sense' },
  { folder: '03-言语理解与表达', code: 'verbal' },
  { folder: '04-数量关系', code: 'quantitative' },
  { folder: '05-判断推理', code: 'judgement' },
  { folder: '06-资料分析', code: 'data_analysis' },
] as const

/** 目录名 → 模块 code 查找（未登记目录返回 undefined，调用方忽略之） */
export function moduleCodeOfFolder(folder: string): ModuleCode | undefined {
  return MODULE_FOLDERS.find((m) => m.folder === folder)?.code
}
