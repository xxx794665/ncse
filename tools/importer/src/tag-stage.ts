/**
 * 打标吸收阶段（M3/T3-01b）：读 tag-in/ staging（qid → 知识点 code 集，打标子代理
 * 分批经 Write 工具写入，执行模型同 ADR-0008 vision 阶段——子代理只写 staging、
 * 吸收敛在 importer），生成确定性幂等 SQL 写 <产物目录>/tag.sql。
 * 语义：
 *   - 树侧：XINGCE_KNOWLEDGE_TREE 生成前 validateKnowledgeTree fail-fast；仅知识点级
 *     code 可打标（考点级不可）；code 归属模块必须与题目模块一致（跨模块 code 非法）。
 *   - 按题原子：一题 code 集为空或 >5 个、或任一 code 非法 → 整题跳过记 error issue，
 *     不写半截（与 vision 回写同哲学）。
 *   - 幂等重打（替换语义）：每题先 upsert 新集合 pair（tag_version=运行号、
 *     source='ai'），再删该题不在新集合内的旧 pair——重跑同 staging 零变化，
 *     树演进后重打自动清旧标。
 *   - import_runs 行记 version 与打标 stats（与 db 命令共用 version 空间全局递增）。
 *   - 无可吸收产物（staging 为空或全部跳过）→ 不写文件不记 import_runs
 *     （sql/sqlPath 为空串；issues 仍随返回值带出供 CLI 报告）。
 * SQL 文本规范与 db 阶段一致：字符串字面量 ' → '' 转义、每语句一行以 ';' 结尾、
 * 时间一律 strftime 库端表达式、无时间戳字面量与绝对路径、不写事务。
 * 安全：products 根为受信目录（CLI 显式指定），staging 与产物的全部读写路径经
 * resolveWithin 界内校验（SQL 固定写回 <产物目录>/tag.sql，不做任意路径输出）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { XINGCE_KNOWLEDGE_TREE, validateKnowledgeTree } from '@ncse/shared'
import { UPDATED_AT, issue, moduleIdExpr, qualityGatedQids, questionModuleIndex, sqlString } from './db-stage.js'
import { resolveWithin } from './pipeline.js'
import type { ImportIssue, TagStageOptions, TagStageResult, TagStageStats } from './types.js'

/** 每题知识点 code 数上限（下限 1：空集即跳过） */
const MAX_CODES_PER_QUESTION = 5

/**
 * 执行一次打标吸收：读 staging → 逐题校验（qid 存在 / code 属该模块知识点级 / 数量 1–5）
 * → 生成 SQL（upsert 新集合 + 每题替换清理 + import_runs 行）→ 写 tag.sql。
 * 同 staging + 同 version 逐字节确定；问题按 qid 字典序收集。
 */
