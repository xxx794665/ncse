/**
 * 截图导入一期工具链测试（M3/T3-01h-a，ADR-0014）：shot-in/ staging → runShotAbsorb
 * 产人工确认草稿 → runShotEmit 产独立自包含 shot.sql。
 * 覆盖：吸收侧逐图校验（合法草稿逐字段 / 坏 JSON / multiQuestion 跳过 / moduleCode
 * 非法 / options key 非连续或重复 / stem 空白 / 基名不合法 / 源图缺失与歧义 /
 * answer 空与不在键内与解析缺失的 reviewNotes / 已存在草稿不覆盖 / 重跑字节一致）；
 * 入库侧（confirmed 过门进 SQL / 质量门 missing_answer、answer_not_in_options、
 * no_options warning 跳过 / draft 状态不进 SQL / 草稿结构破坏 error 跳过）；
 * node:sqlite 内存库真实迁移 + shot.sql 执行后 questions 行与富片段 JSON 形态验证、
 * 分类体系段与 db-stage 同源逐字节一致、幂等重放、SQL 字节确定性、import_runs 行
 * 与 CLI 退出码（吸收 0/1/2、emit 0/1/2）。
 * 夹具全部合成虚构（ADR-0004，不引入真实截图）：screenshots-in/ 只放哑字节文件
 * ——吸收只校验存在性与扩展名，不读图像内容；产物与 SQL 写系统临时目录，测试后清理。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { taxonomySeedStatements } from '../src/db-stage.js'
import { serializeJson } from '../src/pipeline.js'
import { runShotAbsorb, runShotEmit } from '../src/shot-stage.js'
import { main } from '../src/main.js'
import type { ShotDraft, ShotStaging } from '../src/types.js'

/** apps/api 迁移目录（本测试文件位于 tools/importer/test，仓库根为其上三级） */
const migrationsDir = fileURLToPath(new URL('../../../apps/api/migrations', import.meta.url))

// 模块加载即建临时工作区：describe 体在 beforeAll 之前执行，会引用产物路径
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncse-importer-shot-'))
const productsDir = path.join(outDir, 'products')
fs.mkdirSync(productsDir, { recursive: true })

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * 执行多语句 SQL 文本（语句级 prepare/run）：按约定切分后逐条执行——
 * 迁移文件以 '--> statement-breakpoint' 分隔（行注释标记，语句内部无分号字面量），
 * 生成的 shot.sql 每语句一行以 ';' 结尾（行尾分号剥离，行内分号保留）。
 * 仅接收仓库静态迁移文件与被测生成的确定性 SQL 文本。
 */
function execSql(db: DatabaseSync, sql: string): void {
  const statements = sql.includes('--> statement-breakpoint')
    ? sql.split('--> statement-breakpoint')
    : sql
        .split('\n')
        .filter((line) => line.endsWith(';'))
        .map((line) => line.slice(0, -1))
  for (const statement of statements) {
    const text = statement.trim()
    if (text.length === 0) continue
    db.prepare(text).run()
  }
}

/** 建内存库并按文件名序逐文件应用全部迁移（同时验证迁移在原生 SQLite 可执行） */
function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  expect(files.length).toBeGreaterThanOrEqual(2)
  const migrationTexts = files.map((name) =>
    fs.readFileSync(path.join(migrationsDir, name), 'utf8'),
  )
  for (const text of migrationTexts) {
    execSql(db, text)
  }
  return db
}

/** 查询并映射为普通对象（node:sqlite 返回 null 原型记录，转普通对象便于 toEqual） */
function rows<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as T[]
}

/** 放合成截图（哑字节：吸收只校验存在性与扩展名白名单，不读图像内容） */
function putScreenshot(name: string): void {
  const dir = path.join(productsDir, 'screenshots-in')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), 'synthetic-screenshot-bytes', 'utf8')
}

