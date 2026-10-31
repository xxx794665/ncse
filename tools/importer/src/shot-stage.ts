/**
 * 截图导入阶段（M3/T3-01h-a/ADR-0014）：吸收与入库两模式。
 *   - 吸收（runShotAbsorb，CLI 缺省）：读 shot-in/<基名>.json 的视觉提取子代理
 *     staging，产人工确认草稿 shot-drafts/shot-<基名>.json（执行模型照 ADR-0008
 *     ——子代理只写 staging，吸收敛在 importer）。
 *   - 入库（runShotEmit，CLI --emit）：读 shot-drafts/ 中 status==='confirmed' 的
 *     草稿，生成独立自包含 <产物目录>/shot.sql（分类体系定位行 + 逐题 upsert +
 *     import_runs 行；不并入 import.sql，循 tag.sql / ai-analysis.sql 先例）。
 * 吸收校验序（逐文件原子，一图坏不拖累其余图；staging 为子代理产物按不可信输入校验）：
 *   1) 读失败 → error shot_staging_unreadable；2) JSON 坏 → error
 *   shot_staging_invalid_json；3) 非对象/字段类型不符 → error shot_staging_invalid；
 *   4) multiQuestion=true → warning shot_multi_question 跳过（一期一图一题，人工
 *   拆图重截；其余字段此时可空，故先于字段校验判）；5) 基名不合法 → error
 *   shot_invalid_basename；6) 源图定位（screenshots-in/ 白名单 png/jpg/jpeg/webp/
 *   gif 大小写不敏感；同名不同扩展 → error shot_source_ambiguous；无对应截图 →
 *   error shot_source_missing——草稿 sourceFile 须可溯源，缺源不产草稿）；
 *   7) moduleCode 非六选一 → error shot_module_code_invalid；8) stem 空白 → error
 *   shot_stem_empty；9) options 空/数量非 2–6/key 非从 'A' 起连续大写字母或重复/
 *   选项文本空白 → error shot_options_invalid（合并一码，消息带具体原因）；
 *   10) answer 空串与不在选项键内均合法，随草稿记 reviewNotes 提示人工补充/校对；
 *   analysis 空串合法（reviewNotes 提示解析缺失不阻塞）；staging notes 并入
 *   reviewNotes 保留代理附注。
 * 入库语义（emit）：
 *   - 只消费 confirmed 草稿（draft 状态静默跳过不产 SQL 不记 issue——人工闸门未
 *     放行）；未知 status / 草稿文件名或 qid 与基名派生不一致 / moduleCode、kind、
 *     stem、options 结构破坏 → error 级跳过（人工修复后重跑）。
 *   - 质量门（码表语义照 db-stage：missing_answer / answer_not_in_options /
 *     no_options）warning 级跳过不写半截；判定序 no_options → missing_answer →
 *     answer_not_in_options（更根本的门先判，每题至多记一条门控 warning）。
 *   - 逐题 upsert questions（by qid；镜像 db-stage questionUpsert 列序，groupId/
 *     year/region/paper_type 恒 NULL、vision_text 恒空串、stem/options/analysis
 *     为文本单段富片段数组）+ import_runs 行（stats 记 shotQuestions/门控跳过数/
 *     错误跳过数）；无 confirmed 题不写文件不记 import_runs（空语义照 tag-stage）。
 * 确定性与安全：草稿经 serializeJson 无时间戳逐字节确定，同名草稿已存在跳过不覆盖
 * （保护人工编辑）并记 warning；SQL 同草稿 + 同 version 逐字节确定。products 根为
 * 受信目录（CLI 显式指定），截图枚举/staging/草稿/SQL 的全部读写路径经
 * resolveWithin 界内校验（SQL 固定写回 <产物目录>/shot.sql，不做任意路径输出）。
 * SQL 文本规范与 db/tag 阶段一致：' → '' 转义、每语句一行以 ';' 结尾、时间一律
 * strftime 库端表达式、无时间戳字面量与绝对路径、不写事务。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { UPDATED_AT, issue, moduleIdExpr, sqlString, taxonomySeedStatements } from './db-stage.js'
import { moduleFolderOfCode } from './modules.js'
import { resolveWithin, serializeJson } from './pipeline.js'
import type {
  ImportIssue,
  ModuleCode,
  ShotAbsorbOptions,
  ShotAbsorbResult,
  ShotAbsorbStats,
  ShotDraft,
  ShotEmitOptions,
  ShotEmitResult,
  ShotEmitStats,
} from './types.js'
import type { QuestionOption, RichContent } from '@ncse/shared'

/** 截图基名合法字符集（ADR-0014：^[A-Za-z0-9_-]+$，即 qid 幂等键字符空间） */
const BASENAME_PATTERN = /^[A-Za-z0-9_-]+$/
/** 截图白名单扩展（小写比较，大小写不敏感） */
const SCREENSHOT_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
/** 选项数量下限/上限（key 从 'A' 起连续大写字母） */
const MIN_OPTIONS = 2
const MAX_OPTIONS = 6

