/**
 * 入库阶段测试（T1-15）：runImport 产物 → runDbStage 生成确定性 SQL，
 * 在 node:sqlite 内存库中先按文件名序整文件 exec apps/api 的全部迁移
 * （`--> statement-breakpoint` 是合法 SQL 行注释，可整文件执行——同时验证迁移在
 * 原生 SQLite 可执行），再 exec 生成的 SQL，断言分类体系/题组/题目/import_runs、
 * 幂等重放、字节确定性、数据质量门与 SQL 字面量转义。
 * T1-05 阶段 B 增 stats.images 断言：实际进 SQL 的 image 段 path 去重计数
 * （clean 夹具含 ../90-图片 引用与公式图；另造 img/ 键重写产物验证去重口径）。
 * T2-01a/ADR-0012 增试卷归属断言：papers/question_papers upsert 与幂等（paper-input
 * 合成夹具：跨模块同名卷聚合 + 跨卷重复 qid 双卷归属）、质量门跳过 pair 与
 * paper_question_skipped warning、孤儿 pair/卷清理、papers.json 缺失
 * （paper_manifest_missing → 退出码 1）与 stats.papers/questionPapers 计数。
 * T2-01b 增蓝图种子断言：blueprints/blueprint_modules 幂等 upsert（对照
 * XINGCE_BLUEPRINTS 精确一致）与孤儿清理（先明细后主表、限定行测科目）、独立自包含
 * blueprints.sql（语句与 import.sql 对应段逐字节一致，干净库单独重放幂等）、
 * blueprintSeedStatements 注入假目录的 validateBlueprint 失败路径，
 * stats 增 blueprints/blueprintModules 计数。
 * M3/T3-01a 增知识点种子断言：knowledge_points 两级树幂等 upsert（对照
 * XINGCE_KNOWLEDGE_TREE 精确一致）与孤儿清理（限定行测六模块、级联连带删打标行）、
 * 独立自包含 knowledge.sql（与 import.sql 对应段逐字节一致，干净库单独重放幂等）、
 * knowledgeSeedStatements 注入假树的 validateKnowledgeTree 失败路径，
 * stats.knowledgePoints 计数。
 * 夹具全部为合成虚构题目；产物与 SQL 写入系统临时目录，测试后清理。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { runDbStage, blueprintSeedStatements, knowledgeSeedStatements, InvalidProductsError } from '../src/db-stage.js'
import { main } from '../src/main.js'
import { runImport, resolveWithin } from '../src/pipeline.js'
import { XINGCE_BLUEPRINTS, XINGCE_KNOWLEDGE_TREE } from '@ncse/shared'
import type { ExamBlueprint, RichContent } from '@ncse/shared'
import type { ParsedGroup, ParsedPaper, ParsedQuestion } from '../src/types.js'

/** 知识点种子行数（考点+知识点合计，与 shared 树常量同步；stats 断言用） */
const KNOWLEDGE_SEED_ROWS = XINGCE_KNOWLEDGE_TREE.reduce(
  (sum, entry) => sum + entry.topics.reduce((topicSum, topic) => topicSum + 1 + topic.points.length, 0),
  0,
)

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))
const cleanInput = path.join(fixturesDir, 'clean-input')
const errorInput = path.join(fixturesDir, 'error-input')
const paperInput = path.join(fixturesDir, 'paper-input')
/** apps/api 迁移目录（本测试文件位于 tools/importer/test，仓库根为其上三级） */
const migrationsDir = fileURLToPath(new URL('../../../apps/api/migrations', import.meta.url))

// 模块加载即建临时目录并产出三套夹具产物：describe 体在 beforeAll 之前执行，会引用产物路径
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncse-importer-db-'))
const cleanProducts = path.join(outDir, 'clean-products')
const errorProducts = path.join(outDir, 'error-products')
const paperProducts = path.join(outDir, 'paper-products')
runImport({ inputDir: cleanInput, outputDir: cleanProducts, version: 'v-db' })
runImport({ inputDir: errorInput, outputDir: errorProducts, version: 'v-db-err' })
runImport({ inputDir: paperInput, outputDir: paperProducts, version: 'v-paper' })

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