/** 写 staging（payload 为字符串时原样落盘，用于坏 JSON 夹具） */
function writeStaging(base: string, payload: ShotStaging | string): void {
  const dir = path.join(productsDir, 'shot-in')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${base}.json`),
    typeof payload === 'string' ? payload : serializeJson(payload).trimEnd(),
    'utf8',
  )
}

/** 读草稿（吸收产物 JSON） */
function readDraft(base: string): ShotDraft {
  return JSON.parse(
    fs.readFileSync(path.join(productsDir, 'shot-drafts', `shot-${base}.json`), 'utf8'),
  ) as ShotDraft
}

/** 模拟人工确认：读草稿 → 可选人工编辑补丁 → status 置 confirmed → 原格式写回 */
function confirmDraft(base: string, patch?: Partial<ShotDraft>): ShotDraft {
  const draftPath = path.join(productsDir, 'shot-drafts', `shot-${base}.json`)
  const edited: ShotDraft = { ...readDraft(base), ...patch, status: 'confirmed' }
  fs.writeFileSync(draftPath, serializeJson(edited), 'utf8')
  return edited
}

/** 每用例独立工作区（截图/staging/草稿/SQL 全清） */
function resetWorkspace(): void {
  for (const name of ['screenshots-in', 'shot-in', 'shot-drafts']) {
    fs.rmSync(path.join(productsDir, name), { recursive: true, force: true })
  }
  fs.rmSync(path.join(productsDir, 'shot.sql'), { force: true })
}

/** 标准合成 staging（覆盖式定制） */
function stagingOf(overrides?: Partial<ShotStaging>): ShotStaging {
  return {
    moduleCode: 'judgement',
    stem: '下列关于虚构概念的表述，正确的是：',
    options: [
      { key: 'A', text: '虚构选项甲' },
      { key: 'B', text: '虚构选项乙' },
      { key: 'C', text: '虚构选项丙' },
      { key: 'D', text: '虚构选项丁' },
    ],
    answer: 'B',
    analysis: '虚构解析：题干限定词指向选项乙。',
    multiQuestion: false,
    ...overrides,
  }
}

/** 标准两图链路：放截图 → 写 staging → 吸收 → 确认（emit 用例的公共前置） */
function confirmedTwo(): { baseA: string; baseB: string } {
  putScreenshot('alpha-1.png')
  putScreenshot('beta-2.jpg')
  writeStaging('alpha-1', stagingOf({ moduleCode: 'verbal' }))
  writeStaging('beta-2', stagingOf({ moduleCode: 'quantitative', answer: 'A' }))
  runShotAbsorb({ productsDir })
  confirmDraft('alpha-1')
  confirmDraft('beta-2')
  return { baseA: 'alpha-1', baseB: 'beta-2' }
}

describe('截图吸收（M3/T3-01h-a，shot-in/ staging → shot-drafts/ 草稿）', () => {
  beforeEach(() => {
    resetWorkspace()
  })

  it('合法 staging → 草稿逐字段正确（qid/status/sourceFile/moduleCode/kind/stem/options/answer/analysis/reviewNotes），文件为 serializeJson 确定性形态', () => {
    putScreenshot('topic-01.png')
    writeStaging('topic-01', stagingOf({ notes: '图中含下划线式重点' }))

    const result = runShotAbsorb({ productsDir })
    expect(result.stats).toEqual({ created: 1, skippedExisting: 0, warnings: 0, errors: 0 })
    expect(result.issues).toEqual([])

    const draft = readDraft('topic-01')
    expect(draft).toEqual({
      qid: 'shot-topic-01',
      status: 'draft',
      sourceFile: 'topic-01.png',
      moduleCode: 'judgement',
      kind: 'single_choice',
      stem: '下列关于虚构概念的表述，正确的是：',
      options: [
        { key: 'A', text: '虚构选项甲' },
        { key: 'B', text: '虚构选项乙' },
        { key: 'C', text: '虚构选项丙' },
        { key: 'D', text: '虚构选项丁' },
      ],
      answer: 'B',
      analysis: '虚构解析：题干限定词指向选项乙。',
      reviewNotes: ['视觉提取附注：图中含下划线式重点'],
    })
    // 字节确定性：落盘内容 = serializeJson（2 空格缩进 + 尾随换行，无时间戳）
    const raw = fs.readFileSync(path.join(productsDir, 'shot-drafts', 'shot-topic-01.json'), 'utf8')
    expect(raw).toBe(serializeJson(draft))
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('源图扩展大小写不敏感，sourceFile 保留原始大小写文件名', () => {
    putScreenshot('mixed-case-01.PNG')
    putScreenshot('upper-02.WebP')
    writeStaging('mixed-case-01', stagingOf())
    writeStaging('upper-02', stagingOf())

    const result = runShotAbsorb({ productsDir })
    expect(result.stats).toEqual({ created: 2, skippedExisting: 0, warnings: 0, errors: 0 })
    expect(readDraft('mixed-case-01').sourceFile).toBe('mixed-case-01.PNG')
    expect(readDraft('upper-02').sourceFile).toBe('upper-02.WebP')
  })

  it('answer 空串与不在选项键内、analysis 空串均合法：逐条落 reviewNotes（确定性顺序）', () => {
    putScreenshot('no-answer.png')
    putScreenshot('bad-answer.png')
    putScreenshot('clean.png')
    writeStaging('no-answer', stagingOf({ answer: '', analysis: '' }))
    writeStaging('bad-answer', stagingOf({ answer: 'Z' }))
    writeStaging('clean', stagingOf())

    const result = runShotAbsorb({ productsDir })
    expect(result.stats).toEqual({ created: 3, skippedExisting: 0, warnings: 0, errors: 0 })
    expect(readDraft('no-answer').reviewNotes).toEqual([
      'answer 为空，需人工补充后置 confirmed 才能入库',
      '解析缺失（analysis 为空），人工可补充；不阻塞入库',
    ])
    expect(readDraft('bad-answer').reviewNotes).toEqual(['answer 不在选项键内（Z），需校对'])
    expect(readDraft('clean').reviewNotes).toEqual([])
  })

  it('坏 JSON → error shot_staging_invalid_json 跳过不产草稿（不删 staging），CLI 退出 1', async () => {
    putScreenshot('broken.png')
    writeStaging('broken', '{ "moduleCode": "judgement", ')

    const result = runShotAbsorb({ productsDir })
    expect(result.stats).toEqual({ created: 0, skippedExisting: 0, warnings: 0, errors: 1 })
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({
      severity: 'error',
      code: 'shot_staging_invalid_json',
      qid: 'shot-broken',
    })
    expect(fs.existsSync(path.join(productsDir, 'shot-drafts', 'shot-broken.json'))).toBe(false)
    // staging 原样保留（不删，人工/代理可修复后重吸收）
    expect(fs.existsSync(path.join(productsDir, 'shot-in', 'broken.json'))).toBe(true)

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await main(['shot', '--products', productsDir])).toBe(1)
  })

  it('multiQuestion=true → warning 跳过不产草稿（一期一图一题，人工拆图重截），CLI 退出 0', async () => {
    putScreenshot('multi.png')
    writeStaging(
      'multi',
      stagingOf({ multiQuestion: true, stem: '', options: [], answer: '', analysis: '' }),
    )

    const result = runShotAbsorb({ productsDir })
    expect(result.stats).toEqual({ created: 0, skippedExisting: 0, warnings: 1, errors: 0 })
    expect(result.issues[0]).toMatchObject({
      severity: 'warning',
      code: 'shot_multi_question',
      qid: 'shot-multi',
    })
    expect(fs.existsSync(path.join(productsDir, 'shot-drafts', 'shot-multi.json'))).toBe(false)

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await main(['shot', '--products', productsDir])).toBe(0)
  })

  it('moduleCode 非法 → error shot_module_code_invalid 跳过', () => {
    putScreenshot('bad-module.png')
    writeStaging('bad-module', stagingOf({ moduleCode: 'interview' }))

    const result = runShotAbsorb({ productsDir })
    expect(result.stats.errors).toBe(1)
    expect(result.issues[0]).toMatchObject({
      severity: 'error',
      code: 'shot_module_code_invalid',
      qid: 'shot-bad-module',
    })
    expect(fs.existsSync(path.join(productsDir, 'shot-drafts', 'shot-bad-module.json'))).toBe(false)
  })

  it('options 四种坏形态（空 / key 非从 A 起连续 / key 重复 / 数量越界）均 error shot_options_invalid 跳过', () => {
    const bases = ['opt-empty', 'opt-skip', 'opt-dup', 'opt-many']
    for (const base of bases) putScreenshot(`${base}.png`)
    writeStaging('opt-empty', stagingOf({ options: [] }))
    writeStaging(
      'opt-skip',
      stagingOf({
        options: [
          { key: 'A', text: '虚构甲' },
          { key: 'C', text: '虚构丙' },
        ],
      }),
    )
    writeStaging(
      'opt-dup',
      stagingOf({
        options: [
          { key: 'A', text: '虚构甲' },
          { key: 'A', text: '虚构乙' },
        ],
      }),
    )
    writeStaging(
      'opt-many',
      stagingOf({
        options: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((key) => ({ key, text: `虚构${key}` })),
      }),
    )

    const result = runShotAbsorb({ productsDir })
    expect(result.stats).toEqual({ created: 0, skippedExisting: 0, warnings: 0, errors: 4 })
    expect(result.issues.map((entry) => entry.code)).toEqual(Array(4).fill('shot_options_invalid'))
    // 错误消息带具体原因（文件名字典序：opt-dup 非连续 → opt-empty 数量 → opt-many 数量 → opt-skip 非连续）
    expect(result.issues[0]?.message).toContain("选项 key 非从 'A' 起连续大写字母")
    expect(result.issues[1]?.message).toContain('options 数量非法（0 项')
  })

  it('stem 空白 → error shot_stem_empty；基名不合法（含点/中文）→ error shot_invalid_basename', () => {
    putScreenshot('empty-stem.png')
    writeStaging('empty-stem', stagingOf({ stem: '   \n\t ' }))
    writeStaging('bad.name', stagingOf())
    writeStaging('中文名', stagingOf())

    const result = runShotAbsorb({ productsDir })
    expect(result.stats).toEqual({ created: 0, skippedExisting: 0, warnings: 0, errors: 3 })
    // 文件名字典序（JS 码元序）：bad.name < empty-stem < 中文名
    expect(result.issues.map((entry) => entry.code)).toEqual([
      'shot_invalid_basename',
      'shot_stem_empty',
      'shot_invalid_basename',
    ])
  })

  it('源图缺失 → error shot_source_missing；同名不同扩展多图 → error shot_source_ambiguous', () => {
    putScreenshot('amb-01.png')
    putScreenshot('amb-01.jpg')
    putScreenshot('has-source.png')
    writeStaging('no-source', stagingOf())
    writeStaging('amb-01', stagingOf())
    writeStaging('has-source', stagingOf())

    const result = runShotAbsorb({ productsDir })
    expect(result.stats).toEqual({ created: 1, skippedExisting: 0, warnings: 0, errors: 2 })
    expect(result.issues.map((entry) => entry.code)).toEqual([
      'shot_source_ambiguous',
      'shot_source_missing',
    ])
  })

  it('已存在同名草稿跳过不覆盖（保护人工编辑）并记 warning shot_draft_exists', () => {
    putScreenshot('protect.png')
    writeStaging('protect', stagingOf())

    const first = runShotAbsorb({ productsDir })
    expect(first.stats).toEqual({ created: 1, skippedExisting: 0, warnings: 0, errors: 0 })

    // 人工编辑草稿（确认场景下补 answer 与 reviewNotes 改写）
    const draftPath = path.join(productsDir, 'shot-drafts', 'shot-protect.json')
    const human: ShotDraft = { ...readDraft('protect'), answer: 'C', reviewNotes: ['人工已校对'] }
    fs.writeFileSync(draftPath, serializeJson(human), 'utf8')

    const second = runShotAbsorb({ productsDir })
    expect(second.stats).toEqual({ created: 0, skippedExisting: 1, warnings: 1, errors: 0 })
    expect(second.issues[0]).toMatchObject({
      severity: 'warning',
      code: 'shot_draft_exists',
      qid: 'shot-protect',
    })
    // 人工编辑原样保留（未被覆盖回 agent 建议）
    expect(readDraft('protect')).toEqual(human)
  })

  it('同 staging 重跑幂等：删草稿重吸收 → 字节一致；shot-in 非 .json 杂散文件忽略', () => {
    putScreenshot('idem-01.png')
    putScreenshot('idem-02.png')
    writeStaging('idem-01', stagingOf())
    writeStaging('idem-02', stagingOf({ answer: '' }))
    // 杂散非 staging 文件不参与吸收
    fs.writeFileSync(path.join(productsDir, 'shot-in', 'readme.txt'), '杂散', 'utf8')

    const first = runShotAbsorb({ productsDir })
    expect(first.stats).toEqual({ created: 2, skippedExisting: 0, warnings: 0, errors: 0 })
    const bytes1 = fs.readFileSync(
      path.join(productsDir, 'shot-drafts', 'shot-idem-01.json'),
      'utf8',
    )

    fs.rmSync(path.join(productsDir, 'shot-drafts', 'shot-idem-01.json'))
    const second = runShotAbsorb({ productsDir })
    expect(second.stats).toEqual({ created: 1, skippedExisting: 1, warnings: 1, errors: 0 })
    expect(
      fs.readFileSync(path.join(productsDir, 'shot-drafts', 'shot-idem-01.json'), 'utf8'),
    ).toBe(bytes1)
  })

  it('空 staging（shot-in 目录缺失）→ stats 全零，CLI 退出 0', async () => {
    const result = runShotAbsorb({ productsDir })
    expect(result.stats).toEqual({ created: 0, skippedExisting: 0, warnings: 0, errors: 0 })
    expect(result.issues).toEqual([])
    expect(fs.existsSync(path.join(productsDir, 'shot-drafts'))).toBe(false)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await main(['shot', '--products', productsDir])).toBe(0)
  })

  it('CLI 退出码：合法吸收 0；用法错误（缺 --products / --emit 缺 --version / 吸收模式传 --version / version 非正整数 / products 不存在）→ 2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    putScreenshot('cli-ok.png')
    writeStaging('cli-ok', stagingOf())
    expect(await main(['shot', '--products', productsDir])).toBe(0)

    expect(await main(['shot'])).toBe(2)
    expect(await main(['shot', '--products', productsDir, '--emit'])).toBe(2)
    expect(await main(['shot', '--products', productsDir, '--version', '9'])).toBe(2)
    expect(await main(['shot', '--products', productsDir, '--emit', '--version', 'abc'])).toBe(2)
    expect(await main(['shot', '--products', productsDir, '--emit', '--version', '0'])).toBe(2)
    expect(
      await main(['shot', '--products', path.join(outDir, 'nope'), '--emit', '--version', '1']),
    ).toBe(2)
  })
})

describe('截图入库（M3/T3-01h-a，shot-drafts/ confirmed 草稿 → 独立自包含 shot.sql）', () => {
  beforeEach(() => {
    resetWorkspace()
  })

  it('confirmed 过门进 SQL：分类体系定位段与 db-stage 同源逐字节一致；执行后 questions 行与富片段 JSON 形态、import_runs 行全对齐', () => {
    const { baseA, baseB } = confirmedTwo()

    const result = runShotEmit({ productsDir, version: 9 })
    expect(result.stats).toEqual({ shotQuestions: 2, gatedSkipped: 0, errorSkipped: 0 })
    expect(result.issues).toEqual([])
    expect(result.sqlPath).toBe(path.join(productsDir, 'shot.sql'))
    expect(fs.readFileSync(result.sqlPath, 'utf8')).toBe(result.sql)

    // 头注释与分类体系定位段（exam_types/subjects/modules 六模块）与 db-stage 同源逐字节一致
    expect(
      result.sql.startsWith(
        `-- ncse 截图导入 SQL：version=9，吸收自 shot-drafts/ 已确认草稿（幂等，可重复执行）\n`,
      ),
    ).toBe(true)
    const taxonomy = taxonomySeedStatements().map((statement) => `${statement};`)
    expect(result.sql.split('\n').slice(1, 1 + taxonomy.length)).toEqual(taxonomy)

    // node:sqlite 真实迁移 + 执行
    const db = createDb()
    execSql(db, result.sql)
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM exam_types')).toEqual([{ n: 1 }])
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM subjects')).toEqual([{ n: 1 }])
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM modules')).toEqual([{ n: 6 }])

    // 题目行：qid/kind/模块挂对/group NULL/富片段 JSON 形态/answer/可空列 NULL/vision_text 空串
    const questionRows = rows<{
      qid: string
      kind: string
      module_code: string
      group_id: number | null
      stem: string
      options: string
      answer: string
      analysis: string
      difficulty: string | null
      year: number | null
      region: string | null
      paper_type: string | null
      vision_text: string
    }>(
      db,
      `SELECT q.qid AS qid, q.kind AS kind, m.code AS module_code, q.group_id AS group_id, q.stem AS stem,
              q.options AS options, q.answer AS answer, q.analysis AS analysis, q.difficulty AS difficulty,
              q.year AS year, q.region AS region, q.paper_type AS paper_type, q.vision_text AS vision_text
       FROM questions q JOIN modules m ON m.id = q.module_id ORDER BY q.qid`,
    )
    expect(questionRows).toHaveLength(2)
    const alpha = questionRows.find((row) => row.qid === `shot-${baseA}`)
    const beta = questionRows.find((row) => row.qid === `shot-${baseB}`)
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    expect(alpha?.kind).toBe('single_choice')
    expect(alpha?.module_code).toBe('verbal')
    expect(alpha?.group_id).toBeNull()
    expect(alpha?.difficulty).toBeNull()
    expect(alpha?.year).toBeNull()
    expect(alpha?.region).toBeNull()
    expect(alpha?.paper_type).toBeNull()
    expect(alpha?.vision_text).toBe('')
    // 富片段形态：文本单段数组（一期纯文本化，ADR-0014 决策 3）
    expect(JSON.parse(alpha?.stem ?? '[]')).toEqual([
      { type: 'text', text: '下列关于虚构概念的表述，正确的是：' },
    ])
    expect(JSON.parse(alpha?.options ?? '[]')).toEqual([
      { key: 'A', content: [{ type: 'text', text: '虚构选项甲' }] },
      { key: 'B', content: [{ type: 'text', text: '虚构选项乙' }] },
      { key: 'C', content: [{ type: 'text', text: '虚构选项丙' }] },
      { key: 'D', content: [{ type: 'text', text: '虚构选项丁' }] },
    ])
    expect(JSON.parse(alpha?.analysis ?? '[]')).toEqual([
      { type: 'text', text: '虚构解析：题干限定词指向选项乙。' },
    ])
    expect(alpha?.answer).toBe('B')
    expect(beta?.module_code).toBe('quantitative')
    expect(beta?.answer).toBe('A')

    // import_runs 行：version/status/stats（含截图统计）
    const runs = rows<{ version: number; status: string; stats: string }>(
      db,
      'SELECT version, status, stats FROM import_runs',
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]?.version).toBe(9)
    expect(runs[0]?.status).toBe('success')
    expect(JSON.parse(runs[0]?.stats ?? '{}')).toEqual({
      shotQuestions: 2,
      gatedSkipped: 0,
      errorSkipped: 0,
    })
    db.close()
  })

  it('质量门：missing_answer 与 answer_not_in_options 与 no_options warning 级跳过不写半截，同批合法题照常入库', () => {
    putScreenshot('gate-empty.png')
    putScreenshot('gate-bad.png')
    putScreenshot('gate-noopt.png')
    putScreenshot('gate-ok.png')
    writeStaging('gate-empty', stagingOf({ answer: '' }))
    writeStaging('gate-bad', stagingOf({ answer: 'Z' }))
    writeStaging('gate-noopt', stagingOf())
    writeStaging('gate-ok', stagingOf({ moduleCode: 'common_sense' }))
    runShotAbsorb({ productsDir })
    confirmDraft('gate-empty')
    confirmDraft('gate-bad')
    confirmDraft('gate-noopt', { options: [] }) // 人工误编辑清空选项（no_options 门）
    confirmDraft('gate-ok')

    const result = runShotEmit({ productsDir, version: 9 })
    expect(result.stats).toEqual({ shotQuestions: 1, gatedSkipped: 3, errorSkipped: 0 })
    // 草稿文件名字典序：gate-bad（answer_not_in_options）→ gate-empty（missing_answer）→ gate-noopt（no_options）
    expect(result.issues.map((entry) => [entry.severity, entry.code, entry.qid])).toEqual([
      ['warning', 'answer_not_in_options', 'shot-gate-bad'],
      ['warning', 'missing_answer', 'shot-gate-empty'],
      ['warning', 'no_options', 'shot-gate-noopt'],
    ])
    // 门控题不产生任何题目语句（防半截行）
    expect(result.sql).not.toContain('shot-gate-empty')
    expect(result.sql).not.toContain('shot-gate-bad')
    expect(result.sql).not.toContain('shot-gate-noopt')
    expect(result.sql).toContain('shot-gate-ok')

    const db = createDb()
    execSql(db, result.sql)
    expect(rows<{ qid: string }>(db, 'SELECT qid FROM questions').map((row) => row.qid)).toEqual([
      'shot-gate-ok',
    ])
    db.close()
  })

  it('draft 状态不进 SQL：未确认草稿既不产语句也不记 issue；全部 draft → 不写文件、import_runs 不记、CLI 退出 0', async () => {
    putScreenshot('pending.png')
    writeStaging('pending', stagingOf())
    runShotAbsorb({ productsDir })
    // 草稿保持 draft（人工未确认）

    const result = runShotEmit({ productsDir, version: 9 })
    expect(result.sql).toBe('')
    expect(result.sqlPath).toBe('')
    expect(result.stats).toEqual({ shotQuestions: 0, gatedSkipped: 0, errorSkipped: 0 })
    expect(result.issues).toEqual([])
    expect(fs.existsSync(path.join(productsDir, 'shot.sql'))).toBe(false)

    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await main(['shot', '--products', productsDir, '--emit', '--version', '9'])).toBe(0)
  })

  it('草稿结构破坏：qid 与文件名派生不一致 / 未知 status / 文件名非 shot- 前缀 → error 跳过，合法题照常入库', () => {
    putScreenshot('mismatch.png')
    putScreenshot('badstatus.png')
    putScreenshot('ok.png')
    writeStaging('mismatch', stagingOf())
    writeStaging('badstatus', stagingOf())
    writeStaging('ok', stagingOf())
    runShotAbsorb({ productsDir })
    confirmDraft('mismatch', { qid: 'shot-other' })
    // 未知 status（大小写手误）：不经 confirmDraft（其恒置 confirmed），手写坏状态草稿
    fs.writeFileSync(
      path.join(productsDir, 'shot-drafts', 'shot-badstatus.json'),
      serializeJson({ ...readDraft('badstatus'), status: 'CONFIRMED' }),
      'utf8',
    )
    confirmDraft('ok')
    // 非 shot-<基名> 命名的草稿文件（人工改名破坏幂等键载体）
    fs.writeFileSync(
      path.join(productsDir, 'shot-drafts', 'plain.json'),
      serializeJson({ qid: 'x', status: 'confirmed' }),
      'utf8',
    )

    const result = runShotEmit({ productsDir, version: 9 })
    expect(result.stats).toEqual({ shotQuestions: 1, gatedSkipped: 0, errorSkipped: 3 })
    // 草稿文件名字典序（JS 码元序）：plain.json < shot-badstatus.json < shot-mismatch.json
    expect(result.issues.map((entry) => [entry.severity, entry.code, entry.qid])).toEqual([
      ['error', 'shot_draft_name_invalid', null],
      ['error', 'shot_draft_status_invalid', 'shot-badstatus'],
      ['error', 'shot_draft_qid_mismatch', 'shot-mismatch'],
    ])
    expect(result.sql).toContain('shot-ok')
    expect(result.sql).not.toContain('shot-other')

    const db = createDb()
    execSql(db, result.sql)
    expect(rows<{ qid: string }>(db, 'SELECT qid FROM questions').map((row) => row.qid)).toEqual([
      'shot-ok',
    ])
    db.close()
  })

  it('幂等重放：同一 shot.sql 再执行 → 题目行快照不变（ON CONFLICT 原地更新不换行不重复）', () => {
    confirmedTwo()
    const result = runShotEmit({ productsDir, version: 9 })

    const db = createDb()
    execSql(db, result.sql)
    const snapshot = rows<{ qid: string; stem: string; options: string; answer: string }>(
      db,
      'SELECT qid, stem, options, answer FROM questions ORDER BY qid',
    )
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM questions')).toEqual([{ n: 2 }])
    execSql(db, result.sql)
    expect(
      rows<{ qid: string; stem: string; options: string; answer: string }>(
        db,
        'SELECT qid, stem, options, answer FROM questions ORDER BY qid',
      ),
    ).toEqual(snapshot)
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM questions')).toEqual([{ n: 2 }])
    expect(rows<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM import_runs')).toEqual([{ n: 1 }])
    db.close()
  })

  it('字节确定性：同草稿同 version 两次生成全等；每语句一行以 ; 结尾；无事务/绝对路径/BOM；换 version 则 SQL 不同', () => {
    confirmedTwo()
    const a = runShotEmit({ productsDir, version: 9 })
    const b = runShotEmit({ productsDir, version: 9 })
    expect(b.sql).toBe(a.sql)

    const lines = a.sql.split('\n')
    expect(lines[lines.length - 1]).toBe('')
    for (const line of lines.slice(1, -1)) expect(line.endsWith(';')).toBe(true)
    expect(a.sql).not.toContain('BEGIN')
    expect(a.sql).not.toContain('COMMIT')
    expect(a.sql).not.toContain(path.resolve(productsDir))
    expect(a.sql.charCodeAt(0)).not.toBe(0xfeff)

    const c = runShotEmit({ productsDir, version: 10 })
    expect(c.sql).not.toBe(a.sql)
    // version 只影响头注释与 import_runs 行（分类体系段与题目语句段不变）
    expect(c.sql.split('\n').slice(1, 11)).toEqual(a.sql.split('\n').slice(1, 11))
  })

  it('空草稿目录（shot-drafts 缺失）→ 不写文件退出 0', async () => {
    const result = runShotEmit({ productsDir, version: 9 })
    expect(result.sql).toBe('')
    expect(result.stats).toEqual({ shotQuestions: 0, gatedSkipped: 0, errorSkipped: 0 })
    expect(fs.existsSync(path.join(productsDir, 'shot.sql'))).toBe(false)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await main(['shot', '--products', productsDir, '--emit', '--version', '9'])).toBe(0)
  })

  it('CLI 退出码：合法 emit 0；存在 error（草稿结构破坏）→ 1；用法错误 → 2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    confirmedTwo()
    expect(await main(['shot', '--products', productsDir, '--emit', '--version', '9'])).toBe(0)

    // 追加结构破坏的草稿（qid 手改）→ error 级 → 退出 1
    confirmDraft('alpha-1', { qid: 'shot-renamed' })
    expect(await main(['shot', '--products', productsDir, '--emit', '--version', '9'])).toBe(1)

    expect(await main(['shot', '--products', productsDir, '--emit'])).toBe(2)
    expect(await main(['shot', '--products', productsDir, '--emit', '--version', 'abc'])).toBe(2)
    expect(
      await main(['shot', '--products', path.join(outDir, 'nope'), '--emit', '--version', '1']),
    ).toBe(2)
  })
})
