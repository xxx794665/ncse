/**
 * 入库阶段测试（T1-15）：runImport 产物 → runDbStage 生成确定性 SQL，
 * 在 node:sqlite 内存库中先按文件名序整文件 exec apps/api 的全部迁移
 * （`--> statement-breakpoint` 是合法 SQL 行注释，可整文件执行——同时验证迁移在
 * 原生 SQLite 可执行），再 exec 生成的 SQL，断言分类体系/题组/题目/import_runs、
 * 幂等重放、字节确定性、数据质量门与 SQL 字面量转义。
 * 夹具全部为合成虚构题目；产物与 SQL 写入系统临时目录，测试后清理。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { runDbStage, InvalidProductsError } from '../src/db-stage.js'
import { main } from '../src/main.js'
import { runImport } from '../src/pipeline.js'
import type { RichContent } from '@ncse/shared'
import type { ParsedGroup, ParsedPaper, ParsedQuestion } from '../src/types.js'

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))
const cleanInput = path.join(fixturesDir, 'clean-input')
const errorInput = path.join(fixturesDir, 'error-input')
/** apps/api 迁移目录（本测试文件位于 tools/importer/test，仓库根为其上三级） */
const migrationsDir = fileURLToPath(new URL('../../../apps/api/migrations', import.meta.url))

// 模块加载即建临时目录并产出两套夹具产物：describe 体在 beforeAll 之前执行，会引用产物路径
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncse-importer-db-'))
const cleanProducts = path.join(outDir, 'clean-products')
const errorProducts = path.join(outDir, 'error-products')
runImport({ inputDir: cleanInput, outputDir: cleanProducts, version: 'v-db' })
runImport({ inputDir: errorInput, outputDir: errorProducts, version: 'v-db-err' })

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
  expect(files.length).toBeGreaterThanOrEqual(2) // 0000 全量建表 + 0001 question_groups.source_key
  for (const name of files) {
    db.exec(fs.readFileSync(path.join(migrationsDir, name), 'utf8'))
  }
  return db
}

/** 查询并映射为普通对象（node:sqlite 返回 null 原型记录，转普通对象便于 toEqual） */
function rows<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as T[]
}

/** 产物模块 JSON → 试卷数组 */
function readPapers(productsRoot: string, module: string): ParsedPaper[] {
  const raw = fs.readFileSync(path.join(productsRoot, 'modules', `${module}.json`), 'utf8')
  return (JSON.parse(raw) as { papers: ParsedPaper[] }).papers
}

/** 产物中的全部题目 qid（六个模块汇总，排序保证稳定） */
function productQids(productsRoot: string): string[] {
  const qids: string[] = []
  for (const name of fs.readdirSync(path.join(productsRoot, 'modules'))) {
    if (!name.endsWith('.json')) continue
    for (const paper of readPapers(productsRoot, name.replace(/\.json$/, ''))) {
      qids.push(...paper.items.flatMap((item) => ('qid' in item ? [item.qid] : [])))
    }
  }
  return qids.sort()
}

/** 按模块与 qid 找产物题目 */
function findQuestion(productsRoot: string, module: string, qid: string): ParsedQuestion | undefined {
  for (const paper of readPapers(productsRoot, module)) {
    for (const item of paper.items) {
      if ('qid' in item && item.qid === qid) return item
    }
  }
  return undefined
}

/** 按 source_key 找产物题组 */
function findGroupBySourceKey(productsRoot: string, module: string, sourceKey: string): ParsedGroup | undefined {
  for (const paper of readPapers(productsRoot, module)) {
    for (const item of paper.items) {
      if (!('qid' in item) && `${paper.file}#${item.index}` === sourceKey) return item
    }
  }
  return undefined
}