/** 把产物模块 JSON 的 image 段 path 原位映射为内容寻址键形态（模拟 images 阶段重写后的产物） */
function rewriteImagePaths(productsRoot: string, map: (path: string) => string): void {
  for (const name of fs.readdirSync(path.join(productsRoot, 'modules'))) {
    if (!name.endsWith('.json')) continue
    // 写入侧派生路径一律经 resolveWithin 界内校验（与源码同一防线，CWE-22）
    const modulePath = resolveWithin(productsRoot, `modules/${name}`)
    const root = JSON.parse(fs.readFileSync(modulePath, 'utf8')) as {
      papers: ParsedPaper[]
    }
    for (const paper of root.papers) {
      for (const item of paper.items) {
        const hosts = 'qid' in item
          ? [item.stem, item.analysis, ...item.options.map((option) => option.content)]
          : [item.material]
        for (const content of hosts) {
          for (const segment of content) {
            if (segment.type === 'image') segment.path = map(segment.path)
          }
        }
      }
    }
    fs.writeFileSync(modulePath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
  }
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

  it('import_runs 1 行：version / input_digest / stats / status（含 images 去重计数）', () => {
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
    // images：clean 夹具实际进 SQL 的 image 段 path 去重 = 13（见下方图片统计用例的逐项清点）；
    // papers/questionPapers：clean 夹具 7 卷名各自唯一、无质量门跳过 → 7 卷 12 pair；
    // blueprints/blueprintModules：T2-01b 种子恒为 XINGCE_BLUEPRINTS（2 卷型 × 六模块）；
    // knowledgePoints：M3/T3-01a 种子恒为 XINGCE_KNOWLEDGE_TREE 节点数（考点+知识点合计）
    expect(JSON.parse(runs[0].stats)).toEqual({
      questions: 12,
      questionGroups: 3,
      images: 13,
      knowledgePoints: KNOWLEDGE_SEED_ROWS,
      papers: 7,
      questionPapers: 12,
      blueprints: XINGCE_BLUEPRINTS.length,
      blueprintModules: XINGCE_BLUEPRINTS.reduce((sum, bp) => sum + bp.modules.length, 0),
    })
    expect(result.stats).toEqual({
      questions: 12,
      questionGroups: 3,
      images: 13,
      knowledgePoints: KNOWLEDGE_SEED_ROWS,
      papers: 7,
      questionPapers: 12,
      blueprints: XINGCE_BLUEPRINTS.length,
      blueprintModules: XINGCE_BLUEPRINTS.reduce((sum, bp) => sum + bp.modules.length, 0),
    })
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

describe('试卷与归属（T2-01a/ADR-0012，paper-input 产物）', () => {
  /** 归属 pair 行视图：卷名 + qid + 卷内序（JOIN 展开便于断言） */
  const pairRows = (db: DatabaseSync): Array<{ paper: string; qid: string; sequence: number }> =>
    rows(
      db,
      `SELECT p.name AS paper, q.qid AS qid, qp.sequence AS sequence
       FROM question_papers qp
       JOIN papers p ON p.id = qp.paper_id
       JOIN questions q ON q.id = qp.question_id
       ORDER BY p.id, qp.sequence`,
    )

  it('papers/question_papers 写入：聚合卷 2 行、归属 5 pair，联考同题 910101 双卷归属恢复', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: paperProducts, version: 1 })
    db.exec(result.sql)
    expect(result.stats.papers).toBe(2)
    expect(result.stats.questionPapers).toBe(5)
    expect(result.issues).toEqual([])

    const papers = rows<{
      name: string
      year: number
      region: string
      paper_type: string
      question_count: number
    }>(db, 'SELECT name, year, region, paper_type, question_count FROM papers ORDER BY id')
    // 庚卷 = 01 政治 + 02 常识两份模块文件聚合（region 取首个非空值「虚构省」）；
    // question_count = 实际写入 pair 数（可解析归属数，同原始 qids 长度——无门控）
    expect(papers).toEqual([
      {
        name: '2024年某省联考《行测》题（虚构庚卷）',
        year: 2024,
        region: '虚构省',
        paper_type: '联考',
        question_count: 3,
      },
      {
        name: '2024年某省联考《行测》题（虚构辛卷）',
        year: 2024,
        region: '虚构市',
        paper_type: '联考',
        question_count: 2,
      },
    ])

    // 910101 实体仅首见一份（political_theory），但庚卷 seq=1 与辛卷 seq=2 双归属
    expect(pairRows(db)).toEqual([
      { paper: '2024年某省联考《行测》题（虚构庚卷）', qid: '910101', sequence: 1 },
      { paper: '2024年某省联考《行测》题（虚构庚卷）', qid: '910102', sequence: 2 },
      { paper: '2024年某省联考《行测》题（虚构庚卷）', qid: '910201', sequence: 3 },
      { paper: '2024年某省联考《行测》题（虚构辛卷）', qid: '910301', sequence: 1 },
      { paper: '2024年某省联考《行测》题（虚构辛卷）', qid: '910101', sequence: 2 },
    ])
    const modules = rows<{ module_id: number }>(
      db,
      `SELECT module_id FROM questions WHERE qid='910101'`,
    )
    const political = rows<{ code: string }>(db, "SELECT code FROM modules WHERE code='political_theory'")
    expect(modules).toHaveLength(1)
    expect(modules[0].module_id).not.toBeNull()
    // 题目实体归属首见模块（政治理论），辛卷/庚卷常识侧仅记 pair 归属
    expect(rows<{ code: string }>(db, `SELECT m.code AS code FROM modules m WHERE m.id=${modules[0].module_id}`)).toEqual(political)
    db.close()
  })

  it('幂等重放：同一 SQL 再 exec → pair 行/序值与卷 id 均不变（ON CONFLICT 原地更新）', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: paperProducts, version: 1 })
    db.exec(result.sql)
    const pairsBefore = pairRows(db)
    const papersBefore = rows<{ id: number; name: string }>(db, 'SELECT id, name FROM papers ORDER BY id')
    db.exec(result.sql)
    expect(pairRows(db)).toEqual(pairsBefore)
    expect(rows<{ id: number; name: string }>(db, 'SELECT id, name FROM papers ORDER BY id')).toEqual(papersBefore)
    db.close()
  })

  it('字节确定性：同产物同 version 两次生成全等；SQL 含 papers/pair upsert 与孤儿清理段', () => {
    const a = runDbStage({ productsDir: paperProducts, version: 2 })
    const b = runDbStage({ productsDir: paperProducts, version: 2 })
    expect(b.sql).toBe(a.sql)
    expect(a.sql).toContain('INSERT INTO papers (name, year, region, paper_type, question_count)')
    expect(a.sql).toContain('INSERT INTO question_papers (paper_id, question_id, sequence)')
    expect(a.sql).toContain('DELETE FROM question_papers ')
    expect(a.sql).toContain('DELETE FROM papers ')
    // import_runs 行 stats JSON 带试卷计数
    expect(a.sql).toContain('"papers":2')
    expect(a.sql).toContain('"questionPapers":5')
  })
})

