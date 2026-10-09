/**
 * 入库阶段（T1-15）：读 runImport 的 JSON 产物目录，生成确定性幂等 upsert SQL 文件。
 * 生成语义（全部确定性：同产物 + 同 version → SQL 文件逐字节相同）：
 *   a. 分类体系 upsert（exam_types/subjects/modules，id 一律标量子查询解析）；
 *   b. 题组 upsert（自然键 module_id + source_key；有效题为空的组不生成）；
 *   c. 题目 upsert（自然键 qid；题组题 group_id 经 source_key 子查询链接，独立题 NULL）；
 *   d. import_runs 行（version 幂等覆盖；input_digest 为 modules/*.json 内容指纹）；
 *   e. 孤儿题组清理（每个涉及模块一条，置于题目 upsert 之后）。
 * 数据质量门：manifest.issues 中 severity 'error' 且命中 GATING_ISSUE_CODES 的题目
 * 默认不进 SQL（--force 覆盖）；跳过名单由本函数返回、CLI 负责报告。
 * SQL 文本规范：字符串字面量仅做 ' → '' 转义；每条语句一行、以 ';' 结尾；
 * 时间一律 strftime 库端表达式；不含绝对路径与时间戳字面量；不写 BEGIN/COMMIT
 * （wrangler d1 execute 按文件分句执行，幂等 upsert 保证中断重跑自愈）。
 * 安全：products 根为受信目录（CLI 显式指定），全部派生读写路径一律经 resolveWithin
 * 界内校验（SQL 固定写回 <产物目录>/import.sql，不做任意路径输出）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MODULE_FOLDERS, moduleFolderOfCode } from './modules.js'
import { resolveWithin } from './pipeline.js'
import type { DbStageOptions, DbStageResult, DbStageStats, ModuleCode } from './types.js'

/** 产物结构无效（manifest 缺失/损坏、模块 JSON 损坏等；CLI 转退出码 1） */
export class InvalidProductsError extends Error {
  constructor(reason: string) {
    super(`产物结构无效：${reason}`)
    this.name = 'InvalidProductsError'
  }
}

/**
 * 数据质量门问题码：severity 'error' 且命中这些码的题目默认不进 SQL。
 * orphan_question 不门控（题目已按独立题处理，数据本身完好）；
 * duplicate_qid 不门控（issue 挂在被丢弃的后见题上，首见题正常导入）。
 */
const GATING_ISSUE_CODES: ReadonlySet<string> = new Set([
  'answer_not_in_options',
  'missing_answer',
  'no_options',
  'duplicate_option',
])

/** updated_at 刷新表达式（库端时钟，保证 SQL 文本确定性） */
const UPDATED_AT = "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
/** 行测科目 id 的标量子查询（挂公务员考试类型） */
const XINGCE_SUBJECT_ID = "(SELECT id FROM subjects WHERE exam_type_id=(SELECT id FROM exam_types WHERE code='civil_service') AND code='xingce')"

/* ============ 入库视角的产物结构（字段级校验后的读取形态） ============ */

/** 题目（JSON 列字段以 unknown 原值携带，写 SQL 时紧凑序列化） */
interface DbQuestion {
  qid: string
  kind: string
  stem: unknown
  options: unknown
  answer: string
  analysis: unknown
  visionText: string
  /** null = 独立题 */
  groupIndex: number | null
}

/** 题组（材料 JSON 列以 unknown 原值携带） */
interface DbGroup {
  index: number
  material: unknown
  questionQids: string[]
  year: number | null
  region: string | null
  paperType: string | null
}

/** 试卷（入库只消费来源元数据与 items 平铺序列） */
interface DbPaper {
  /** 输入目录内相对路径（POSIX 分隔；source_key 的组成成分） */
  file: string
  year: number | null
  region: string | null
  paperType: string | null
  items: Array<DbQuestion | DbGroup>
}

/** isDbQuestion 类型守卫（items 平铺混排，与解析产物同构） */
function isDbQuestion(item: DbQuestion | DbGroup): item is DbQuestion {
  return 'qid' in item
}