describe('clean 产物：SQL 执行与数据断言', () => {
  it('分类体系 upsert：exam_types 1 / subjects 1 / modules 6（code 与 sortOrder）', () => {
    const db = createDb()
    const result = runDbStage({
      productsDir: cleanProducts,
      version: 1,
    })
    db.exec(result.sql)
    expect(rows<{ code: string; name: string }>(db, 'SELECT code, name FROM exam_types')).toEqual([
      { code: 'civil_service', name: '公务员' },
    ])
    expect(rows<{ code: string; name: string }>(db, 'SELECT code, name FROM subjects')).toEqual([
      { code: 'xingce', name: '行测' },
    ])
    expect(
      rows<{ code: string; sort_order: number }>(db, 'SELECT code, sort_order FROM modules ORDER BY sort_order'),
    ).toEqual([
      { code: 'political_theory', sort_order: 1 },
      { code: 'common_sense', sort_order: 2 },
      { code: 'verbal', sort_order: 3 },
      { code: 'quantitative', sort_order: 4 },
      { code: 'judgement', sort_order: 5 },
      { code: 'data_analysis', sort_order: 6 },
    ])
    db.close()
  })

  it('题目 12 行：qid 集合 / stem JSON 列 / answer / group 链接 / vision_text / difficulty 缺省', () => {
    const db = createDb()
    const result = runDbStage({
      productsDir: cleanProducts,
      version: 1,
    })
    db.exec(result.sql)
    const qids = rows<{ qid: string }>(db, 'SELECT qid FROM questions ORDER BY qid').map((row) => row.qid)
    expect(qids).toEqual(productQids(cleanProducts))
    expect(qids).toHaveLength(12)

    // 抽查 900601：题组题，全部业务列与产物对齐
    const row = rows<{
      stem: string
      options: string
      analysis: string
      answer: string
      kind: string
      vision_text: string
      group_id: number
      difficulty: null
      year: number
      region: string
      paper_type: string
    }>(db, "SELECT stem, options, analysis, answer, kind, vision_text, group_id, difficulty, year, region, paper_type FROM questions WHERE qid='900601'")[0]
    const product = findQuestion(cleanProducts, 'data_analysis', '900601')
    expect(product).toBeDefined()
    expect(JSON.parse(row.stem)).toEqual(product?.stem)
    expect(JSON.parse(row.options)).toEqual(product?.options)
    expect(JSON.parse(row.analysis)).toEqual(product?.analysis)
    expect(row.answer).toBe('B')
    expect(row.kind).toBe('single_choice')
    expect(row.vision_text).toBe('')
    expect(row.difficulty).toBeNull() // 难度未标定不写
    expect(row.year).toBe(2024)
    expect(row.region).toBe('虚构省')
    expect(row.paper_type).toBe('省考')
    // group 链接：group_id 指向己卷材料 1 的组
    expect(row.group_id).not.toBeNull()
    const group = rows<{ source_key: string }>(db, 'SELECT source_key FROM question_groups WHERE id = ?', row.group_id)[0]
    expect(group.source_key).toBe('06-资料分析/2024年某省公务员录用考试《行测》题（虚构己卷）.md#1')

    // 常识组内两题挂同一题组；独立题（政治 900101）group_id 为 NULL
    const pair = rows<{ qid: string; group_id: number }>(
      db,
      "SELECT qid, group_id FROM questions WHERE qid IN ('900201','900202') ORDER BY qid",
    )
    expect(pair[0].group_id).toBe(pair[1].group_id)
    expect(pair[0].group_id).not.toBeNull()
    const independent = rows<{ group_id: number | null }>(db, "SELECT group_id FROM questions WHERE qid='900101'")[0]
    expect(independent.group_id).toBeNull()
    db.close()
  })

  it('题组 3 行：source_key / material JSON 列 / 来源元数据', () => {
    const db = createDb()
    const result = runDbStage({
      productsDir: cleanProducts,
      version: 1,
    })
    db.exec(result.sql)
    const groups = rows<{
      source_key: string
      material: string
      year: number | null
      region: string | null
      paper_type: string | null
    }>(db, 'SELECT source_key, material, year, region, paper_type FROM question_groups')
    expect(groups.map((group) => group.source_key).sort()).toEqual([
      '02-常识判断/2024年某市公务员录用考试《行测》题（虚构乙卷）.md#1',
      '06-资料分析/2024年某省公务员录用考试《行测》题（虚构己卷）.md#1',
      '06-资料分析/2024年某省公务员录用考试《行测》题（虚构己卷）.md#2',
    ])
    // material JSON 列与产物 deep equal（抽查两个模块的组）
    for (const sourceKey of groups.map((group) => group.source_key)) {
      const module = sourceKey.startsWith('02-') ? 'common_sense' : 'data_analysis'
      const product = findGroupBySourceKey(cleanProducts, module, sourceKey)
      expect(product).toBeDefined()
      const row = groups.find((group) => group.source_key === sourceKey)
      if (row === undefined) throw new Error(`组行缺失：${sourceKey}`)
      expect(JSON.parse(row.material)).toEqual(product?.material)
      expect(row.year).toBe(product?.year ?? null)
      expect(row.region).toBe(product?.region ?? null)
      expect(row.paper_type).toBe(product?.paperType ?? null)
    }
    db.close()
  })

  it('import_runs 1 行：version / input_digest / stats / status', () => {
    const db = createDb()
    const result = runDbStage({
      productsDir: cleanProducts,
      version: 5,
    })
    db.exec(result.sql)
    const runs = rows<{ version: number; status: string; input_digest: string; stats: string }>(
      db,
      'SELECT version, status, input_digest, stats FROM import_runs',
    )
    expect(runs).toHaveLength(1)
    expect(runs[0].version).toBe(5)
    expect(runs[0].status).toBe('success')
    expect(runs[0].input_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(runs[0].input_digest).toBe(result.inputDigest)
    expect(JSON.parse(runs[0].stats)).toEqual({ questions: 12, questionGroups: 3, images: 0, knowledgePoints: 0 })
    expect(result.stats).toEqual({ questions: 12, questionGroups: 3, images: 0, knowledgePoints: 0 })
    db.close()
  })

  it('幂等：同一份 SQL 再 exec 一遍 → 行数不变、qid 集合不变、题组 id 不变', () => {
    const db = createDb()
    const result = runDbStage({
      productsDir: cleanProducts,
      version: 1,
    })
    db.exec(result.sql)
    const snapshot = (): { questions: string[]; groups: Array<{ id: number; source_key: string }> } => ({
      questions: rows<{ qid: string }>(db, 'SELECT qid FROM questions ORDER BY qid').map((row) => row.qid),
      groups: rows<{ id: number; source_key: string }>(db, 'SELECT id, source_key FROM question_groups ORDER BY id').map(
        (row) => ({ id: row.id, source_key: row.source_key }),
      ),
    })
    const before = snapshot()
    db.exec(result.sql)
    expect(snapshot()).toEqual(before) // ON CONFLICT 原地更新，不换行（updated_at 会变，不断言）
    db.close()
  })

  it('确定性：同产物 + 同 version 两次生成 → SQL 全等；不同 version 只影响头部注释与 import_runs 行', () => {
    const a = runDbStage({ productsDir: cleanProducts, version: 3 })
    const b = runDbStage({ productsDir: cleanProducts, version: 3 })
    expect(b.sql).toBe(a.sql)
    // 落盘文件与返回文本逐字节一致；头部注释、以换行结尾、无 BOM/事务语句/绝对路径
    expect(fs.readFileSync(a.sqlPath, 'utf8')).toBe(a.sql)
    expect(a.sql.startsWith('-- ncse 导入入库 SQL：version=3，生成自 import-manifest.json（幂等，可重复执行）\n')).toBe(true)
    expect(a.sql.endsWith('\n')).toBe(true)
    expect(a.sql.charCodeAt(0)).not.toBe(0xfeff)
    expect(a.sql).not.toContain('BEGIN')
    expect(a.sql).not.toContain('COMMIT')
    expect(a.sql).not.toContain(path.resolve(cleanProducts))

    const c = runDbStage({ productsDir: cleanProducts, version: 4 })
    const aLines = a.sql.split('\n')
    const cLines = c.sql.split('\n')
    expect(cLines).toHaveLength(aLines.length)
    const importRunsIndex = aLines.findIndex((line) => line.startsWith('INSERT INTO import_runs '))
    expect(importRunsIndex).toBeGreaterThan(0)
    const diffIndexes: number[] = []
    for (let index = 0; index < aLines.length; index++) {
      if (aLines[index] !== cLines[index]) diffIndexes.push(index)
    }
    // version 只出现在头部注释与 import_runs 语句两行（文件字节确定性的另一面）
    expect(diffIndexes).toEqual([0, importRunsIndex])
  })
})

describe('数据质量门（error 产物）', () => {
  it('默认模式：门控题目不入库，其余题目为独立题，全灭组不生成', () => {
    const db = createDb()
    const result = runDbStage({
      productsDir: errorProducts,
      version: 1,
    })
    expect(result.skippedQids.sort()).toEqual(['800101', '800103'])
    db.exec(result.sql)
    expect(result.stats.questions).toBe(4)
    const qids = rows<{ qid: string }>(db, 'SELECT qid FROM questions ORDER BY qid').map((row) => row.qid)
    // 800101（答案不在选项）、800103（缺答案）被门控；其余全部入库
    expect(qids).toEqual(['800102', '800105', '800203', '800401'])
    // 孤儿题 800203 按独立题处理，group_id 为 NULL；去重首见/其余独立题同为 NULL
    const linked = rows<{ group_id: number | null }>(db, 'SELECT group_id FROM questions')
    expect(linked.every((row) => row.group_id === null)).toBe(true)
    // 虚构错误卷五 材料 1 的 questionQids 全被去重丢弃 → 组不生成
    expect(rows<{ id: number }>(db, 'SELECT id FROM question_groups')).toHaveLength(0)
    expect(result.stats.questionGroups).toBe(0)
    db.close()
  })

  it('--force：门控题目全量导入，答案原样保留', () => {
    const db = createDb()
    const result = runDbStage({
      productsDir: errorProducts,
      version: 1,
      force: true,
    })
    expect(result.skippedQids).toEqual([])
    db.exec(result.sql)
    expect(result.stats.questions).toBe(6)
    const qids = rows<{ qid: string }>(db, 'SELECT qid FROM questions ORDER BY qid').map((row) => row.qid)
    expect(qids).toEqual(['800101', '800102', '800103', '800105', '800203', '800401'])
    const answers = new Map(
      rows<{ qid: string; answer: string }>(db, 'SELECT qid, answer FROM questions').map((row) => [row.qid, row.answer]),
    )
    expect(answers.get('800101')).toBe('甲')
    expect(answers.get('800103')).toBe('')
    db.close()
  })
})

describe('SQL 字面量转义（夹具题干含 ASCII 分号/单引号/双引号/换行）', () => {
  it('900604 题干入库后逐字节还原', () => {
    const db = createDb()
    const result = runDbStage({
      productsDir: cleanProducts,
      version: 1,
    })
    db.exec(result.sql)
    const row = rows<{ stem: string }>(db, "SELECT stem FROM questions WHERE qid='900604'")[0]
    const product = findQuestion(cleanProducts, 'data_analysis', '900604')
    expect(product).toBeDefined()
    expect(JSON.parse(row.stem)).toEqual(product?.stem)
    const stem = JSON.parse(row.stem) as RichContent
    expect(stem).toHaveLength(3) // 三行题干 → 三个文本段（换行经段落边界保留）
    const text = stem.map((segment) => (segment.type === 'text' ? segment.text : '')).join('\n')
    expect(text).toContain(`设虚构变量 x; 满足 x' = "虚构值"，且 y'' = "另一个'虚构'值"。`)
    expect(text).toContain(`含特殊字符的第三行; 单引号'、双引号"与半角分号; 必须逐字节还原（SQL 转义压力测试）。`)
    // SQL 文本中单引号以 '' 转义出现
    expect(result.sql).toContain("''")
    db.close()
  })
})

describe('产物结构无效（InvalidProductsError）', () => {
  it('manifest 缺失 / 模块 JSON 损坏 → 抛 InvalidProductsError', () => {
    const empty = path.join(outDir, 'empty-products')
    fs.mkdirSync(empty, { recursive: true })
    expect(() =>
      runDbStage({ productsDir: empty, version: 1 }),
    ).toThrow(InvalidProductsError)
    const corrupt = path.join(outDir, 'corrupt-products')
    fs.cpSync(cleanProducts, corrupt, { recursive: true })
    fs.writeFileSync(path.join(corrupt, 'modules', 'verbal.json'), '{oops', 'utf8')
    expect(() =>
      runDbStage({ productsDir: corrupt, version: 1 }),
    ).toThrow(InvalidProductsError)
  })
})

describe('CLI db 子命令（main）', () => {
  const spyConsole = (): void => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  it('用法错误 → 2（缺参数、version 非正整数、products 目录不存在）', async () => {
    spyConsole()
    expect(await main(['db'])).toBe(2)
    expect(await main(['db', '--products', cleanProducts])).toBe(2)
    expect(await main(['db', '--products', cleanProducts, '--version'])).toBe(2)
    expect(await main(['db', '--products', cleanProducts, '--version', 'abc'])).toBe(2)
    expect(await main(['db', '--products', cleanProducts, '--version', '0'])).toBe(2)
    expect(await main(['db', '--products', path.join(outDir, 'no-such-products'), '--version', '3'])).toBe(2)
  })

  it('clean 产物 → 0 且 SQL 落盘至产物目录 import.sql', async () => {
    spyConsole()
    expect(await main(['db', '--products', cleanProducts, '--version', '3'])).toBe(0)
    const sqlPath = path.join(cleanProducts, 'import.sql')
    expect(fs.existsSync(sqlPath)).toBe(true)
    expect(fs.readFileSync(sqlPath, 'utf8')).toContain('-- ncse 导入入库 SQL：version=3')
  })

  it('error 产物默认 → 0（跳过质量问题题目不是失败）；产物结构无效 → 1', async () => {
    spyConsole()
    expect(await main(['db', '--products', errorProducts, '--version', '3'])).toBe(0)
    expect(await main(['db', '--products', path.join(outDir, 'empty-products'), '--version', '3'])).toBe(1)
  })
})
