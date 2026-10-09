/**
 * @ncse/importer 文本导入中间产物类型（T1-04）。
 * 把 xingcezhenti Markdown 试卷解析为 ParsedPaper/ParsedGroup/ParsedQuestion，
 * 输出 JSON 中间产物；按 qid 自然键 upsert 入 D1 属管线后期任务，本模块不做 DB 写入。
 * 题库数据不入 Git 仓库、不对外分发（ADR-0004）——产物目录 .import-out/ 已被 .gitignore 忽略。
 */
import type { QuestionKind, QuestionOption, RichContent } from '@ncse/shared'

/** 行测六模块稳定 code（与 ncse modules 表的 code 对齐；映射表见 modules.ts） */
export type ModuleCode =
  | 'political_theory'
  | 'common_sense'
  | 'verbal'
  | 'quantitative'
  | 'judgement'
  | 'data_analysis'

/** 结构化题目（JSON 中间产物单位，字段与 questions 表列同构） */
export interface ParsedQuestion {
  /** 导入自然键（源仓库 qid，全库唯一，幂等 upsert 依据） */
  qid: string
  /** M1 仅单选；源为多选（如答案 'BCD'）时仍存 'single_choice'，answer 保原始连写键 */
  kind: QuestionKind
  /** 题干富片段；图片段 path 保持源仓库相对路径（'../90-图片/…'，T1-05 才重写为 R2 路径） */
  stem: RichContent
  /** 选项（key 为 A-Z 单字母；content 为选项内容富片段） */
  options: QuestionOption[]
  /** 答案（选项键；多选为多键连写如 'BCD'，保持原文不拆分） */
  answer: string
  /** 解析富片段 */
  analysis: RichContent
  /** 视觉提取的可搜索纯文本（图片题 OCR 汇总；T1-06 填充，文本导入恒为空串） */
  visionText: string
  /** 所属题组序号（「材料 N」的 N）；null = 独立题 */
  groupIndex: number | null
}

/** 题组：一篇材料挂多道小题（资料分析全量；常识不定项、言语篇章阅读亦出现此结构） */
export interface ParsedGroup {
  /** 「材料 N」的 N */
  index: number
  /** 材料富片段（文本段与图片段混合） */
  material: RichContent
  /** 组内小题 qid（按源顺序；题目本体平铺于 ParsedPaper.items，经 qid 双向关联） */
  questionQids: string[]
  /** 组级来源元数据（继承所属试卷） */
  year: number | null
  region: string | null
  paperType: string | null
}

/** 一套卷（源仓库规则：每套卷每个模块一篇 Markdown） */
export interface ParsedPaper {
  /** 输入目录内的相对路径（POSIX 分隔，如 '03-言语理解与表达/xxx.md'） */
  file: string
  /** 卷名原文（H1 标题，去 '# ' 前缀） */
  name: string
  /** 尽力提取的年份；提取不出为 null（原文保留在 meta/name） */
  year: number | null
  /** 尽力提取的地区（frontmatter 地区原值，如 '四川'/'国考'）；提取不出为 null */
  region: string | null
  /** 尽力提取的卷型（规则匹配：国考/联考/选调/省考）；匹配不出为 null */
  paperType: string | null
  /** 所属模块 code */
  module: ModuleCode
  /** frontmatter 原文键值对（保留未结构化的元数据，原文不丢） */
  meta: Record<string, string>
  /** 题目与题组，按源文件出现顺序平铺混排 */
  items: Array<ParsedQuestion | ParsedGroup>
}

/** 问题清单条目：severity 'error' 计入硬错误（CLI 退出码 1）；'warning' 仅记录不判失败 */
export interface ImportIssue {
  severity: 'error' | 'warning'
  /** 稳定问题码（清单见 parser/markdown.ts 与 pipeline.ts 各登记点） */
  code: string
  /** 所属文件（相对输入目录，POSIX 分隔） */
  file: string
  /** 相关题目 qid；与具体题目无关时为 null */
  qid: string | null
  /** 人类可读说明（确定性文本，不含时间戳等不确定值） */
  message: string
}

/** 按模块统计（manifest byModule 条目） */
export interface ModuleStat {
  /** 扫描的试卷 Markdown 文件数 */
  files: number
  /** 产出的试卷数（空卷被跳过不计） */
  papers: number
  questions: number
  groups: number
  errors: number
  warnings: number
}

/** 总产物 import-manifest.json 结构（幂等：同输入 + 同版本号 → 逐字节相同） */
export interface ImportManifest {
  /** 导入版本号（CLI --version 传入；import_runs 的版本依据） */
  version: string
  /** 输入目录（绝对路径，反斜杠已规范化为正斜杠） */
  input: string
  /** 固定模块序（产物排序依据） */
  moduleOrder: ModuleCode[]
  /** 总计统计 */
  stats: ModuleStat
  /** 按模块统计（仅含有扫描文件的模块，键序 = moduleOrder） */
  byModule: Partial<Record<ModuleCode, ModuleStat>>
  /** 问题清单（收集顺序 = 模块序 → 文件名序 → 文件内出现序，确定性） */
  issues: ImportIssue[]
}

/** runImport 返回值（供 CLI 判退出码与测试断言） */
export interface RunImportResult {
  manifest: ImportManifest
  /** severity 'error' 的条数（>0 时 CLI 退出码 1） */
  hardErrors: number
  /** 写出的产物文件（绝对路径） */
  wrote: string[]
}

/* ============ 入库阶段（T1-15：JSON 产物 → 确定性 SQL） ============ */

/** runDbStage 入参（db 子命令与测试直调共用） */
export interface DbStageOptions {
  /** runImport 产物目录（含 import-manifest.json 与 modules/*.json）；生成的 import.sql 亦写回本目录 */
  productsDir: string
  /** import_runs 版本号（正整数；同 version 重跑幂等覆盖） */
  version: number
  /** true = 跳过数据质量门、全量导入（默认 false：门控题目不进 SQL） */
  force?: boolean
}

/** 入库统计（import_runs.stats 同结构） */
export interface DbStageStats {
  /** 实际写入 questions 的行数（不含被门控跳过的题目） */
  questions: number
  /** 实际写入 question_groups 的行数（不含有效题为空的题组） */
  questionGroups: number
  /** 图片入库数（T1-05 实现，当前恒 0） */
  images: number
  /** 知识点入库数（打标任务实现，当前恒 0） */
  knowledgePoints: number
}

/** runDbStage 返回值（SQL 文本与写入信息，供测试断言） */
export interface DbStageResult {
  /** 生成的 SQL 全文（UTF-8 无 BOM；同产物 + 同 version 逐字节确定） */
  sql: string
  /** SQL 写入路径（绝对路径；恒为产物目录下的 import.sql） */
  sqlPath: string
  /** 数据质量门跳过的题目 qid（--force 时为空数组） */
  skippedQids: string[]
  /** 实际导入统计（import_runs 行的 stats 同值） */
  stats: DbStageStats
  /** 输入内容摘要（sha256 hex，modules/*.json 按 moduleOrder 拼接计算） */
  inputDigest: string
}