/* ============ 产物读取与结构校验（宽松类型 → 强类型，坏结构抛 InvalidProductsError） ============ */

/** 校验通过的 manifest 入库消费切片 */
interface ManifestSlice {
  moduleOrder: ModuleCode[]
  issues: Array<{ severity: string; code: string; qid: string | null }>
}

/** 单个模块产物（papers 为校验后的入库视图） */
interface ModuleProduct {
  /** 模块 JSON 原文（input_digest 拼接成分） */
  text: string
  papers: DbPaper[]
}

/** 模块 code 文本校验：未登记的 code 抛 InvalidProductsError，登记则返回 ModuleCode */
function expectModuleCode(code: string, where: string): ModuleCode {
  const folder = moduleFolderOfCode(code)
  if (folder === undefined) {
    throw new InvalidProductsError(`${where} 为未登记模块 code：${code}`)
  }
  return folder.code
}

/** 读 import-manifest.json 并校验入库消费字段（缺失/损坏 → InvalidProductsError） */
function readManifest(productsRoot: string): ManifestSlice {
  const where = 'import-manifest.json'
  const manifestPath = resolveWithin(productsRoot, 'import-manifest.json')
  const root = asRecord(parseJsonText(readTextFile(manifestPath, where), where), where)
  const orderValue = expectArray(root['moduleOrder'], `${where} 的 moduleOrder 字段`)
  const moduleOrder = orderValue.map((code, index) =>
    expectModuleCode(expectString(code, `${where} moduleOrder[${index}]`), `${where} moduleOrder[${index}]`),
  )
  const issuesValue = expectArray(root['issues'], `${where} 的 issues 字段`)
  const issues = issuesValue.map((entry, index) => {
    const entryWhere = `${where} issues[${index}]`
    const record = asRecord(entry, entryWhere)
    return {
      severity: expectString(record['severity'], `${entryWhere} 的 severity 字段`),
      code: expectString(record['code'], `${entryWhere} 的 code 字段`),
      qid: expectStringOrNull(record['qid'], `${entryWhere} 的 qid 字段`),
    }
  })
  return { moduleOrder, issues }
}

/**
 * 读单个模块产物 modules/<code>.json 并校验结构。
 * 文件不存在返回 null（runImport 只为有试卷的模块写文件，缺失不是错误）；
 * 存在但不可读/非法 JSON/结构不符 → InvalidProductsError。
 */
function readModuleProduct(productsRoot: string, code: ModuleCode): ModuleProduct | null {
  const where = `modules/${code}.json`
  const modulePath = resolveWithin(productsRoot, `modules/${code}.json`)
  if (!fs.existsSync(modulePath)) return null
  const text = readTextFile(modulePath, where)
  const root = asRecord(parseJsonText(text, where), where)
  const moduleField = expectString(root['module'], `${where} 的 module 字段`)
  if (moduleField !== code) {
    throw new InvalidProductsError(`${where} 的 module 字段为 ${moduleField}，与文件名不一致`)
  }
  const papersValue = expectArray(root['papers'], `${where} 的 papers 字段`)
  const papers = papersValue.map((paper, index) => validatePaper(paper, `${where} papers[${index}]`))
  return { text, papers }
}

/** 校验试卷结构（file/items 必需，来源元数据可空） */
function validatePaper(value: unknown, where: string): DbPaper {
  const record = asRecord(value, where)
  const itemsValue = expectArray(record['items'], `${where} 的 items 字段`)
  const items = itemsValue.map((item, index) => validateItem(item, `${where} items[${index}]`))
  return {
    file: expectString(record['file'], `${where} 的 file 字段`),
    year: expectNumberOrNull(record['year'], `${where} 的 year 字段`),
    region: expectStringOrNull(record['region'], `${where} 的 region 字段`),
    paperType: expectStringOrNull(record['paperType'], `${where} 的 paperType 字段`),
    items,
  }
}

