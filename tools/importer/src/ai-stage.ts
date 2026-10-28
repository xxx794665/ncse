/**
 * AI 解析吸收阶段（M3/T3-01g 一期）：读 ai-in/ staging（qid → 纯文本方法论讲解，
 * AI 解析子代理分批经 Write 工具写入，执行模型同 ADR-0008 vision 阶段与 T3-01b
 * tag 阶段——子代理只写 staging、吸收敛在 importer），生成确定性幂等 SQL 写
 * <产物目录>/ai-analysis.sql（独立自包含产物，不并入 import.sql——AI 解析是
 * 后置数据层，与题库主体解耦，远端轻量单独执行）。
 * 语义：
 *   - 按题原子：qid 未知（DB 无行）→ error 整题跳过；staging 空/全空白 →
 *     warning 整题跳过（不写半截）；质量门跳过题（产物有 DB 无，question_id
 *     子查询解析为 NULL 违反 NOT NULL——tag 实测踩坑）→ warning 级过滤。
 *   - 幂等替换：ON CONFLICT(question_id) DO UPDATE 全列覆盖（content/ai_version/
 *     updated_at）——重吸收以最新 staging 为准，重新生成 = 版本覆盖，重复执行
 *     收敛无重复行（questionId 唯一，一对一）。
 *   - import_runs 行记 version 与 AI 解析 stats（stats 键与 tag 阶段区分）。
 *   - 无可吸收产物（staging 为空或全部跳过）→ 不写文件不记 import_runs
 *     （sql/sqlPath 为空串；issues 仍随返回值带出供 CLI 报告）。
 *   - 内容规范化：行尾统一 \n（\r\n 与孤立 \r 折叠）、整体 trim；内部换行保留
 *     ——讲解为多段纯文本，段落以 \n 分隔入库。
 * SQL 文本规范与 db/tag 阶段一致：字符串字面量 ' → '' 转义、每语句一行以 ';'
 * 结尾、时间一律 strftime 库端表达式、无时间戳字面量与绝对路径、不写事务。
 * 多行内容的语句单行化：换行以 `' || char(10) || '` 拼接表达（SQLite 字符串
 * 字面量无转义序列，char(10) 为标准换行构造），语句恒单行。
 * 安全：products 根为受信目录（CLI 显式指定），staging 与产物的全部读写路径经
 * resolveWithin 界内校验（SQL 固定写回 <产物目录>/ai-analysis.sql，不做任意
 * 路径输出）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { UPDATED_AT, issue, qualityGatedQids, questionModuleIndex, sqlString } from './db-stage.js'
import { resolveWithin } from './pipeline.js'
import type { AiStageOptions, AiStageResult, AiStageStats, ImportIssue } from './types.js'

/**
 * 多行文本的 SQL 字面量：按 '\n' 切分逐段转义，以 `|| char(10) ||` 拼接——
 * 语句恒单行（每语句一行约定），入库后逐字节还原（含空行）。
 */
function sqlMultilineString(value: string): string {
  return value.split('\n').map((line) => sqlString(line)).join(' || char(10) || ')
}

/**
 * 执行一次 AI 解析吸收：读 staging → 逐题校验（qid 存在 / 非空内容）→ 生成
 * SQL（逐题 upsert + import_runs 行）→ 写 ai-analysis.sql。同 staging + 同
 * version 逐字节确定；问题按 qid 字典序收集。
 */