describe('蓝图种子（T2-01b，XINGCE_BLUEPRINTS 幂等入库）', () => {
  /** 行测科目/申论科目 id 的标量子查询（与 db-stage.ts 同文本，测试注入行定位用） */
  const XINGCE_SUBJECT_ID =
    "(SELECT id FROM subjects WHERE exam_type_id=(SELECT id FROM exam_types WHERE code='civil_service') AND code='xingce')"
  const SHENLUN_SUBJECT_ID =
    "(SELECT id FROM subjects WHERE exam_type_id=(SELECT id FROM exam_types WHERE code='civil_service') AND code='shenlun')"

  /** 蓝图行视图：code + name + 科目 code（JOIN 展开，序 = id） */
  const blueprintRows = (db: DatabaseSync): Array<{ code: string; name: string; subject: string }> =>
    rows(
      db,
      `SELECT b.code AS code, b.name AS name, s.code AS subject
       FROM blueprints b JOIN subjects s ON s.id = b.subject_id
       ORDER BY b.id`,
    )

  /** 蓝图明细行视图：蓝图 code + 模块 code + 题量/时长（JOIN 展开，序 = 蓝图 id → 模块 sort_order） */
  const blueprintModuleRows = (
    db: DatabaseSync,
  ): Array<{ blueprint: string; module: string; question_count: number; time_limit_minutes: number }> =>
    rows(
      db,
      `SELECT b.code AS blueprint, m.code AS module, bm.question_count AS question_count, bm.time_limit_minutes AS time_limit_minutes
       FROM blueprint_modules bm
       JOIN blueprints b ON b.id = bm.blueprint_id
       JOIN modules m ON m.id = bm.module_id
       ORDER BY b.id, m.sort_order`,
    )

  /** 期望形态：XINGCE_BLUEPRINTS → 行视图（精确一致断言的对照面，序 = 目录序） */
  const expectedBlueprints = XINGCE_BLUEPRINTS.map((bp) => ({ code: bp.code, name: bp.name, subject: 'xingce' }))
  const expectedBlueprintModules = XINGCE_BLUEPRINTS.flatMap((bp) =>
    bp.modules.map((plan) => ({
      blueprint: bp.code,
      module: plan.module,
      question_count: plan.questionCount,
      time_limit_minutes: plan.timeLimitMinutes,
    })),
  )

  it('种子入库：blueprints 2 行 / blueprint_modules 12 行，列值与 XINGCE_BLUEPRINTS 精确一致（挂对 subject/module）', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: cleanProducts, version: 1 })
    db.exec(result.sql)
    expect(blueprintRows(db)).toEqual(expectedBlueprints)
    expect(blueprintModuleRows(db)).toEqual(expectedBlueprintModules)
    expect(result.stats.blueprints).toBe(expectedBlueprints.length)
    expect(result.stats.blueprintModules).toBe(expectedBlueprintModules.length)
    // import_runs 行 stats JSON 带蓝图计数
    expect(result.sql).toContain(`"blueprints":${expectedBlueprints.length}`)
    expect(result.sql).toContain(`"blueprintModules":${expectedBlueprintModules.length}`)
    db.close()
  })

  it('幂等重放：同一 SQL 再 exec → 蓝图与明细的 id、行值均不变（ON CONFLICT 原地更新）', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: cleanProducts, version: 1 })
    db.exec(result.sql)
    const blueprintSnapshot = rows<{ id: number; code: string; name: string }>(
      db,
      'SELECT id, code, name FROM blueprints ORDER BY id',
    )
    const moduleSnapshot = rows<{
      id: number
      blueprint: string
      module: string
      question_count: number
      time_limit_minutes: number
    }>(
      db,
      `SELECT bm.id, b.code AS blueprint, m.code AS module, bm.question_count, bm.time_limit_minutes
       FROM blueprint_modules bm
       JOIN blueprints b ON b.id = bm.blueprint_id
       JOIN modules m ON m.id = bm.module_id
       ORDER BY bm.id`,
    )
    db.exec(result.sql)
    expect(rows<{ id: number; code: string; name: string }>(db, 'SELECT id, code, name FROM blueprints ORDER BY id')).toEqual(
      blueprintSnapshot,
    )
    expect(
      rows<{ id: number; blueprint: string; module: string; question_count: number; time_limit_minutes: number }>(
        db,
        `SELECT bm.id, b.code AS blueprint, m.code AS module, bm.question_count, bm.time_limit_minutes
         FROM blueprint_modules bm
         JOIN blueprints b ON b.id = bm.blueprint_id
         JOIN modules m ON m.id = bm.module_id
         ORDER BY bm.id`,
      ),
    ).toEqual(moduleSnapshot)
    db.close()
  })

  it('孤儿清理：种子外蓝图与其明细重放后被删（先明细后主表），他科目蓝图与其明细不受影响', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: cleanProducts, version: 1 })
    db.exec(result.sql)
    // 预插申论科目 + 其蓝图与明细（清理限定行测科目，均不得误删）
    db.exec(
      `INSERT INTO subjects (exam_type_id, code, name) VALUES ((SELECT id FROM exam_types WHERE code='civil_service'), 'shenlun', '申论')`,
    )
    db.exec(`INSERT INTO blueprints (subject_id, code, name) VALUES (${SHENLUN_SUBJECT_ID}, 'shenlun_bp', '申论蓝图')`)
    db.exec(
      `INSERT INTO blueprint_modules (blueprint_id, module_id, question_count, time_limit_minutes)
       VALUES ((SELECT id FROM blueprints WHERE subject_id=${SHENLUN_SUBJECT_ID} AND code='shenlun_bp'), (SELECT id FROM modules WHERE subject_id=${XINGCE_SUBJECT_ID} AND code='verbal'), 8, 8)`,
    )
    // 预插行测种子外蓝图 + 其下明细（重放后先删明细再删主表行）
    db.exec(`INSERT INTO blueprints (subject_id, code, name) VALUES (${XINGCE_SUBJECT_ID}, 'ghost_bp', '幽灵卷型')`)
    db.exec(
      `INSERT INTO blueprint_modules (blueprint_id, module_id, question_count, time_limit_minutes)
       VALUES ((SELECT id FROM blueprints WHERE subject_id=${XINGCE_SUBJECT_ID} AND code='ghost_bp'), (SELECT id FROM modules WHERE subject_id=${XINGCE_SUBJECT_ID} AND code='verbal'), 5, 5)`,
    )

    db.exec(result.sql) // 同产物重跑 → 孤儿清理回收种子外行

    const remaining = rows<{ code: string; subject: string }>(
      db,
      `SELECT b.code AS code, s.code AS subject FROM blueprints b JOIN subjects s ON s.id = b.subject_id ORDER BY b.code`,
    )
    expect(remaining).toEqual(
      [
        ...expectedBlueprints.map((entry) => ({ code: entry.code, subject: 'xingce' })),
        { code: 'shenlun_bp', subject: 'shenlun' },
      ].sort((a, b) => (a.code < b.code ? -1 : 1)),
    )
    // 明细总数 = 种子 12 + 申论 1（幽灵明细被先行清理；申论明细保留）
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM blueprint_modules')).toEqual([
      { n: expectedBlueprintModules.length + 1 },
    ])
    db.close()
  })

  it('注入目录执行：种子蓝图下种子外模块明细被卷内 NOT IN 清理，明细值被 upsert 原地更新', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: cleanProducts, version: 1 })
    db.exec(result.sql) // 分类体系 + 真目录全量种子在位
    // 手工铺部分卷：两条明细（verbal + quantitative），随后执行只含 verbal 的注入目录段
    db.exec(`INSERT INTO blueprints (subject_id, code, name) VALUES (${XINGCE_SUBJECT_ID}, 'partial_bp', '部分卷')`)
    for (const [code, count] of [
      ['verbal', 1],
      ['quantitative', 2],
    ] as const) {
      db.exec(
        `INSERT INTO blueprint_modules (blueprint_id, module_id, question_count, time_limit_minutes)
         VALUES ((SELECT id FROM blueprints WHERE subject_id=${XINGCE_SUBJECT_ID} AND code='partial_bp'), (SELECT id FROM modules WHERE subject_id=${XINGCE_SUBJECT_ID} AND code='${code}'), ${count}, ${count})`,
      )
    }
    const partial: ExamBlueprint = {
      code: 'partial_bp',
      name: '部分卷',
      totalMinutes: 35,
      modules: [{ module: 'verbal', questionCount: 10, timeLimitMinutes: 35 }],
    }
    db.exec(
      blueprintSeedStatements([partial])
        .map((statement) => `${statement};`)
        .join('\n'),
    )

    // 注入目录替换真目录：行测下仅剩 partial_bp；其明细仅剩 verbal 且值被 upsert 更新为 10/35
    expect(rows<{ code: string }>(db, `SELECT code FROM blueprints WHERE subject_id=${XINGCE_SUBJECT_ID} ORDER BY code`)).toEqual(
      [{ code: 'partial_bp' }],
    )
    expect(blueprintModuleRows(db)).toEqual([{ blueprint: 'partial_bp', module: 'verbal', question_count: 10, time_limit_minutes: 35 }])
    db.close()
  })

  it('blueprints.sql 独立产物：落盘与返回文本一致、语句为 import.sql 对应段逐字节一致的自包含前缀；干净库单独重放两次幂等', () => {
    const result = runDbStage({ productsDir: cleanProducts, version: 3 })
    const blueprintsSqlPath = path.join(cleanProducts, 'blueprints.sql')
    expect(result.blueprintsSqlPath).toBe(blueprintsSqlPath)
    expect(fs.readFileSync(blueprintsSqlPath, 'utf8')).toBe(result.blueprintsSql)

    const bpLines = result.blueprintsSql.split('\n')
    const sqlLines = result.sql.split('\n')
    expect(bpLines[0]).toMatch(/^-- ncse 蓝图种子 SQL（自包含/)
    expect(bpLines[bpLines.length - 1]).toBe('') // 以换行结尾
    // 自包含超集断言：头注释外的全部语句 = import.sql 去头注释后的同序前缀
    // （分类体系 8 条 + 蓝图 upsert 14 条 + 蓝图孤儿清理 4 条，逐字节一致）
    expect(bpLines.slice(1, -1)).toEqual(sqlLines.slice(1, bpLines.length - 1))
    expect(result.blueprintsSql).toContain('INSERT INTO blueprints (subject_id, code, name)')
    expect(result.blueprintsSql).toContain('INSERT INTO blueprint_modules (blueprint_id, module_id, question_count, time_limit_minutes)')
    expect(result.blueprintsSql).toContain('DELETE FROM blueprint_modules ')
    expect(result.blueprintsSql).toContain('DELETE FROM blueprints ')
    // 不含 version 与 import_runs（跨 version 逐字节稳定，便于远端轻量执行）
    expect(result.blueprintsSql).not.toContain('import_runs')
    expect(result.blueprintsSql).not.toContain('version=')
    // 与 version 无关：另一 version 生成的 blueprints.sql 逐字节相同
    expect(runDbStage({ productsDir: cleanProducts, version: 4 }).blueprintsSql).toBe(result.blueprintsSql)

    // 干净库（仅迁移）单独执行 → 种子完整；再执行一遍 → 幂等（id 与行值不变）
    const db = createDb()
    db.exec(result.blueprintsSql)
    expect(blueprintRows(db)).toEqual(expectedBlueprints)
    expect(blueprintModuleRows(db)).toEqual(expectedBlueprintModules)
    const snapshot = rows<{ id: number; code: string }>(db, 'SELECT id, code FROM blueprints ORDER BY id')
    db.exec(result.blueprintsSql)
    expect(rows<{ id: number; code: string }>(db, 'SELECT id, code FROM blueprints ORDER BY id')).toEqual(snapshot)
    expect(blueprintModuleRows(db)).toEqual(expectedBlueprintModules)
    db.close()
  })

  it('validateBlueprint 失败路径：注入 totalMinutes 不自洽的假目录 → 抛错（消息含 code 与问题）；空目录亦抛错', () => {
    const bogus: ExamBlueprint = {
      code: 'bogus_bp',
      name: '坏蓝图',
      totalMinutes: 999,
      modules: [{ module: 'verbal', questionCount: 10, timeLimitMinutes: 10 }],
    }
    expect(() => blueprintSeedStatements([bogus])).toThrow(/bogus_bp/)
    expect(() => blueprintSeedStatements([bogus])).toThrow(/totalMinutes\(999\)/)
    expect(() => blueprintSeedStatements([])).toThrow(/蓝图目录为空/)
  })
})

