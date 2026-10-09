/**
 * 模块映射：源仓库模块目录名（含序号前缀）→ ncse 稳定模块 code。
 * 显式映射表常量——目录名出现新增/改名时在此登记，未登记目录一律忽略。
 * name/sortOrder 为 modules 表的展示名与排序（T1-15 入库阶段随分类体系 upsert 写入；
 * name 即目录名去序号前缀，sortOrder 1–6 与目录序号前缀一致）。
 */
import type { ModuleCode } from './types.js'

export interface ModuleFolder {
  /** 源仓库模块目录名（如 '01-政治理论'） */
  folder: string
  /** ncse 模块 code（modules 表 code） */
  code: ModuleCode
  /** modules 表展示名（入库 upsert 用；如 '政治理论'） */
  name: string
  /** modules 表 sort_order（入库 upsert 用；1–6，与目录序号前缀一致） */
  sortOrder: number
}

/** 固定模块序（01→06）：产物排序与统计口径的唯一依据 */
export const MODULE_FOLDERS: readonly ModuleFolder[] = [
  { folder: '01-政治理论', code: 'political_theory', name: '政治理论', sortOrder: 1 },
  { folder: '02-常识判断', code: 'common_sense', name: '常识判断', sortOrder: 2 },
  { folder: '03-言语理解与表达', code: 'verbal', name: '言语理解与表达', sortOrder: 3 },
  { folder: '04-数量关系', code: 'quantitative', name: '数量关系', sortOrder: 4 },
  { folder: '05-判断推理', code: 'judgement', name: '判断推理', sortOrder: 5 },
  { folder: '06-资料分析', code: 'data_analysis', name: '资料分析', sortOrder: 6 },
] as const

/** 目录名 → 模块 code 查找（未登记目录返回 undefined，调用方忽略之） */
export function moduleCodeOfFolder(folder: string): ModuleCode | undefined {
  return MODULE_FOLDERS.find((m) => m.folder === folder)?.code
}

/** 模块 code → 映射条目查找（入库阶段取 name/sortOrder 用；未登记 code 返回 undefined） */
export function moduleFolderOfCode(code: string): ModuleFolder | undefined {
  return MODULE_FOLDERS.find((m) => m.code === code)
}