/* ============ 共用小工具（unknown 收窄与文本规范化） ============ */

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** unknown → JSON 对象收窄（非对象返回 null，调用方转 issue） */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** unknown → 字符串收窄（非字符串返回 null，调用方转 issue） */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 文本规范化：行尾统一 \n（\r\n 与孤立 \r 折叠）、整体 trim；内部换行保留（同 ai-stage 口径） */
function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

/** 选项结构校验结果：ok=false 时 problem 为确定性原因文本（并入 issue message） */
type OptionParse =
  { ok: true; options: Array<{ key: string; text: string }> } | { ok: false; problem: string }

/**
 * 解析并校验选项数组（key 从 'A' 起连续大写字母、数量 2–6、key 不重复、文本非空白）。
 * 空数组在吸收侧为 error（数量非法），在 emit 侧由调用方先按 no_options 质量门处理
 * （故本函数对 0 项返回数量非法的原因文本，仅 emit 侧先于本函数拦截空数组）。
 */
function parseOptions(value: unknown): OptionParse {
  if (!Array.isArray(value)) return { ok: false, problem: 'options 字段应为数组' }
  if (value.length < MIN_OPTIONS || value.length > MAX_OPTIONS) {
    return {
      ok: false,
      problem: `options 数量非法（${value.length} 项，须 ${MIN_OPTIONS}–${MAX_OPTIONS} 项）`,
    }
  }
  const seen = new Set<string>()
  const parsed: Array<{ key: string; text: string }> = []
  for (let index = 0; index < value.length; index++) {
    const entry = asRecord(value[index])
    if (entry === null) return { ok: false, problem: `选项第 ${index + 1} 项应为对象` }
    const key = asString(entry['key'])
    const text = asString(entry['text'])
    if (key === null || text === null) {
      return { ok: false, problem: `选项第 ${index + 1} 项的 key/text 应为字符串` }
    }
    // 连续性：第 i 项的 key 必须恰为第 i 个大写字母（'A' 起）——非连续与重复均由此暴露
    const expected = String.fromCharCode('A'.charCodeAt(0) + index)
    if (key !== expected) {
      return {
        ok: false,
        problem: `选项 key 非从 'A' 起连续大写字母（第 ${index + 1} 项为 '${key}'，应为 '${expected}'）`,
      }
    }
    if (seen.has(key)) return { ok: false, problem: `选项 key 重复：'${key}'` }
    seen.add(key)
    const textNorm = normalizeText(text)
    if (textNorm.length === 0) return { ok: false, problem: `选项文本空白（第 ${index + 1} 项）` }
    parsed.push({ key, text: textNorm })
  }
  return { ok: true, options: parsed }
}

/** 位置序基名 → 期望 qid（ADR-0014 命名空间 shot-<基名>） */
const shotQidOf = (base: string): string => `shot-${base}`