describe('知识点种子（M3/T3-01a，XINGCE_KNOWLEDGE_TREE 幂等入库）', () => {
  /** 行测科目 id 的标量子查询（与 db-stage.ts 同文本，测试注入行定位用） */
  const XINGCE_SUBJECT_ID =
    "(SELECT id FROM subjects WHERE exam_type_id=(SELECT id FROM exam_types WHERE code='civil_service') AND code='xingce')"

  /** 知识点行视图：模块 code + 节点 code/name + 父节点 code（考点 NULL）+ sort_order（序 = 模块序 → 考点先于其知识点 → 各自 sort_order） */
  const knowledgeRows = (
    db: DatabaseSync,
  ): Array<{ module: string; code: string; name: string; parent: string | null; sort_order: number }> =>
    rows(
      db,
      `SELECT m.code AS module, kp.code AS code, kp.name AS name, p.code AS parent, kp.sort_order AS sort_order
       FROM knowledge_points kp
       JOIN modules m ON m.id = kp.module_id
       LEFT JOIN knowledge_points p ON p.id = kp.parent_id
       ORDER BY m.sort_order, COALESCE(kp.parent_id, kp.id), (kp.parent_id IS NULL) DESC, kp.sort_order`,
    )

  /** 期望形态：XINGCE_KNOWLEDGE_TREE → 行视图（精确一致断言的对照面，序 = 常量树序：考点前、知识点后） */
  const expectedKnowledgeRows = XINGCE_KNOWLEDGE_TREE.flatMap((entry) =>
    entry.topics.flatMap((topic, topicIndex) => [
      { module: entry.module, code: topic.code, name: topic.name, parent: null, sort_order: topicIndex + 1 },
      ...topic.points.map((point, pointIndex) => ({
        module: entry.module,
        code: point.code,
        name: point.name,
        parent: topic.code,
        sort_order: pointIndex + 1,
      })),
    ]),
  )

  it('种子入库：knowledge_points 137 行（36 考点 parent NULL + 101 知识点挂考点），列值与 XINGCE_KNOWLEDGE_TREE 精确一致', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: cleanProducts, version: 1 })
    db.exec(result.sql)
    expect(knowledgeRows(db)).toEqual(expectedKnowledgeRows)
    const parentNull = rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM knowledge_points WHERE parent_id IS NULL')
    expect(parentNull[0].n).toBe(36)
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM knowledge_points')[0].n).toBe(KNOWLEDGE_SEED_ROWS)
    expect(result.stats.knowledgePoints).toBe(KNOWLEDGE_SEED_ROWS)
    // import_runs 行 stats JSON 带知识点计数
    expect(result.sql).toContain(`"knowledgePoints":${KNOWLEDGE_SEED_ROWS}`)
    db.close()
  })

  it('幂等重放：同一 SQL 再 exec → 全部节点 id/code/name/parent/sort_order 快照不变（ON CONFLICT 原地更新）', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: cleanProducts, version: 1 })
    db.exec(result.sql)
    const snapshot = rows<{
      id: number
      code: string
      name: string
      parent_id: number | null
      sort_order: number
    }>(db, 'SELECT id, code, name, parent_id, sort_order FROM knowledge_points ORDER BY id')
    db.exec(result.sql)
    expect(
      rows<{
        id: number
        code: string
        name: string
        parent_id: number | null
        sort_order: number
      }>(db, 'SELECT id, code, name, parent_id, sort_order FROM knowledge_points ORDER BY id'),
    ).toEqual(snapshot)
    db.close()
  })

  it('孤儿清理：行测种子外知识点重放后被删并级联连带删其打标行；他科目知识点不受影响', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: cleanProducts, version: 1 })
    db.exec(result.sql)
    // 预插行测孤儿知识点 + 一条挂它的打标行（question_knowledge，ADR-0013 后果：级联连带删）
    db.exec(`
      INSERT INTO knowledge_points (module_id, parent_id, code, name, sort_order)
      VALUES ((SELECT id FROM modules WHERE subject_id=${XINGCE_SUBJECT_ID} AND code='verbal'), NULL, 'orphan-topic', '孤儿考点', 99);
      INSERT INTO question_knowledge (question_id, knowledge_point_id, tag_version, source)
      VALUES ((SELECT id FROM questions WHERE qid=(SELECT MIN(qid) FROM questions)),
              (SELECT id FROM knowledge_points WHERE code='orphan-topic'), 1, 'ai');
      INSERT INTO subjects (exam_type_id, code, name)
      VALUES ((SELECT id FROM exam_types WHERE code='civil_service'), 'shenlun', '申论');
      INSERT INTO modules (subject_id, code, name, sort_order)
      VALUES ((SELECT id FROM subjects WHERE code='shenlun'), 'shenlun_essay', '申论写作', 1);
      INSERT INTO knowledge_points (module_id, parent_id, code, name, sort_order)
      VALUES ((SELECT id FROM modules WHERE code='shenlun_essay'), NULL, 'shenlun-kp', '申论知识点', 1);
    `)
    db.exec(result.sql)
    expect(rows<{ code: string }>(db, "SELECT code FROM knowledge_points WHERE code IN ('orphan-topic','shenlun-kp')")).toEqual([
      { code: 'shenlun-kp' },
    ])
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM question_knowledge WHERE knowledge_point_id=(SELECT id FROM knowledge_points WHERE code='orphan-topic')")).toEqual([{ n: 0 }])
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM knowledge_points')[0].n).toBe(KNOWLEDGE_SEED_ROWS + 1)
    db.close()
  })

  it('独立自包含 knowledge.sql：语句与 import.sql 对应段逐字节一致；不含 version/import_runs；跨 version 稳定；干净库单独重放幂等', () => {
    const result = runDbStage({ productsDir: cleanProducts, version: 1 })
    const kLines = result.knowledgeSql.split('\n')
    const sqlLines = result.sql.split('\n')
    expect(kLines[0]).toMatch(/^-- ncse 知识点种子 SQL（自包含/)
    expect(kLines[kLines.length - 1]).toBe('') // 以换行结尾
    const body = kLines.slice(1, -1)
    // 语句数 = 分类体系 8 条 + 种子 137 条 + 孤儿清理 1 条
    expect(body).toHaveLength(8 + KNOWLEDGE_SEED_ROWS + 1)
    // 分类体系段 = import.sql 头注释后的同序前缀（与 blueprints.sql 共用同段）
    expect(body.slice(0, 8)).toEqual(sqlLines.slice(1, 9))
    // 知识点段紧随 import.sql 蓝图段之后连续出现，逐字节一致
    const knowledgeStart = sqlLines.findIndex((line) => line.startsWith('INSERT INTO knowledge_points '))
    expect(knowledgeStart).toBeGreaterThan(0)
    expect(body.slice(8)).toEqual(sqlLines.slice(knowledgeStart, knowledgeStart + KNOWLEDGE_SEED_ROWS + 1))
    expect(result.knowledgeSql).toContain('INSERT INTO knowledge_points (module_id, parent_id, code, name, sort_order)')
    expect(result.knowledgeSql).toContain('DELETE FROM knowledge_points ')
    expect(result.knowledgeSql).not.toContain('import_runs')
    expect(result.knowledgeSql).not.toContain('version=')
    // 与 version 无关：另一 version 生成的 knowledge.sql 逐字节相同
    expect(runDbStage({ productsDir: cleanProducts, version: 4 }).knowledgeSql).toBe(result.knowledgeSql)

    // 干净库（仅迁移）单独执行 → 种子完整；再执行一遍 → 幂等（id 与行值不变）
    const db = createDb()
    db.exec(result.knowledgeSql)
    expect(knowledgeRows(db)).toEqual(expectedKnowledgeRows)
    const snapshot = rows<{ id: number; code: string }>(db, 'SELECT id, code FROM knowledge_points ORDER BY id')
    db.exec(result.knowledgeSql)
    expect(rows<{ id: number; code: string }>(db, 'SELECT id, code FROM knowledge_points ORDER BY id')).toEqual(snapshot)
    expect(knowledgeRows(db)).toEqual(expectedKnowledgeRows)
    db.close()
  })

  it('validateKnowledgeTree 失败路径：注入缺模块的假树 → 抛错（消息含缺失模块）；六模块全空树亦抛错', () => {
    expect(() => knowledgeSeedStatements(XINGCE_KNOWLEDGE_TREE.slice(0, 5))).toThrow(/模块缺失/)
    const emptyTree = (
      ['political_theory', 'common_sense', 'verbal', 'quantitative', 'judgement', 'data_analysis'] as const
    ).map((module) => ({ module, topics: [] }))
    expect(() => knowledgeSeedStatements(emptyTree)).toThrow(/知识点树为空/)
  })
})

