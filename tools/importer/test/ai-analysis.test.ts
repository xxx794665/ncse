/**
 * AI 解析吸收阶段测试（M3/T3-01g）：ai-in/ staging → runAiStage 生成确定性幂等
 * ai-analysis.sql，在 node:sqlite 内存库中先按文件名序整文件 exec apps/api 的全部
 * 迁移（同时验证迁移在原生 SQLite 可执行），再 exec runDbStage 的种子 SQL 与生成
 * 的 AI 解析 SQL，断言 question_ai_analysis 行语义（content/ai_version/一对一）、
 * 幂等重放（行数与内容不变）、字节确定性、version 覆盖语义（重新生成 = 版本覆盖、
 * 重吸收以最新 staging 为准）、按题原子跳过（未知 qid error / 空白 warning /
 * 质量门 warning）、多行内容与特殊字符逐字节还原、CRLF 规范化与 CLI 退出码。
 * 夹具全部为合成虚构题目；产物与 SQL 写入系统临时目录，测试后清理。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAiStage } from '../src/ai-stage.js'
import { runDbStage, questionModuleIndex } from '../src/db-stage.js'
import { main } from '../src/main.js'
import { runImport } from '../src/pipeline.js'
import type { AiStageResult } from '../src/types.js'

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))
const cleanInput = path.join(fixturesDir, 'clean-input')
const errorInput = path.join(fixturesDir, 'error-input')
/** apps/api 迁移目录（本测试文件位于 tools/importer/test，仓库根为其上三级） */
const migrationsDir = fileURLToPath(new URL('../../../apps/api/migrations', import.meta.url))

// 模块加载即建临时目录并产出夹具产物：describe 体在 beforeAll 之前执行，会引用产物路径
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncse-importer-ai-'))
const cleanProducts = path.join(outDir, 'clean-products')
const errorProducts = path.join(outDir, 'error-products')
runImport({ inputDir: cleanInput, outputDir: cleanProducts, version: 'v-ai' })
runImport({ inputDir: errorInput, outputDir: errorProducts, version: 'v-ai-err' })

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 建内存库并按文件名序整文件执行全部迁移（同时验证迁移在原生 SQLite 可执行） */
function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
  expect(files.length).toBeGreaterThanOrEqual(2)
  for (const name of files) {
    db.exec(fs.readFileSync(path.join(migrationsDir, name), 'utf8'))
  }
  return db
}

/** 建库并铺种子（runDbStage version=1：分类体系 + 12 题 + 知识点种子），返回已铺种的库 */
function createSeededDb(): DatabaseSync {
  const db = createDb()
  db.exec(runDbStage({ productsDir: cleanProducts, version: 1 }).sql)
  return db
}

/** 查询并映射为普通对象（node:sqlite 返回 null 原型记录，转普通对象便于 toEqual） */
function rows<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as T[]
}

/** qid → 模块（与被测实现同一索引口径，动态挑选夹具题，避免硬编码 qid） */
const moduleByQid = questionModuleIndex(cleanProducts)
/** 夹具覆盖的模块清单（Map 首见序去重） */
const fixtureModules = [...new Set(moduleByQid.values())]

/** 指定模块的第一个夹具 qid */
function firstQidOf(module: string): string {
  for (const [qid, code] of moduleByQid) {
    if (code === module) return qid
  }
  throw new Error(`夹具产物中无模块 ${module} 的题目`)
}

/** 写 staging（键 qid → 文件全文；多行讲解正文） */
function writeAiStaging(productsRoot: string, entries: Record<string, string>): void {
  const stagingDir = path.join(productsRoot, 'ai-in')
  fs.mkdirSync(stagingDir, { recursive: true })
  for (const [qid, content] of Object.entries(entries)) {
    fs.writeFileSync(path.join(stagingDir, `${qid}.txt`), content, 'utf8')
  }
}

/** AI 解析行视图：qid + content + ai_version（序 = qid 字典序） */
const analysisRows = (db: DatabaseSync): Array<{ qid: string; content: string; ai_version: number }> =>
  rows(
    db,
    `SELECT q.qid AS qid, a.content AS content, a.ai_version AS ai_version
     FROM question_ai_analysis a
     JOIN questions q ON q.id = a.question_id
     ORDER BY q.qid`,
  )