export function runTagStage(options: TagStageOptions): TagStageResult {
  const productsRoot = path.resolve(options.productsDir)
  const problems = validateKnowledgeTree(XINGCE_KNOWLEDGE_TREE)
  if (problems.length > 0) {
    throw new Error(`知识点树校验失败：${problems.join('；')}`)
  }

  // 模块 → 该模块知识点级 code 集（考点级不可打标；题目侧 code 合法性据此判定）
  const pointCodesByModule = new Map<string, Set<string>>()
  for (const entry of XINGCE_KNOWLEDGE_TREE) {
    const codes = new Set<string>()
    for (const topic of entry.topics) {
      for (const point of topic.points) codes.add(point.code)
    }
    pointCodesByModule.set(entry.module, codes)
  }

  // qid → 模块（产物读取在 db-stage 侧做结构校验，坏结构抛 InvalidProductsError 由 CLI 转 1）
  const moduleByQid = questionModuleIndex(productsRoot)
  // 数据质量门跳过集：这些题在产物中存在但不进 SQL（DB 无行，pair 子查询会解析为
  // NULL 违反 NOT NULL）——warning 级跳过（非打分子代理过错，批次生成侧亦应过滤）
  const gatedQids = qualityGatedQids(productsRoot)

  // staging 清单（tag-in/*.txt；目录缺失 = 空 staging），qid 字典序确定性处理
  const stagingDir = resolveWithin(productsRoot, 'tag-in')
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
  const stats: TagStageStats = { taggedQuestions: 0, tagPairs: 0, skippedQuestions: 0 }
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
        issue('error', 'tag_staging_unreadable', `tag-in/${file}`, qid, `staging 文件读取失败：${err instanceof Error ? err.message : String(err)}`),
      )
      stats.skippedQuestions++
      continue
    }
    digestParts.push(`${file}\n${text}`)

    if (gatedQids.has(qid)) {
      issues.push(
        issue('warning', 'tag_gated_qid', `tag-in/${file}`, qid, `题目 qid=${qid} 被数据质量门跳过未入库，打标记跳`),
      )
      stats.skippedQuestions++
      continue
    }

    const module = moduleByQid.get(qid)
    if (module === undefined) {
      issues.push(
        issue('error', 'tag_unknown_qid', `tag-in/${file}`, qid, `题目 qid=${qid} 不在模块产物中（未知或已被质量门跳过）`),
      )
      stats.skippedQuestions++
      continue
    }

    // code 解析：行级 trim、去空行、保序去重
    const codes: string[] = []
    for (const raw of text.split('\n')) {
      const code = raw.trim()
      if (code.length > 0 && !codes.includes(code)) codes.push(code)
    }
    if (codes.length === 0 || codes.length > MAX_CODES_PER_QUESTION) {
      issues.push(
        issue(
          'error',
          'tag_count_invalid',
          `tag-in/${file}`,
          qid,
          `题目 qid=${qid} 的知识点 code 数量非法（${codes.length} 个，须 1–${MAX_CODES_PER_QUESTION} 个）`,
        ),
      )
      stats.skippedQuestions++
      continue
    }
    const validCodes = pointCodesByModule.get(module) ?? new Set<string>()
    const invalidCode = codes.find((code) => !validCodes.has(code))
    if (invalidCode !== undefined) {
      issues.push(
        issue(
          'error',
          'tag_code_invalid',
          `tag-in/${file}`,
          qid,
          `题目 qid=${qid} 的知识点 code 非法（不属于模块 ${module} 的知识点级 code）：${invalidCode}`,
        ),
      )
      stats.skippedQuestions++
      continue
    }

    for (const code of codes) {
      statements.push(
        `INSERT INTO question_knowledge (question_id, knowledge_point_id, tag_version, source) VALUES ((SELECT id FROM questions WHERE qid=${sqlString(qid)}), (SELECT id FROM knowledge_points WHERE module_id=${moduleIdExpr(module)} AND code=${sqlString(code)}), ${options.version}, 'ai') ON CONFLICT(question_id, knowledge_point_id) DO UPDATE SET tag_version=excluded.tag_version, source=excluded.source, ${UPDATED_AT}`,
      )
    }
    // 替换清理：删该题不在新集合内的旧 pair（幂等重打语义；与 upsert 同批执行）
    const newPairIds = codes
      .map((code) => `(SELECT id FROM knowledge_points WHERE module_id=${moduleIdExpr(module)} AND code=${sqlString(code)})`)
      .join(', ')
    statements.push(
      `DELETE FROM question_knowledge WHERE question_id=(SELECT id FROM questions WHERE qid=${sqlString(qid)}) AND knowledge_point_id NOT IN (${newPairIds})`,
    )
    stats.taggedQuestions++
    stats.tagPairs += codes.length
  }

  // 无可吸收产物：不写文件不记 import_runs（issues 仍带出；错误由 CLI 报告并退 1）
  if (stats.taggedQuestions === 0) {
    return { sql: '', sqlPath: '', stats, inputDigest: '', issues }
  }

  const inputDigest = crypto.createHash('sha256').update(digestParts.join('\n'), 'utf8').digest('hex')
  const runRow = `INSERT INTO import_runs (version, status, input_digest, stats, finished_at) VALUES (${options.version}, 'success', ${sqlString(inputDigest)}, ${sqlString(JSON.stringify(stats))}, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(version) DO UPDATE SET status='success', input_digest=excluded.input_digest, stats=excluded.stats, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${UPDATED_AT}`
  statements.push(runRow)

  const header = `-- ncse 打标入库 SQL：version=${options.version}，吸收自 tag-in/ staging（幂等，可重复执行）`
  const sql = [header, ...statements.map((statement) => `${statement};`)].join('\n') + '\n'
  const sqlPath = resolveWithin(productsRoot, 'tag.sql')
  fs.writeFileSync(sqlPath, sql, 'utf8')
  return { sql, sqlPath, stats, inputDigest, issues }
}