/* ============ 吸收模式 ============ */

/** screenshots-in/ 扫描结果：基名 → 源文件名映射 + 同名不同扩展的歧义基名集 */
interface ScreenshotIndex {
  fileByBase: Map<string, string>
  ambiguous: Set<string>
}

/**
 * 扫描 screenshots-in/ 建基名 → 源文件名映射（白名单扩展大小写不敏感；源文件名
 * 保留原始大小写写入草稿 sourceFile）。目录缺失 = 无截图的合法状态（空映射）。
 */
function screenshotIndex(productsRoot: string): ScreenshotIndex {
  const dir = resolveWithin(productsRoot, 'screenshots-in')
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).sort()
  } catch {
    files = []
  }
  const fileByBase = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const file of files) {
    const dot = file.lastIndexOf('.')
    if (dot <= 0) continue // 无扩展名或基名为空（'.png' 形态）的文件不入白名单
    if (!SCREENSHOT_EXTENSIONS.has(file.slice(dot + 1).toLowerCase())) continue
    const base = file.slice(0, dot)
    if (fileByBase.has(base)) ambiguous.add(base)
    else fileByBase.set(base, file)
  }
  return { fileByBase, ambiguous }
}

/**
 * 执行一次截图吸收：读 shot-in/*.json（文件名字典序）逐图校验 → 写人工确认草稿
 * shot-drafts/shot-<基名>.json。同 staging 逐字节确定；同名草稿已存在跳过不覆盖。
 */