describe('AI 解析吸收（M3/T3-01g，ai-in/ staging → 幂等 ai-analysis.sql）', () => {
  beforeEach(() => {
    // 每用例独立 staging（目录整体清空）
    fs.rmSync(path.join(cleanProducts, 'ai-in'), { recursive: true, force: true })
  })

  it('合法吸收：多题多行讲解落行（content 逐字节还原、ai_version 挂对、一对一），import_runs 行记 AI 解析统计', () => {
    expect(fixtureModules.length).toBeGreaterThanOrEqual(2)
    const qidA = firstQidOf(fixtureModules[0])
    const qidB = firstQidOf(fixtureModules[1])
    const contentA = '方法论：这是一道概念判断题。\n\n切入点：先抓题干限定词，再逐项排除。\n易错点：偷换概念。'
    const contentB = '多角度讲解：正确项与题干形成完整因果链。\n干扰项错在范围扩大。'
    writeAiStaging(cleanProducts, { [qidA]: contentA, [qidB]: contentB })

    const result = runAiStage({ productsDir: cleanProducts, version: 9 })
    expect(result.stats).toEqual({ analyzedQuestions: 2, skippedQuestions: 0 })
    expect(result.issues).toEqual([])

    const db = createSeededDb()
    db.exec(result.sql)
    // 行视图按 qid BINARY 字典序（ORDER BY q.qid），期望同序排序
    expect(analysisRows(db)).toEqual(
      [
        { qid: qidA, content: contentA, ai_version: 9 },
        { qid: qidB, content: contentB, ai_version: 9 },
      ].sort((left, right) => (left.qid < right.qid ? -1 : 1)),
    )
    // 一对一：每题恰一行（qid 唯一索引语义）
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM question_ai_analysis')).toEqual([{ n: 2 }])
    const runs = rows<{ version: number; stats: string }>(db, 'SELECT version, stats FROM import_runs')
    const aiRun = runs.find((run) => run.version === 9)
    expect(JSON.parse(aiRun?.stats ?? '{}')).toEqual({ analyzedQuestions: 2, skippedQuestions: 0 })
    db.close()
  })

  it('未知 qid：整题跳过记 ai_unknown_qid，同批合法题照常吸收', () => {
    const moduleA = fixtureModules[0]
    const qidA = firstQidOf(moduleA)
    writeAiStaging(cleanProducts, { 'ai-unknown-qid': '讲解\n', [qidA]: '讲解正文\n' })

    const result = runAiStage({ productsDir: cleanProducts, version: 9 })
    expect(result.stats).toEqual({ analyzedQuestions: 1, skippedQuestions: 1 })
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ severity: 'error', code: 'ai_unknown_qid', qid: 'ai-unknown-qid' })

    const db = createSeededDb()
    db.exec(result.sql)
    expect(analysisRows(db)).toEqual([{ qid: qidA, content: '讲解正文', ai_version: 9 }])
    db.close()
  })

  it('空文件与全空白文件：warning 级跳过（ai_analysis_empty），不写半截；同批合法题照常吸收', () => {
    const qids = fixtureModules.slice(0, 2).map((code) => firstQidOf(code))
    const [emptyQid, blankQid] = qids
    const validQid = [...moduleByQid.keys()].find((qid) => !qids.includes(qid))
    expect(validQid).toBeDefined()
    writeAiStaging(cleanProducts, {
      [emptyQid]: '',
      [blankQid]: '\n  \n\t\n',
      [validQid as string]: '合法讲解\n',
    })

    const result = runAiStage({ productsDir: cleanProducts, version: 9 })
    expect(result.stats).toEqual({ analyzedQuestions: 1, skippedQuestions: 2 })
    expect(result.issues.map((entry) => entry.code)).toEqual(['ai_analysis_empty', 'ai_analysis_empty'])
    expect(result.issues.every((entry) => entry.severity === 'warning')).toBe(true)

    const db = createSeededDb()
    db.exec(result.sql)
    expect(analysisRows(db)).toEqual([{ qid: validQid, content: '合法讲解', ai_version: 9 }])
    db.close()
  })

  it('质量门跳过题：warning 级过滤（DB 无行防 NOT NULL 失败），同批合法题照常吸收', () => {
    // error 产物含门控 issue（severity error + 门控码）——取其 qid 造 staging（error 产物侧）
    const errorManifest = JSON.parse(fs.readFileSync(path.join(errorProducts, 'import-manifest.json'), 'utf8')) as {
      issues: Array<{ severity: string; code: string; qid: string | null }>
    }
    const gatingCodes = new Set(['answer_not_in_options', 'missing_answer', 'no_options', 'duplicate_option'])
    const gatedQid = errorManifest.issues.find(
      (entry) => entry.severity === 'error' && gatingCodes.has(entry.code) && entry.qid !== null,
    )?.qid
    expect(gatedQid).toBeDefined()
    const errorModuleByQid = questionModuleIndex(errorProducts)
    const errorGated = new Set(
      errorManifest.issues
        .filter((entry) => entry.severity === 'error' && gatingCodes.has(entry.code) && entry.qid !== null)
        .map((entry) => entry.qid as string),
    )
    const validQid = [...errorModuleByQid.keys()].find((qid) => !errorGated.has(qid))
    expect(validQid).toBeDefined()

    try {
      writeAiStaging(errorProducts, {
        [gatedQid as string]: '门控题讲解\n',
        [validQid as string]: '合法题讲解\n',
      })
      const result = runAiStage({ productsDir: errorProducts, version: 9 })
      expect(result.stats).toEqual({ analyzedQuestions: 1, skippedQuestions: 1 })
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0]).toMatchObject({ severity: 'warning', code: 'ai_gated_qid', qid: gatedQid })
      // 门控题不产生任何 SQL 语句（DB 无行，防 question_id 子查询 NULL 违反 NOT NULL）
      expect(result.sql).not.toContain(`qid=${gatedQid}`)
    } finally {
      fs.rmSync(path.join(errorProducts, 'ai-in'), { recursive: true, force: true })
    }
  })

  it('幂等重放：同一 ai-analysis.sql 再 exec → 行数与内容不变（id 不换行）', () => {
    const qidA = firstQidOf(fixtureModules[0])
    writeAiStaging(cleanProducts, { [qidA]: '第一段。\n\n第二段。\n' })
    const result = runAiStage({ productsDir: cleanProducts, version: 9 })

    const db = createSeededDb()
    db.exec(result.sql)
    const before = rows<{ id: number; qid: string; content: string; ai_version: number }>(
      db,
      `SELECT a.id AS id, q.qid AS qid, a.content AS content, a.ai_version AS ai_version
       FROM question_ai_analysis a JOIN questions q ON q.id = a.question_id`,
    )
    db.exec(result.sql)
    expect(
      rows<{ id: number; qid: string; content: string; ai_version: number }>(
        db,
        `SELECT a.id AS id, q.qid AS qid, a.content AS content, a.ai_version AS ai_version
         FROM question_ai_analysis a JOIN questions q ON q.id = a.question_id`,
      ),
    ).toEqual(before) // ON CONFLICT(question_id) 原地更新，不换行不重复（updated_at 会变，不断言）
    db.close()
  })

  it('字节确定性：同 staging 同 version 两次生成全等；语句恒单行（每行以 ; 结尾）；换 version 则 SQL 不同', () => {
    const qidA = firstQidOf(fixtureModules[0])
    writeAiStaging(cleanProducts, { [qidA]: '讲解第一段\n讲解第二段\n' })
    const a = runAiStage({ productsDir: cleanProducts, version: 9 })
    const b = runAiStage({ productsDir: cleanProducts, version: 9 })
    expect(b.sql).toBe(a.sql)
    expect(fs.readFileSync(a.sqlPath, 'utf8')).toBe(a.sql)
    expect(a.sql.startsWith('-- ncse AI 解析入库 SQL：version=9，吸收自 ai-in/ staging（幂等，可重复执行）\n')).toBe(true)
    expect(a.sql.endsWith('\n')).toBe(true)
    expect(a.sql.charCodeAt(0)).not.toBe(0xfeff)
    expect(a.sql).not.toContain('BEGIN')
    expect(a.sql).not.toContain('COMMIT')
    expect(a.sql).not.toContain(path.resolve(cleanProducts))
    // 每语句一行约定：首行为头注释，其余（除末尾空行）全部行以 ';' 结尾（多行内容经 char(10) 拼接单行化）
    const lines = a.sql.split('\n')
    expect(lines[lines.length - 1]).toBe('')
    for (const line of lines.slice(1, -1)) expect(line.endsWith(';')).toBe(true)

    const c = runAiStage({ productsDir: cleanProducts, version: 10 })
    expect(c.sql).not.toBe(a.sql)
  })

  it('版本覆盖语义：先 v5 内容甲、再 v9 内容乙 → 行被原地更新（content=乙、ai_version=9、无重复行）；同 version 重吸收以最新 staging 为准', () => {
    const qidA = firstQidOf(fixtureModules[0])
    writeAiStaging(cleanProducts, { [qidA]: '内容甲：旧版讲解。\n' })
    const first = runAiStage({ productsDir: cleanProducts, version: 5 })
    writeAiStaging(cleanProducts, { [qidA]: '内容乙：新版讲解。\n换角度再讲一遍。\n' })
    const second = runAiStage({ productsDir: cleanProducts, version: 9 })

    const db = createSeededDb()
    db.exec(first.sql)
    db.exec(second.sql)
    expect(analysisRows(db)).toEqual([
      { qid: qidA, content: '内容乙：新版讲解。\n换角度再讲一遍。', ai_version: 9 },
    ])
    // db 种子（version 1）与两次 AI 解析（5/9）各记一行 import_runs
    expect(rows<{ version: number }>(db, 'SELECT version FROM import_runs ORDER BY version').map((r) => r.version)).toEqual([1, 5, 9])
    db.close()

    // 同 version 重吸收：staging 内容再变更（不换版本号）→ 以最新 staging 为准
    writeAiStaging(cleanProducts, { [qidA]: '内容丙：同版本重吸收。\n' })
    const third: AiStageResult = runAiStage({ productsDir: cleanProducts, version: 9 })
    const db2 = createSeededDb()
    db2.exec(first.sql)
    db2.exec(second.sql)
    db2.exec(third.sql)
    expect(analysisRows(db2)).toEqual([{ qid: qidA, content: '内容丙：同版本重吸收。', ai_version: 9 }])
    db2.close()
  })

  it('特殊字符与空行：含单引号/分号/引号的多段内容逐字节还原（含空行）', () => {
    const qidA = firstQidOf(fixtureModules[0])
    const content = `方法论：设虚构变量 x; 满足 x' = "虚构值"。

第二段（空行在上）；半角分号; 与单引号''都须逐字节还原。
第三段。`
    writeAiStaging(cleanProducts, { [qidA]: content })

    const result = runAiStage({ productsDir: cleanProducts, version: 9 })
    const db = createSeededDb()
    db.exec(result.sql)
    expect(analysisRows(db)).toEqual([{ qid: qidA, content, ai_version: 9 }])
    db.close()
  })

  it('CRLF 规范化：staging 行尾 \\r\\n 与孤立 \\r 折叠为 \\n 入库', () => {
    const qidA = firstQidOf(fixtureModules[0])
    writeAiStaging(cleanProducts, { [qidA]: '第一行\r\n\r\n第二行\r第三行' })

    const result = runAiStage({ productsDir: cleanProducts, version: 9 })
    const db = createSeededDb()
    db.exec(result.sql)
    expect(analysisRows(db)).toEqual([{ qid: qidA, content: '第一行\n\n第二行\n第三行', ai_version: 9 }])
    db.close()
  })

  it('空 staging：ai-in 目录缺失 → sql 为空、不写文件、CLI 退出 0', async () => {
    const result = runAiStage({ productsDir: cleanProducts, version: 9 })
    expect(result.sql).toBe('')
    expect(result.sqlPath).toBe('')
    expect(result.stats).toEqual({ analyzedQuestions: 0, skippedQuestions: 0 })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await main(['ai-analysis', '--products', cleanProducts, '--version', '9'])).toBe(0)
  })

  it('全部跳过（仅空白文件）→ 不写文件（sql 空串）；CLI 退出 0（warning 不判失败）', async () => {
    const qidA = firstQidOf(fixtureModules[0])
    writeAiStaging(cleanProducts, { [qidA]: '   \n\t\n' })
    const result = runAiStage({ productsDir: cleanProducts, version: 9 })
    expect(result.sql).toBe('')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await main(['ai-analysis', '--products', cleanProducts, '--version', '9'])).toBe(0)
  })

  it('CLI 退出码：合法吸收 0；存在 error（未知 qid）→ 1；用法错误（缺 --version / version 非正整数 / products 不存在）→ 2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const qidA = firstQidOf(fixtureModules[0])
    writeAiStaging(cleanProducts, { 'ai-cli-unknown': '越界 qid 讲解\n', [qidA]: '合法讲解\n' })
    expect(await main(['ai-analysis', '--products', cleanProducts, '--version', '9'])).toBe(1)

    // 清掉未知 qid 文件后再吸收合法题（staging 只剩合法内容）
    fs.rmSync(path.join(cleanProducts, 'ai-in', 'ai-cli-unknown.txt'))
    expect(await main(['ai-analysis', '--products', cleanProducts, '--version', '9'])).toBe(0)

    expect(await main(['ai-analysis', '--products', cleanProducts])).toBe(2)
    expect(await main(['ai-analysis', '--products', cleanProducts, '--version'])).toBe(2)
    expect(await main(['ai-analysis', '--products', cleanProducts, '--version', 'abc'])).toBe(2)
    expect(await main(['ai-analysis', '--products', cleanProducts, '--version', '0'])).toBe(2)
    expect(await main(['ai-analysis', '--products', path.join(outDir, 'nope'), '--version', '1'])).toBe(2)
  })
})
