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
  /** 实际进 SQL 的图片数：题目（题干/选项/解析）与题组（材料）富片段中 image 段 path 的去重集合大小（T1-05 阶段 B 做实） */
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

/* ============ 图片阶段（T1-05：图片收集、压缩、内容寻址键派生与产物路径重写；阶段 B 增 R2 上传） ============ */

/** runImagesStage 入参（images 子命令与测试直调共用） */
export interface ImagesStageOptions {
  /** runImport 产物目录（含 import-manifest.json 与 modules/*.json）；r2/ 工件与 images-manifest.json 亦写回本目录 */
  productsDir: string
  /** 源仓库根目录（绝对或相对路径）；缺省读 import-manifest.json 的 input 字段，显式传入则覆盖（源仓库迁移场景） */
  inputDir?: string
  /** R2 桶名（CLI --bucket 传入，是参数不是凭据）；出现即启用上传：r2/ 工件全量 put（幂等覆盖，重跑安全） */
  bucket?: string
  /** true = wrangler 本地态（--local，离线冒烟）；默认远端，凭据走 wrangler 本机 OAuth（源码零凭据） */
  local?: boolean
  /** 上传并发上限（默认 4；CLI 校验 2–16，直调越界值按 [2,16] 夹取） */
  concurrency?: number
  /** 上传 put 执行器注入点（缺省真 spawn 仓库根 wrangler.js；测试注入替身以免真调 wrangler） */
  runPut?: R2PutRunner
}

/** 图片阶段统计（images-manifest.json 的 stats 同结构；口径为本阶段实际发生的动作——重跑时 alreadyKeyed 上升、compressed/passthrough 归零） */
export interface ImagesStageStats {
  /** 图片段总出现次数（题干/选项/解析/材料四处宿主合计；含 alreadyKeyed 已重写段） */
  references: number
  /** 图片映射条数（不同源文件数，按首见去重） */
  images: number
  /** 压缩为 webp 的源图数 */
  compressed: number
  /** gif 原字节透传的源图数 */
  passthrough: number
  /** 已是内容寻址键且 r2/ 工件在位的图片段数（幂等重跑口径） */
  alreadyKeyed: number
  /** error 级问题条数（>0 时 CLI 退出码 1） */
  errors: number
  /** warning 级问题条数 */
  warnings: number
}

/** 单个源图 → 工件映射（images-manifest.json 的 images 数组条目；首见序） */
export interface ImageMapping {
  /** 源文件在输入根内的 POSIX 相对路径（首见去重键，如 '90-图片/题目图/<hex>.png'） */
  source: string
  /** 内容寻址键（'img/<源字节 sha256>.webp' 或 '.gif'；DB 存裸键，访问 URL 由服务层构造——ADR-0007） */
  key: string
  /** 被引用次数（同一源文件跨试卷/跨段累计） */
  refs: number
  /** 源文件字节数 */
  origBytes: number
  /** 工件字节数（压缩后大小；透传与 origBytes 相同） */
  outBytes: number
  /** 原始像素宽（sharp metadata） */
  width: number
  /** 原始像素高（sharp metadata） */
  height: number
  /** 源格式（sharp metadata.format，如 'png'/'gif'） */
  format: string
}

/** 图片阶段产物 images-manifest.json 结构（确定性：同产物 + 同输入 → 逐字节相同；产物无变更的重跑不重写本文件） */
export interface ImagesManifest {
  /** 导入版本号（取自 import-manifest.json；本阶段不回写 import-manifest.json） */
  version: string
  /** 实际使用的输入目录（绝对路径，反斜杠规范化正斜杠；--input 覆盖时为其解析值） */
  input: string
  stats: ImagesStageStats
  /** 源图映射（首见序：模块序 → 试卷序 → items 序 → 段序） */
  images: ImageMapping[]
  /** 图片阶段问题清单（收集顺序同上，确定性文本无时间戳） */
  issues: ImportIssue[]
}

/** runImagesStage 返回值（供 CLI 判退出码与测试断言） */
export interface ImagesStageResult {
  stats: ImagesStageStats
  /** severity 'error' 的条数（含上传失败；>0 时 CLI 退出码 1） */
  hardErrors: number
  /** 图片阶段问题清单（与 images-manifest.json 的 issues 同内容） */
  issues: ImportIssue[]
  /** 写出的产物文件（绝对路径；含 r2 工件、被改写的模块 JSON 与 images-manifest.json；上传不写本地文件） */
  wrote: string[]
  /** 被改写的模块 JSON 路径列表（本次运行实际发生图片段 path 重写的文件） */
  rewrote: string[]
  /** 上传统计切片（仅启用 --bucket 时存在；上传成功且无其他变更时本次不写任何文件） */
  upload?: { uploaded: number; failed: number }
}

/* ============ R2 上传（T1-05 阶段 B：r2/ 工件区 → wrangler r2 object put） ============ */

/**
 * 上传 put 执行器（注入点）：args 为 wrangler 子命令参数（不含 wrangler.js 路径本身），
 * 即 ['r2','object','put','<bucket>/<key>','--file',<对象键（相对 cwd）>,'--content-type',<mime>[,'--local']）；
 * cwd 为 r2/ 工件根（--file 以相对键引用工件，绝对路径不进 argv——全部动态参数
 * 均为白名单字符集内的值，汇点处另有结构化复检）。默认实现经 node 直启仓库根
 * wrangler.js 真 spawn（参数数组直传、显式 shell:false）；测试注入替身记录调用并
 * 可控失败，不触发真进程。code 为进程退出码（0 = 成功）；stderr 为错误诊断文本
 * （默认实现收集子进程 stderr，为空时回退 stdout——wrangler 诊断可能走任一流）。
 */
export type R2PutRunner = (args: string[], cwd: string) => Promise<{ code: number; stderr: string }>

/** uploadArtifacts 入参 */
export interface R2UploadOptions {
  /** 产物目录（其下 r2/ 为待传工件区；目录不存在 = 无图可传的合法状态） */
  productsDir: string
  /** R2 桶名（CLI 参数而非凭据） */
  bucket: string
  /** true = wrangler 本地态（--local，离线冒烟）；默认远端 */
  local?: boolean
  /** 并发上限（默认 4；CLI 校验 2–16，直调越界值按 [2,16] 夹取，池永不因 0/负值挂起） */
  concurrency?: number
}

/** uploadArtifacts 返回值（结果一律按输入序聚合：并发完成序不确定，产出顺序必须确定） */
export interface R2UploadResult {
  /** 上传成功对象数 */
  uploaded: number
  /** 上传失败对象数（退出码非 0） */
  failed: number
  /** 全部对象键（输入序 = r2/ 遍历排序序；含失败者） */
  keys: string[]
  /** 上传问题清单（输入序；r2_upload_failed 错误级 issue） */
  issues: ImportIssue[]
}