describe('归属 pair 质量门（error 产物）', () => {
  it('qid 解析不到（门控题目）→ pair 跳过 + warning（消息含卷名与 qid），卷内序保留原始位置', () => {
    const result = runDbStage({ productsDir: errorProducts, version: 1 })
    const warnings = result.issues.filter((entry) => entry.code === 'paper_question_skipped')
    // 门控 800101（卷一）与 800103（卷二）→ 各一条 warning
    expect(warnings).toHaveLength(2)
    expect(warnings.every((entry) => entry.severity === 'warning')).toBe(true)
    expect(warnings.map((entry) => entry.qid).sort()).toEqual(['800101', '800103'])
    expect(warnings.every((entry) => entry.file === 'papers.json')).toBe(true)
    expect(warnings.every((entry) => /试卷「虚构错误卷[一二]」/.test(entry.message))).toBe(true)
    expect(warnings.every((entry) => entry.message.includes(entry.qid ?? ''))).toBe(true)

    const db = createDb()
    db.exec(result.sql)
    // papers 6 卷全量 upsert；pair = 可解析归属 6（800102/800105 双卷恢复 ×2 + 800203/800401）
    expect(result.stats.papers).toBe(6)
    expect(result.stats.questionPapers).toBe(6)
    // 卷一 800102 保留原始卷内序 2（被门控的 800101 留空隙，保真实卷序）
    const pair = rows<{ sequence: number }>(
      db,
      `SELECT qp.sequence FROM question_papers qp
       JOIN papers p ON p.id = qp.paper_id
       JOIN questions q ON q.id = qp.question_id
       WHERE p.name='虚构错误卷一' AND q.qid='800102'`,
    )
    expect(pair).toEqual([{ sequence: 2 }])
    // 卷一被门控的 800101 无 pair；卷二被门控的 800103 无 pair
    expect(
      rows(db, `SELECT COUNT(*) AS n FROM question_papers qp JOIN questions q ON q.id=qp.question_id WHERE q.qid IN ('800101','800103')`),
    ).toEqual([{ n: 0 }])
    // papers.question_count = 实际写入 pair 数（卷一 1、卷二 1，均低于原始归属数）
    const counts = rows<{ name: string; question_count: number }>(
      db,
      "SELECT name, question_count FROM papers WHERE name IN ('虚构错误卷一','虚构错误卷二') ORDER BY name",
    )
    expect(counts).toEqual([
      { name: '虚构错误卷一', question_count: 1 },
      { name: '虚构错误卷二', question_count: 1 },
    ])
    db.close()

    // --force：门控题目全量入库 → 归属恢复 8 pair（卷一 2 + 卷二 2），无 warning
    const forced = runDbStage({ productsDir: errorProducts, version: 1, force: true })
    expect(forced.issues).toEqual([])
    expect(forced.stats.questionPapers).toBe(8)
    expect(forced.stats.papers).toBe(6)
  })
})