export function runShotAbsorb(options: ShotAbsorbOptions): ShotAbsorbResult {
  const productsRoot = path.resolve(options.productsDir)
  const sources = screenshotIndex(productsRoot)

  // staging 清单（shot-in/*.json；目录缺失 = 空 staging），文件名字典序确定性处理
  const stagingDir = resolveWithin(productsRoot, 'shot-in')
  let stagingFiles: string[] = []
  try {
    stagingFiles = fs
      .readdirSync(stagingDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    stagingFiles = []
  }

  const issues: ImportIssue[] = []
  let created = 0
  let skippedExisting = 0

  for (const file of stagingFiles) {
    const base = file.slice(0, -'.json'.length)
    const relative = `shot-in/${file}`
    const qid = shotQidOf(base)
    let text: string
    try {
      text = fs.readFileSync(resolveWithin(stagingDir, file), 'utf8')
    } catch (err) {
      issues.push(
        issue(
          'error',
          'shot_staging_unreadable',
          relative,
          qid,
          `staging 文件读取失败：${messageOf(err)}`,
        ),
      )
      continue
    }
    let root: unknown
    try {
      root = JSON.parse(text) as unknown
    } catch (err) {
      issues.push(
        issue(
          'error',
          'shot_staging_invalid_json',
          relative,
          qid,
          `staging 不是合法 JSON：${messageOf(err)}`,
        ),
      )
      continue
    }
    const record = asRecord(root)
    if (record === null) {
      issues.push(issue('error', 'shot_staging_invalid', relative, qid, 'staging 应为 JSON 对象'))
      continue
    }

    // multiQuestion 先判（多题图其余字段可空，warning 跳过不产草稿——人工拆图重截）
    const multiQuestion = record['multiQuestion']
    if (multiQuestion === true) {
      issues.push(
        issue(
          'warning',
          'shot_multi_question',
          relative,
          qid,
          '截图含多道小题（multiQuestion=true），一期一图一题，请拆图重截后再提取',
        ),
      )
      continue
    }
    if (multiQuestion !== undefined && multiQuestion !== false) {
      issues.push(
        issue(
          'error',
          'shot_staging_invalid',
          relative,
          qid,
          `multiQuestion 字段应为布尔值：${JSON.stringify(multiQuestion)}`,
        ),
      )
      continue
    }

    if (!BASENAME_PATTERN.test(base)) {
      issues.push(
        issue(
          'error',
          'shot_invalid_basename',
          relative,
          qid,
          `基名不合法（须匹配 ^[A-Za-z0-9_-]+$）：${base}`,
        ),
      )
      continue
    }

    // 源图溯源（草稿 sourceFile 依据；无源/歧义不产草稿）
    if (sources.ambiguous.has(base)) {
      issues.push(
        issue(
          'error',
          'shot_source_ambiguous',
          relative,
          qid,
          `screenshots-in/ 存在基名 ${base} 的多张白名单截图（不同扩展），无法定位唯一源图`,
        ),
      )
      continue
    }
    const sourceFile = sources.fileByBase.get(base)
    if (sourceFile === undefined) {
      issues.push(
        issue(
          'error',
          'shot_source_missing',
          relative,
          qid,
          `screenshots-in/ 无基名 ${base} 的白名单截图（png/jpg/jpeg/webp/gif，大小写不敏感），缺源不产草稿`,
        ),
      )
      continue
    }

    // moduleCode 六选一（moduleFolderOfCode 未登记返回 undefined）
    const moduleCode = asString(record['moduleCode'])
    if (moduleCode === null) {
      issues.push(
        issue('error', 'shot_staging_invalid', relative, qid, 'moduleCode 字段应为字符串'),
      )
      continue
    }
    const folder = moduleFolderOfCode(moduleCode)
    if (folder === undefined) {
      issues.push(
        issue(
          'error',
          'shot_module_code_invalid',
          relative,
          qid,
          `moduleCode 非法（须六选一 political_theory/common_sense/verbal/quantitative/judgement/data_analysis）：${moduleCode}`,
        ),
      )
      continue
    }

    // stem（类型 + 非空白）
    const stemRaw = asString(record['stem'])
    if (stemRaw === null) {
      issues.push(issue('error', 'shot_staging_invalid', relative, qid, 'stem 字段应为字符串'))
      continue
    }
    const stem = normalizeText(stemRaw)
    if (stem.length === 0) {
      issues.push(issue('error', 'shot_stem_empty', relative, qid, 'stem 为空或全空白'))
      continue
    }

    // options（结构 + key 连续性 + 文本非空白）
    const optionsParse = parseOptions(record['options'])
    if (!optionsParse.ok) {
      issues.push(issue('error', 'shot_options_invalid', relative, qid, optionsParse.problem))
      continue
    }

    // answer / analysis / notes 类型（answer 空串与不在键内均合法，见 reviewNotes）
    const answerRaw = asString(record['answer'])
    if (answerRaw === null) {
      issues.push(issue('error', 'shot_staging_invalid', relative, qid, 'answer 字段应为字符串'))
      continue
    }
    const analysisRaw = asString(record['analysis'])
    if (analysisRaw === null) {
      issues.push(issue('error', 'shot_staging_invalid', relative, qid, 'analysis 字段应为字符串'))
      continue
    }
    const notesValue = record['notes']
    if (notesValue !== undefined && typeof notesValue !== 'string') {
      issues.push(
        issue('error', 'shot_staging_invalid', relative, qid, 'notes 字段应为字符串（可选）'),
      )
      continue
    }

    // reviewNotes（确定性顺序：answer → 解析缺失 → 代理附注）
    const answer = normalizeText(answerRaw)
    const analysis = normalizeText(analysisRaw)
    const reviewNotes: string[] = []
    if (answer.length === 0) {
      reviewNotes.push('answer 为空，需人工补充后置 confirmed 才能入库')
    } else if (!optionsParse.options.some((option) => option.key === answer)) {
      reviewNotes.push(`answer 不在选项键内（${answer}），需校对`)
    }
    if (analysis.length === 0) {
      reviewNotes.push('解析缺失（analysis 为空），人工可补充；不阻塞入库')
    }
    const notes = notesValue === undefined ? '' : normalizeText(notesValue)
    if (notes.length > 0) reviewNotes.push(`视觉提取附注：${notes}`)

    // 草稿写入（serializeJson 字节确定性；已存在跳过不覆盖，保护人工编辑）
    const draft: ShotDraft = {
      qid,
      status: 'draft',
      sourceFile,
      moduleCode: folder.code,
      kind: 'single_choice',
      stem,
      options: optionsParse.options,
      answer,
      analysis,
      reviewNotes,
    }
    const draftsDir = resolveWithin(productsRoot, 'shot-drafts')
    const draftPath = resolveWithin(draftsDir, `shot-${base}.json`)
    if (fs.existsSync(draftPath)) {
      issues.push(
        issue(
          'warning',
          'shot_draft_exists',
          `shot-drafts/shot-${base}.json`,
          qid,
          '草稿已存在，跳过不覆盖（保护人工编辑）',
        ),
      )
      skippedExisting++
      continue
    }
    fs.mkdirSync(draftsDir, { recursive: true })
    fs.writeFileSync(draftPath, serializeJson(draft), 'utf8')
    created++
  }

  const stats: ShotAbsorbStats = {
    created,
    skippedExisting,
    warnings: issues.filter((entry) => entry.severity === 'warning').length,
    errors: issues.filter((entry) => entry.severity === 'error').length,
  }
  return { stats, issues }
}

/* ============ 入库模式（emit） ============ */

/** 截图题 upsert（唯一键 qid；镜像 db-stage questionUpsert 列序——group/year/region/paper_type 恒 NULL、vision_text 恒空串；富片段为文本单段数组） */
function shotQuestionUpsert(code: ModuleCode, draft: ShotDraft): string {
  // 富片段构造：一期纯文本化（ADR-0014 决策 3），stem/options/analysis 均为单文本段
  const stem: RichContent = [{ type: 'text', text: draft.stem }]
  const options: QuestionOption[] = draft.options.map((option) => ({
    key: option.key,
    content: [{ type: 'text', text: option.text }] satisfies RichContent,
  }))
  const analysis: RichContent = [{ type: 'text', text: draft.analysis }]
  // JSON 列紧凑序列化（与 db-stage sqlJson 同实现形态：sqlString(JSON.stringify(value))）
  const sqlJson = (value: unknown): string => sqlString(JSON.stringify(value))
  return `INSERT INTO questions (module_id, group_id, qid, kind, stem, options, answer, analysis, year, region, paper_type, vision_text) VALUES (${moduleIdExpr(code)}, NULL, ${sqlString(draft.qid)}, ${sqlString(draft.kind)}, ${sqlJson(stem)}, ${sqlJson(options)}, ${sqlString(draft.answer)}, ${sqlJson(analysis)}, NULL, NULL, NULL, ${sqlString('')}) ON CONFLICT(qid) DO UPDATE SET module_id=excluded.module_id, group_id=excluded.group_id, kind=excluded.kind, stem=excluded.stem, options=excluded.options, answer=excluded.answer, analysis=excluded.analysis, year=excluded.year, region=excluded.region, paper_type=excluded.paper_type, vision_text=excluded.vision_text, ${UPDATED_AT}`
}

/**
 * 执行一次截图入库：读 shot-drafts/*.json（文件名字典序）中 confirmed 草稿 →
 * 质量门过滤 → 生成 shot.sql（分类体系定位 + 逐题 upsert + import_runs 行）。
 * 同草稿 + 同 version 逐字节确定；无 confirmed 题不写文件不记 import_runs。
 */
export function runShotEmit(options: ShotEmitOptions): ShotEmitResult {
  const productsRoot = path.resolve(options.productsDir)

  // 草稿清单（shot-drafts/*.json；目录缺失 = 无草稿的合法状态），文件名字典序
  const draftsDir = resolveWithin(productsRoot, 'shot-drafts')
  let draftFiles: string[] = []
  try {
    draftFiles = fs
      .readdirSync(draftsDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    draftFiles = []
  }

  const issues: ImportIssue[] = []
  const stats: ShotEmitStats = { shotQuestions: 0, gatedSkipped: 0, errorSkipped: 0 }
  const statements: string[] = [...taxonomySeedStatements()]
  const digestParts: string[] = []

  for (const file of draftFiles) {
    const stem = file.slice(0, -'.json'.length)
    const relative = `shot-drafts/${file}`
    // 草稿文件名即 qid 幂等键载体（shot-<基名>.json），非该形态视为结构破坏
    if (!stem.startsWith('shot-') || !BASENAME_PATTERN.test(stem.slice('shot-'.length))) {
      issues.push(
        issue(
          'error',
          'shot_draft_name_invalid',
          relative,
          null,
          `草稿文件名应为 shot-<基名>.json（基名须匹配 ^[A-Za-z0-9_-]+$）：${file}`,
        ),
      )
      stats.errorSkipped++
      continue
    }
    const base = stem.slice('shot-'.length)
    const qid = shotQidOf(base)

    let text: string
    try {
      text = fs.readFileSync(resolveWithin(draftsDir, file), 'utf8')
    } catch (err) {
      issues.push(
        issue(
          'error',
          'shot_draft_unreadable',
          relative,
          qid,
          `草稿文件读取失败：${messageOf(err)}`,
        ),
      )
      stats.errorSkipped++
      continue
    }
    let root: unknown
    try {
      root = JSON.parse(text) as unknown
    } catch (err) {
      issues.push(
        issue(
          'error',
          'shot_draft_invalid_json',
          relative,
          qid,
          `草稿不是合法 JSON：${messageOf(err)}`,
        ),
      )
      stats.errorSkipped++
      continue
    }
    const record = asRecord(root)
    if (record === null) {
      issues.push(issue('error', 'shot_draft_invalid', relative, qid, '草稿应为 JSON 对象'))
      stats.errorSkipped++
      continue
    }

    // 只消费 confirmed（draft 状态静默跳过——人工闸门未放行不算问题；未知 status 报错）
    const status = asString(record['status'])
    if (status === 'draft') continue
    if (status !== 'confirmed') {
      issues.push(
        issue(
          'error',
          'shot_draft_status_invalid',
          relative,
          qid,
          `status 应为 'draft' 或 'confirmed'：${status === null ? '(非字符串)' : status}`,
        ),
      )
      stats.errorSkipped++
      continue
    }
    digestParts.push(`${file}\n${text}`)

    // qid 与文件名派生一致（防人工误改 qid 破坏幂等键，ADR-0014 决策 1）
    if (asString(record['qid']) !== qid) {
      issues.push(
        issue(
          'error',
          'shot_draft_qid_mismatch',
          relative,
          qid,
          `草稿 qid 与文件名派生不一致（应为 ${qid}）`,
        ),
      )
      stats.errorSkipped++
      continue
    }

    const moduleCode = asString(record['moduleCode'])
    const folder = moduleCode === null ? undefined : moduleFolderOfCode(moduleCode)
    if (folder === undefined) {
      issues.push(
        issue(
          'error',
          'shot_draft_module_invalid',
          relative,
          qid,
          `moduleCode 非法（须六选一 political_theory/common_sense/verbal/quantitative/judgement/data_analysis）：${moduleCode === null ? '(非字符串)' : moduleCode}`,
        ),
      )
      stats.errorSkipped++
      continue
    }

    if (asString(record['kind']) !== 'single_choice') {
      issues.push(
        issue(
          'error',
          'shot_draft_kind_invalid',
          relative,
          qid,
          "kind 应为 'single_choice'（一期仅单选）",
        ),
      )
      stats.errorSkipped++
      continue
    }

    const stemText = asString(record['stem'])
    if (stemText === null) {
      issues.push(issue('error', 'shot_draft_invalid', relative, qid, 'stem 字段应为字符串'))
      stats.errorSkipped++
      continue
    }
    const stemNorm = normalizeText(stemText)
    if (stemNorm.length === 0) {
      issues.push(issue('error', 'shot_draft_stem_empty', relative, qid, 'stem 为空或全空白'))
      stats.errorSkipped++
      continue
    }

    // 质量门（码表语义照 db-stage，warning 级跳过不写半截）：
    // no_options → missing_answer → answer_not_in_options（更根本的门先判，每题至多一条）
    const optionsValue = record['options']
    if (Array.isArray(optionsValue) && optionsValue.length === 0) {
      issues.push(
        issue('warning', 'no_options', relative, qid, '质量门：草稿 options 为空，跳过不入库'),
      )
      stats.gatedSkipped++
      continue
    }
    const answerRaw = asString(record['answer'])
    if (answerRaw === null) {
      issues.push(issue('error', 'shot_draft_invalid', relative, qid, 'answer 字段应为字符串'))
      stats.errorSkipped++
      continue
    }
    const answer = normalizeText(answerRaw)
    if (answer.length === 0) {
      issues.push(
        issue(
          'warning',
          'missing_answer',
          relative,
          qid,
          '质量门：answer 为空，跳过不入库（需人工补充后重确认）',
        ),
      )
      stats.gatedSkipped++
      continue
    }

    const optionsParse = parseOptions(optionsValue)
    if (!optionsParse.ok) {
      issues.push(issue('error', 'shot_draft_options_invalid', relative, qid, optionsParse.problem))
      stats.errorSkipped++
      continue
    }
    if (!optionsParse.options.some((option) => option.key === answer)) {
      issues.push(
        issue(
          'warning',
          'answer_not_in_options',
          relative,
          qid,
          `质量门：answer 不在选项键内（${answer}），跳过不入库（需人工校对）`,
        ),
      )
      stats.gatedSkipped++
      continue
    }

    const analysisRaw = asString(record['analysis'])
    if (analysisRaw === null) {
      issues.push(issue('error', 'shot_draft_invalid', relative, qid, 'analysis 字段应为字符串'))
      stats.errorSkipped++
      continue
    }

    // emit 消费切片（status 已确认 confirmed；sourceFile/reviewNotes 不入 SQL 不校验）
    const draft: ShotDraft = {
      qid,
      status: 'confirmed',
      sourceFile: asString(record['sourceFile']) ?? '',
      moduleCode: folder.code,
      kind: 'single_choice',
      stem: stemNorm,
      options: optionsParse.options,
      answer,
      analysis: normalizeText(analysisRaw),
      reviewNotes: [],
    }
    statements.push(shotQuestionUpsert(folder.code, draft))
    stats.shotQuestions++
  }

  // 无 confirmed 题入库：不写文件不记 import_runs（空语义照 tag-stage；issues 仍带出）
  if (stats.shotQuestions === 0) {
    return { sql: '', sqlPath: '', stats, inputDigest: '', issues }
  }

  const inputDigest = crypto
    .createHash('sha256')
    .update(digestParts.join('\n'), 'utf8')
    .digest('hex')
  const runRow = `INSERT INTO import_runs (version, status, input_digest, stats, finished_at) VALUES (${options.version}, 'success', ${sqlString(inputDigest)}, ${sqlString(JSON.stringify(stats))}, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(version) DO UPDATE SET status='success', input_digest=excluded.input_digest, stats=excluded.stats, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${UPDATED_AT}`
  statements.push(runRow)

  const header = `-- ncse 截图导入 SQL：version=${options.version}，吸收自 shot-drafts/ 已确认草稿（幂等，可重复执行）`
  const sql = [header, ...statements.map((statement) => `${statement};`)].join('\n') + '\n'
  const sqlPath = resolveWithin(productsRoot, 'shot.sql')
  fs.writeFileSync(sqlPath, sql, 'utf8')
  return { sql, sqlPath, stats, inputDigest, issues }
}