/** 校验 items 条目（含 qid 键为题目，否则为题组） */
function validateItem(value: unknown, where: string): DbQuestion | DbGroup {
  const record = asRecord(value, where)
  if ('qid' in record) {
    return {
      qid: expectString(record['qid'], `${where} 的 qid 字段`),
      kind: expectString(record['kind'], `${where} 的 kind 字段`),
      stem: expectArray(record['stem'], `${where} 的 stem 字段`),
      options: expectArray(record['options'], `${where} 的 options 字段`),
      answer: expectString(record['answer'], `${where} 的 answer 字段`),
      analysis: expectArray(record['analysis'], `${where} 的 analysis 字段`),
      visionText: expectString(record['visionText'], `${where} 的 visionText 字段`),
      groupIndex: expectNumberOrNull(record['groupIndex'], `${where} 的 groupIndex 字段`),
    }
  }
  return {
    index: expectNumber(record['index'], `${where} 的 index 字段`),
    material: expectArray(record['material'], `${where} 的 material 字段`),
    questionQids: expectStringArray(record['questionQids'], `${where} 的 questionQids 字段`),
    year: expectNumberOrNull(record['year'], `${where} 的 year 字段`),
    region: expectStringOrNull(record['region'], `${where} 的 region 字段`),
    paperType: expectStringOrNull(record['paperType'], `${where} 的 paperType 字段`),
  }
}

/** 读文本文件（不可读 → InvalidProductsError） */
function readTextFile(filePath: string, where: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new InvalidProductsError(`${where} 读取失败：${messageOf(err)}`)
  }
}

/** 解析 JSON（非法 JSON → InvalidProductsError；结果以 unknown 携带避免 any 扩散） */
function parseJsonText(text: string, where: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new InvalidProductsError(`${where} 不是合法 JSON：${messageOf(err)}`)
  }
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidProductsError(`${where} 应为 JSON 对象`)
  }
  return value as Record<string, unknown>
}

function expectArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidProductsError(`${where} 应为数组`)
  return value
}

function expectString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new InvalidProductsError(`${where} 应为字符串`)
  return value
}

function expectStringArray(value: unknown, where: string): string[] {
  return expectArray(value, where).map((entry, index) => expectString(entry, `${where}[${index}]`))
}

function expectNumber(value: unknown, where: string): number {
  if (typeof value !== 'number') throw new InvalidProductsError(`${where} 应为数字`)
  return value
}

function expectNumberOrNull(value: unknown, where: string): number | null {
  if (value === null) return null
  return expectNumber(value, where)
}