describe('孤儿归属清理（镜像题组清理，先 pair 后 paper）', () => {
  it('重跑清除：不在产物集合的卷与 pair、卷内过期 pair 均删除，集合内的不受影响', () => {
    const db = createDb()
    const result = runDbStage({ productsDir: cleanProducts, version: 1 })
    db.exec(result.sql)
    // 人为注入陈旧行：整卷过期（虚构陈旧卷 + 其 pair）、甲卷上不在其 qid 集合的过期 pair
    db.exec(
      "INSERT INTO papers (name, year, region, paper_type, question_count) VALUES ('虚构陈旧卷', NULL, NULL, NULL, 1)",
    )
    db.exec(
      `INSERT INTO question_papers (paper_id, question_id, sequence) VALUES ((SELECT id FROM papers WHERE name='虚构陈旧卷'), (SELECT id FROM questions WHERE qid='900101'), 1)`,
    )
    db.exec(
      `INSERT INTO question_papers (paper_id, question_id, sequence) VALUES ((SELECT id FROM papers WHERE name='2024年某省公务员录用考试《行测》题（虚构甲卷）'), (SELECT id FROM questions WHERE qid='900601'), 99)`,
    )

    db.exec(result.sql) // 同产物重跑 → 孤儿清理回收陈旧行

    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM papers WHERE name='虚构陈旧卷'")).toEqual([{ n: 0 }])
    expect(
      rows(
        db,
        `SELECT COUNT(*) AS n FROM question_papers qp JOIN papers p ON p.id=qp.paper_id WHERE p.name='虚构陈旧卷'`,
      ),
    ).toEqual([{ n: 0 }])
    expect(
      rows(
        db,
        `SELECT COUNT(*) AS n FROM question_papers qp
         JOIN papers p ON p.id=qp.paper_id
         JOIN questions q ON q.id=qp.question_id
         WHERE p.name='2024年某省公务员录用考试《行测》题（虚构甲卷）' AND q.qid='900601'`,
      ),
    ).toEqual([{ n: 0 }])
    // 合法 pair 总数回落到 12（本次产物写入集合），甲卷自身 pair 与卷内序完好
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM question_papers')).toEqual([{ n: 12 }])
    const jiawuan = rows<{ qid: string; sequence: number }>(
      db,
      `SELECT q.qid AS qid, qp.sequence AS sequence FROM question_papers qp
       JOIN papers p ON p.id=qp.paper_id
       JOIN questions q ON q.id=qp.question_id
       WHERE p.name='2024年某省公务员录用考试《行测》题（虚构甲卷）'
       ORDER BY qp.sequence`,
    )
    expect(jiawuan).toEqual([
      { qid: '900101', sequence: 1 },
      { qid: '900102', sequence: 2 },
    ])
    db.close()
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

describe('图片统计（stats.images 做实：进 SQL 的 image 段 path 去重计数）', () => {
  it('clean 产物 → 13：题干/选项公式图/解析四处宿主与题组材料逐项清点；error 产物无图片段 → 0', () => {
    const clean = runDbStage({ productsDir: cleanProducts, version: 1 })
    // 逐项清点（全部题目入库、3 个组全部生成）：
    //   04 数量 900401 解析公式图 1；
    //   05 判断 900501 题干图 1 + 选项公式图 4 + 解析图 1 = 6；
    //   06 资料材料 1 表格图 1（题组材料）+ 900602 选项公式图 4 + 解析公式图 1 = 6
    expect(clean.stats.images).toBe(13)
    // SQL 的 import_runs 行 stats JSON 带该值（除此外语句语义不变）
    expect(clean.sql).toContain('"images":13')

    const error = runDbStage({ productsDir: errorProducts, version: 1 })
    expect(error.stats.images).toBe(0) // 错误卷夹具不含图片段
  })

  it('重写后产物（img/ 键）→ 按键去重：两个源路径同键 → 12；import_runs 行含该值', () => {
    const keyed = path.join(outDir, 'keyed-products')
    fs.cpSync(cleanProducts, keyed, { recursive: true })
    // 13 个去重源路径 → 12 个键：首两个源路径共用同一键（模拟同内容图片天然去重）
    const zeroKey = `img/${'0'.repeat(64)}.webp`
    const sourceToKey = new Map<string, string>()
    let index = 0
    rewriteImagePaths(keyed, (source) => {
      const existing = sourceToKey.get(source)
      if (existing !== undefined) return existing
      const key = index < 2 ? zeroKey : `img/${index.toString(16).padStart(64, '0')}.webp`
      sourceToKey.set(source, key)
      index++
      return key
    })
    expect(sourceToKey.size).toBe(13)
    const result = runDbStage({ productsDir: keyed, version: 2 })
    expect(result.stats).toEqual({
      questions: 12,
      questionGroups: 3,
      images: 12,
      knowledgePoints: KNOWLEDGE_SEED_ROWS,
      papers: 7,
      questionPapers: 12,
      blueprints: XINGCE_BLUEPRINTS.length,
      blueprintModules: XINGCE_BLUEPRINTS.reduce((sum, bp) => sum + bp.modules.length, 0),
    })
    expect(result.sql).toContain('"images":12')
    // 行级抽查：题干 JSON 列里确实已是 img/ 键形态（stem 列含 img/ 前缀路径）
    expect(result.sql).toContain('img/')
    // 确定性不受重写方式影响：同产物同 version 重跑全等
    expect(runDbStage({ productsDir: keyed, version: 2 }).sql).toBe(result.sql)
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
  it('manifest 缺失 / 模块 JSON 损坏 / papers.json 缺失或损坏 / 条目自洽性破坏 → 抛 InvalidProductsError', () => {
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

    // papers.json 缺失（T2-01a 前的旧产物）：paper_manifest_missing，强制先重新 parse
    const stale = path.join(outDir, 'stale-products')
    fs.rmSync(stale, { recursive: true, force: true })
    fs.cpSync(cleanProducts, stale, { recursive: true })
    fs.rmSync(resolveWithin(stale, 'papers.json'))
    try {
      runDbStage({ productsDir: stale, version: 1 })
      throw new Error('papers.json 缺失应抛 InvalidProductsError')
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProductsError)
      expect(err instanceof Error ? err.message : String(err)).toContain('paper_manifest_missing')
    }

    // papers.json 损坏 / questionCount 与 qids 长度不一致 / 重名条目
    fs.writeFileSync(path.join(stale, 'papers.json'), '{oops', 'utf8')
    expect(() => runDbStage({ productsDir: stale, version: 1 })).toThrow(InvalidProductsError)
    const mismatch = path.join(outDir, 'count-mismatch-products')
    fs.rmSync(mismatch, { recursive: true, force: true })
    fs.cpSync(cleanProducts, mismatch, { recursive: true })
    fs.writeFileSync(
      path.join(mismatch, 'papers.json'),
      `${JSON.stringify({ papers: [{ name: 'X', year: null, region: null, paperType: null, questionCount: 3, qids: ['1', '2'] }] }, null, 2)}\n`,
      'utf8',
    )
    expect(() => runDbStage({ productsDir: mismatch, version: 1 })).toThrow(InvalidProductsError)
    const duplicated = path.join(outDir, 'dup-name-products')
    fs.rmSync(duplicated, { recursive: true, force: true })
    fs.cpSync(cleanProducts, duplicated, { recursive: true })
    fs.writeFileSync(
      path.join(duplicated, 'papers.json'),
      `${JSON.stringify(
        {
          papers: [
            { name: 'X', year: null, region: null, paperType: null, questionCount: 1, qids: ['1'] },
            { name: 'X', year: null, region: null, paperType: null, questionCount: 1, qids: ['2'] },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    expect(() => runDbStage({ productsDir: duplicated, version: 1 })).toThrow(InvalidProductsError)
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

  it('error 产物默认 → 0（跳过质量问题题目不是失败）；产物结构无效 / papers.json 缺失 → 1', async () => {
    spyConsole()
    expect(await main(['db', '--products', errorProducts, '--version', '3'])).toBe(0)
    expect(await main(['db', '--products', path.join(outDir, 'empty-products'), '--version', '3'])).toBe(1)
    // papers.json 缺失（paper_manifest_missing）：旧产物强制先重新 parse
    expect(await main(['db', '--products', path.join(outDir, 'stale-products'), '--version', '3'])).toBe(1)
  })
})