export function runAiStage(options: AiStageOptions): AiStageResult {
  const productsRoot = path.resolve(options.productsDir)

  // qid → 模块（产物读取在 db-stage 侧做结构校验，坏结构抛 InvalidProductsError 由 CLI 转 1）
  const moduleByQid = questionModuleIndex(productsRoot)
  // 数据质量门跳过集：这些题在产物中存在但不进 SQL（DB 无行，question_id 子查询会
  // 解析为 NULL 违反 NOT NULL）——warning 级跳过（tag 实测踩坑，批次生成侧亦应过滤）
  const gatedQids = qualityGatedQids(productsRoot)

  // staging 清单（ai-in/*.txt；目录缺失 = 空 staging），qid 字典序确定性处理
  const stagingDir = resolveWithin(productsRoot, 'ai-in')
  let stagingFiles: string[] = []
  try {
    stagingFiles = fs
      .readdirSync(stagingDir)
      .filter((name) => name.endsWith('.txt'))
      .sort()
  } catch {
    stagingFiles = []
  }

  const issues: ImportIssue[] = []
  const stats: AiStageStats = { analyzedQuestions: 0, skippedQuestions: 0 }
  const statements: string[] = []
  const digestParts: string[] = []

  for (const file of stagingFiles) {
    const qid = file.slice(0, -'.txt'.length)
    const filePath = resolveWithin(stagingDir, file)
    let text: string
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      issues.push(
        issue('error', 'ai_staging_unreadable', `ai-in/${file}`, qid, `staging 文件读取失败：${err instanceof Error ? err.message : String(err)}`),
      )
      stats.skippedQuestions++
      continue
    }
    digestParts.push(`${file}\n${text}`)

    if (gatedQids.has(qid)) {
      issues.push(
        issue('warning', 'ai_gated_qid', `ai-in/${file}`, qid, `题目 qid=${qid} 被数据质量门跳过未入库，AI 解析跳过`),
      )
      stats.skippedQuestions++
      continue
    }

    const module = moduleByQid.get(qid)
    if (module === undefined) {
      issues.push(
        issue('error', 'ai_unknown_qid', `ai-in/${file}`, qid, `题目 qid=${qid} 不在模块产物中（未知或已被质量门跳过）`),
      )
      stats.skippedQuestions++
      continue
    }

    // 内容规范化：行尾统一 \n、整体 trim；全空白 → warning 跳过（不写半截）
    const content = text.replace(/\r\n?/g, '\n').trim()
    if (content.length === 0) {
      issues.push(
        issue('warning', 'ai_analysis_empty', `ai-in/${file}`, qid, `题目 qid=${qid} 的 AI 解析内容为空或全空白，跳过`),
      )
      stats.skippedQuestions++
      continue
    }

    statements.push(
      `INSERT INTO question_ai_analysis (question_id, content, ai_version) VALUES ((SELECT id FROM questions WHERE qid=${sqlString(qid)}), ${sqlMultilineString(content)}, ${options.version}) ON CONFLICT(question_id) DO UPDATE SET content=excluded.content, ai_version=excluded.ai_version, ${UPDATED_AT}`,
    )
    stats.analyzedQuestions++
  }

  // 无可吸收产物：不写文件不记 import_runs（issues 仍带出；错误由 CLI 报告并退 1）
  if (stats.analyzedQuestions === 0) {
    return { sql: '', sqlPath: '', stats, inputDigest: '', issues }
  }

  const inputDigest = crypto.createHash('sha256').update(digestParts.join('\n'), 'utf8').digest('hex')
  const runRow = `INSERT INTO import_runs (version, status, input_digest, stats, finished_at) VALUES (${options.version}, 'success', ${sqlString(inputDigest)}, ${sqlString(JSON.stringify(stats))}, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(version) DO UPDATE SET status='success', input_digest=excluded.input_digest, stats=excluded.stats, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${UPDATED_AT}`
  statements.push(runRow)

  const header = `-- ncse AI 解析入库 SQL：version=${options.version}，吸收自 ai-in/ staging（幂等，可重复执行）`
  const sql = [header, ...statements.map((statement) => `${statement};`)].join('\n') + '\n'
  const sqlPath = resolveWithin(productsRoot, 'ai-analysis.sql')
  fs.writeFileSync(sqlPath, sql, 'utf8')
  return { sql, sqlPath, stats, inputDigest, issues }
}