function expectStringOrNull(value: unknown, where: string): string | null {
  if (value === null) return null
  return expectString(value, where)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ============ SQL 字面量与语句构造（全部单行、以 ';' 结尾） ============ */

/** 字符串字面量：' → '' 标准转义（中文内容含引号/分号/换行均安全，换行已在 JSON 序列化中转义） */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 可空字符串列：null 写 NULL（列可空） */
function sqlNullableString(value: string | null): string {
  return value === null ? 'NULL' : sqlString(value)
}

/** 可空整数列：null 写 NULL */
function sqlNullableInteger(value: number | null): string {
  return value === null ? 'NULL' : String(value)
}

/** JSON 列：紧凑序列化（与 Drizzle text mode:'json' 写入格式一致） */
function sqlJson(value: unknown): string {
  return sqlString(JSON.stringify(value))
}

/** 模块 id 的标量子查询（同卷模块解析，挂行测科目） */
function moduleIdExpr(code: ModuleCode): string {
  return `(SELECT id FROM modules WHERE subject_id=${XINGCE_SUBJECT_ID} AND code='${code}')`
}

/** a. 考试类型 upsert（唯一键 code） */
function examTypeUpsert(): string {
  return `INSERT INTO exam_types (code, name) VALUES ('civil_service', '公务员') ON CONFLICT(code) DO UPDATE SET name=excluded.name, ${UPDATED_AT}`
}

/** a. 科目 upsert（唯一键 exam_type_id + code；id 经考试类型子查询解析） */
function subjectUpsert(): string {
  return `INSERT INTO subjects (exam_type_id, code, name) VALUES ((SELECT id FROM exam_types WHERE code='civil_service'), 'xingce', '行测') ON CONFLICT(exam_type_id, code) DO UPDATE SET name=excluded.name, ${UPDATED_AT}`
}

/** a. 模块 upsert（唯一键 subject_id + code；name/sort_order 取 MODULE_FOLDERS） */
function moduleUpsert(code: ModuleCode, name: string, sortOrder: number): string {
  return `INSERT INTO modules (subject_id, code, name, sort_order) VALUES (${XINGCE_SUBJECT_ID}, '${code}', '${name}', ${sortOrder}) ON CONFLICT(subject_id, code) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order, ${UPDATED_AT}`
}

/** b. 题组 upsert（唯一键 module_id + source_key；year/region/paper_type 可空） */
function groupUpsert(code: ModuleCode, sourceKey: string, group: DbGroup): string {
  return `INSERT INTO question_groups (module_id, source_key, material, year, region, paper_type) VALUES (${moduleIdExpr(code)}, ${sqlString(sourceKey)}, ${sqlJson(group.material)}, ${sqlNullableInteger(group.year)}, ${sqlNullableString(group.region)}, ${sqlNullableString(group.paperType)}) ON CONFLICT(module_id, source_key) DO UPDATE SET material=excluded.material, year=excluded.year, region=excluded.region, paper_type=excluded.paper_type, ${UPDATED_AT}`
}

/** c. 题目 upsert（唯一键 qid；题组题 group_id 经 source_key 子查询链接，独立题 NULL） */
function questionUpsert(
  code: ModuleCode,
  paper: DbPaper,
  question: DbQuestion,
  groupSourceKey: string | undefined,
): string {
  const groupId =
    groupSourceKey === undefined
      ? 'NULL'
      : `(SELECT id FROM question_groups WHERE module_id=${moduleIdExpr(code)} AND source_key=${sqlString(groupSourceKey)})`
  return `INSERT INTO questions (module_id, group_id, qid, kind, stem, options, answer, analysis, year, region, paper_type, vision_text) VALUES (${moduleIdExpr(code)}, ${groupId}, ${sqlString(question.qid)}, ${sqlString(question.kind)}, ${sqlJson(question.stem)}, ${sqlJson(question.options)}, ${sqlString(question.answer)}, ${sqlJson(question.analysis)}, ${sqlNullableInteger(paper.year)}, ${sqlNullableString(paper.region)}, ${sqlNullableString(paper.paperType)}, ${sqlString(question.visionText)}) ON CONFLICT(qid) DO UPDATE SET module_id=excluded.module_id, group_id=excluded.group_id, kind=excluded.kind, stem=excluded.stem, options=excluded.options, answer=excluded.answer, analysis=excluded.analysis, year=excluded.year, region=excluded.region, paper_type=excluded.paper_type, vision_text=excluded.vision_text, ${UPDATED_AT}`
}

/** d. import_runs 行（唯一键 version；同 version 重跑幂等覆盖，不回写 created_at） */
function importRunUpsert(version: number, inputDigest: string, stats: DbStageStats): string {
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
  return `INSERT INTO import_runs (version, status, input_digest, stats, finished_at) VALUES (${version}, 'success', ${sqlString(inputDigest)}, ${sqlJson(stats)}, ${now}) ON CONFLICT(version) DO UPDATE SET status='success', input_digest=excluded.input_digest, stats=excluded.stats, finished_at=${now}, ${UPDATED_AT}`
}

/** e. 孤儿题组清理：模块内无 questions 引用的组删除（再蒸馏换组后的旧组回收） */
function orphanGroupDelete(code: ModuleCode): string {
  return `DELETE FROM question_groups WHERE module_id=${moduleIdExpr(code)} AND NOT EXISTS (SELECT 1 FROM questions WHERE questions.group_id = question_groups.id)`
}

/* ============ 编排 ============ */

/**
 * 执行一次入库阶段：读产物 → 质量门 → 生成 SQL → 写文件。
 * SQL 与统计对同产物 + 同 version 逐字节确定；跳过名单按 issues 首见序返回。
 */
export function runDbStage(options: DbStageOptions): DbStageResult {
  const productsRoot = path.resolve(options.productsDir)
  const manifest = readManifest(productsRoot)

  // ---- 数据质量门（--force 覆盖：全量导入，跳过名单为空） ----
  const skippedQids: string[] = []
  if (options.force !== true) {
    const seen = new Set<string>()
    for (const entry of manifest.issues) {
      if (entry.severity !== 'error' || !GATING_ISSUE_CODES.has(entry.code)) continue
      if (entry.qid === null || seen.has(entry.qid)) continue
      seen.add(entry.qid)
      skippedQids.push(entry.qid)
    }
  }
  const skipped = new Set(skippedQids)

  // ---- 读模块产物（moduleOrder 序；无 JSON 文件的模块跳过），同时收集原文做内容指纹 ----
  const moduleCodes: ModuleCode[] = []
  const papersByCode = new Map<ModuleCode, DbPaper[]>()
  const moduleTexts: string[] = []
  for (const code of manifest.moduleOrder) {
    const product = readModuleProduct(productsRoot, code)
    if (product === null) continue
    moduleCodes.push(code)
    papersByCode.set(code, product.papers)
    moduleTexts.push(product.text)
  }
  const inputDigest = crypto.createHash('sha256').update(moduleTexts.join(''), 'utf8').digest('hex')

  // ---- SQL 语句序（顺序固定，见文件头注释 a→e） ----
  const statements: string[] = []

  // a. 分类体系 upsert：考试类型、科目、六模块（全量 upsert，与产物模块覆盖面无关）
  statements.push(examTypeUpsert(), subjectUpsert())
  for (const folder of MODULE_FOLDERS) {
    statements.push(moduleUpsert(folder.code, folder.name, folder.sortOrder))
  }

  // b. 题组 upsert（moduleOrder → 卷序 → 组序）；qid → 所属组 source_key（题目链接依据）
  const groupOfQid = new Map<string, string>()
  let questionGroups = 0
  for (const code of moduleCodes) {
    for (const paper of papersByCode.get(code) ?? []) {
      for (const item of paper.items) {
        if (isDbQuestion(item)) continue
        const validQids = item.questionQids.filter((qid) => !skipped.has(qid))
        if (validQids.length === 0) continue // 有效题为空的组不生成（解析期全灭的组直接跳过）
        const sourceKey = `${paper.file}#${item.index}`
        statements.push(groupUpsert(code, sourceKey, item))
        questionGroups++
        for (const qid of validQids) groupOfQid.set(qid, sourceKey)
      }
    }
  }

  // c. 题目 upsert（moduleOrder → 卷序 → 文件内出现序）；组未生成的题按独立题处理（group_id NULL）
  let questions = 0
  for (const code of moduleCodes) {
    for (const paper of papersByCode.get(code) ?? []) {
      for (const item of paper.items) {
        if (!isDbQuestion(item) || skipped.has(item.qid)) continue
        statements.push(questionUpsert(code, paper, item, groupOfQid.get(item.qid)))
        questions++
      }
    }
  }

  // d. import_runs 行（实际导入统计；images/knowledgePoints 当前恒 0）
  const stats: DbStageStats = {
    questions,
    questionGroups,
    images: 0,
    knowledgePoints: 0,
  }
  statements.push(importRunUpsert(options.version, inputDigest, stats))

  // e. 孤儿题组清理（每个涉及模块一条，置于题目 upsert 之后）
  for (const code of moduleCodes) {
    statements.push(orphanGroupDelete(code))
  }

  // ---- 拼装与写出（SQL 固定写回产物目录 import.sql：产物目录即管线工件区，
  //      输出收敛在受信根内并经 resolveWithin 界内校验；UTF-8 无 BOM、LF、
  //      文件以换行结尾；每条语句一行、以 ';' 结尾） ----
  const header = `-- ncse 导入入库 SQL：version=${options.version}，生成自 import-manifest.json（幂等，可重复执行）`
  const sql = [header, ...statements.map((statement) => `${statement};`)].join('\n') + '\n'
  const sqlPath = resolveWithin(productsRoot, 'import.sql')
  fs.writeFileSync(sqlPath, sql, 'utf8')

  return { sql, sqlPath, skippedQids, stats, inputDigest }
}
