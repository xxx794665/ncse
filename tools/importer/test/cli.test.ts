/**
 * CLI/管线集成测试（T1-04）：runImport 编排（统计/去重/产物写出）+ main 退出码
 * + 幂等性（同输入 + 同版本号两次运行产物逐字节一致）。
 * 夹具全部为合成虚构题目；产物写入系统临时目录，测试后清理。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/main.js'
import { ImportPathEscapeError, resolveWithin, runImport } from '../src/pipeline.js'
import type { ParsedGroup, ParsedPaper, ParsedQuestion } from '../src/types.js'

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))
const cleanInput = path.join(fixturesDir, 'clean-input')
const errorInput = path.join(fixturesDir, 'error-input')

// 模块加载即建临时目录：describe 体在 beforeAll 之前执行，会引用 outDir
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncse-importer-test-'))

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 递归收集目录下全部文件的相对路径（POSIX 分隔，排序保证稳定） */
function listFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel)
      else files.push(childRel)
    }
  }
  walk(root, '')
  return files.sort()
}

/** 目录快照：相对路径 → 文件字节 */
function snapshotDir(root: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>()
  for (const rel of listFiles(root)) {
    snapshot.set(rel, fs.readFileSync(path.join(root, rel)))
  }
  return snapshot
}

function questionsOf(paper: ParsedPaper): ParsedQuestion[] {
  return paper.items.filter((item): item is ParsedQuestion => 'qid' in item)
}

function groupsOf(paper: ParsedPaper): ParsedGroup[] {
  return paper.items.filter((item): item is ParsedGroup => !('qid' in item))
}

function readModulePapers(outRoot: string, module: string): ParsedPaper[] {
  const raw = fs.readFileSync(path.join(outRoot, 'modules', `${module}.json`), 'utf8')
  return (JSON.parse(raw) as { papers: ParsedPaper[] }).papers
}

function readManifest(outRoot: string): { issues: Array<{ code: string; severity: string; qid: string | null }> } {
  return JSON.parse(fs.readFileSync(path.join(outRoot, 'import-manifest.json'), 'utf8'))
}

describe('runImport：合成干净输入', () => {
  it('统计与产物文件（根 README/90-图片 等非试卷输入被忽略）', () => {
    const out = path.join(outDir, 'clean')
    const result = runImport({ inputDir: cleanInput, outputDir: out, version: 'v-test' })
    expect(result.hardErrors).toBe(0)
    expect(result.manifest.stats).toEqual({
      files: 7,
      papers: 7,
      questions: 12,
      groups: 3,
      errors: 0,
      warnings: 0,
    })
    expect(Object.keys(result.manifest.byModule)).toEqual([
      'political_theory',
      'common_sense',
      'verbal',
      'quantitative',
      'judgement',
      'data_analysis',
    ])
    expect(result.manifest.byModule.data_analysis).toEqual({
      files: 2,
      papers: 2,
      questions: 4,
      groups: 2,
      errors: 0,
      warnings: 0,
    })
    // 产物 = manifest + 6 个模块 JSON；manifest 无时间戳等不确定值
    expect(listFiles(out)).toEqual([
      'import-manifest.json',
      'modules/common_sense.json',
      'modules/data_analysis.json',
      'modules/judgement.json',
      'modules/political_theory.json',
      'modules/quantitative.json',
      'modules/verbal.json',
    ])
    expect(result.manifest.version).toBe('v-test')
  })

  it('分模块 JSON 内容可读且元数据 null 用例落地', () => {
    const out = path.join(outDir, 'clean-content')
    runImport({ inputDir: cleanInput, outputDir: out, version: 'v-test' })
    const papers = readModulePapers(out, 'data_analysis')
    expect(papers).toHaveLength(2)
    expect(papers[0].name).toBe('2024年某省公务员录用考试《行测》题（虚构己卷）')
    expect(questionsOf(papers[0])).toHaveLength(3)
    expect(groupsOf(papers[0])).toHaveLength(2)
    expect(papers[1].name).toBe('虚构内部测试卷')
    expect(papers[1].year).toBeNull()
    expect(papers[1].region).toBeNull()
    expect(papers[1].paperType).toBeNull()
    expect(questionsOf(papers[1])[0].qid).toBe('900604')
  })
})

describe('幂等与确定性', () => {
  it('同输入 + 同版本号两次运行（同目录）→ 产物逐字节一致', () => {
    const out = path.join(outDir, 'idem')
    runImport({ inputDir: cleanInput, outputDir: out, version: 'v-idem' })
    const first = snapshotDir(out)
    runImport({ inputDir: cleanInput, outputDir: out, version: 'v-idem' })
    const second = snapshotDir(out)
    expect([...second.keys()]).toEqual([...first.keys()])
    for (const [rel, bytes] of first) {
      expect(second.get(rel)?.equals(bytes)).toBe(true)
    }
  })

  it('同输入 + 同版本号运行到两个不同目录 → 逐字节一致', () => {
    const outA = path.join(outDir, 'idem-a')
    const outB = path.join(outDir, 'idem-b')
    runImport({ inputDir: cleanInput, outputDir: outA, version: 'v-idem2' })
    runImport({ inputDir: cleanInput, outputDir: outB, version: 'v-idem2' })
    const snapA = snapshotDir(outA)
    const snapB = snapshotDir(outB)
    expect([...snapB.keys()]).toEqual([...snapA.keys()])
    for (const [rel, bytes] of snapA) {
      expect(snapB.get(rel)?.equals(bytes)).toBe(true)
    }
  })
})

describe('问题清单（错误输入夹具）', () => {
  const out = path.join(outDir, 'errors')

  it('答案不在选项中 / 缺失答案 → 记录且不丢题', () => {
    const result = runImport({ inputDir: errorInput, outputDir: out, version: 'v-err' })
    const issues = result.manifest.issues
    expect(issues.filter((entry) => entry.code === 'answer_not_in_options')).toHaveLength(1)
    expect(issues.find((entry) => entry.code === 'answer_not_in_options')?.qid).toBe('800101')
    const invalidAnswerQuestion = questionsOf(readModulePapers(out, 'verbal')[0]).find(
      (question) => question.qid === '800101',
    )
    // 答案原文保留（不静默丢弃/篡改），由入库阶段按问题清单把关
    expect(invalidAnswerQuestion?.answer).toBe('甲')
    expect(issues.filter((entry) => entry.code === 'missing_answer')).toHaveLength(1)
    const missingAnswerQuestion = questionsOf(readModulePapers(out, 'verbal')[1]).find(
      (question) => question.qid === '800103',
    )
    expect(missingAnswerQuestion?.answer).toBe('')
  })

  it('重复 qid → 保留首见、丢弃后见并明确列出；题组引用同步移除', () => {
    const manifest = readManifest(out)
    const duplicates = manifest.issues.filter((entry) => entry.code === 'duplicate_qid')
    expect(duplicates).toHaveLength(2)
    expect(duplicates.map((entry) => entry.qid).sort()).toEqual(['800102', '800105'])
    // 03-言语：卷一的 800102 保留，卷二的 800102 被丢弃
    const verbalQids = readModulePapers(out, 'verbal').flatMap((paper) => questionsOf(paper).map((q) => q.qid))
    expect(verbalQids.sort()).toEqual(['800101', '800102', '800103'])
    // 02-常识（先处理）：800105 首见保留
    expect(questionsOf(readModulePapers(out, 'common_sense')[0]).map((q) => q.qid)).toEqual(['800105'])
    // 06-资料（后处理）：组内 800105 被丢弃，题组引用同步清空
    const daPapers = readModulePapers(out, 'data_analysis')
    expect(questionsOf(daPapers[0])).toHaveLength(0)
    expect(groupsOf(daPapers[0])[0].questionQids).toEqual([])
  })

  it('缺失 qid 的题被丢弃；孤儿小题按独立题处理并告警', () => {
    const manifest = readManifest(out)
    expect(manifest.issues.filter((entry) => entry.code === 'missing_qid')).toHaveLength(1)
    expect(manifest.issues.filter((entry) => entry.code === 'orphan_question')).toHaveLength(1)
    const political = readModulePapers(out, 'political_theory')
    const qids = political.flatMap((paper) => questionsOf(paper).map((q) => q.qid))
    // 卷三缺 qid 题丢弃、孤儿 800203 保留；卷四 800401 保留
    expect(qids.sort()).toEqual(['800203', '800401'])
  })

  it('总统计与硬错误判定（warning 不判失败）', () => {
    const result = runImport({ inputDir: errorInput, outputDir: out, version: 'v-err' })
    expect(result.manifest.stats).toEqual({
      files: 6,
      papers: 6,
      questions: 6,
      groups: 1,
      errors: 6,
      warnings: 2,
    })
    expect(result.hardErrors).toBe(6)
    const codes = new Set(result.manifest.issues.map((entry) => entry.code))
    expect(codes).toContain('count_mismatch')
    expect(codes).toContain('checkmark_mismatch')
  })
})

describe('CLI 退出码（main）', () => {
  const spyConsole = (): void => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  it('缺参数 → 2', () => {
    spyConsole()
    expect(main([])).toBe(2)
    expect(main(['--input', cleanInput])).toBe(2)
  })

  it('输入目录不存在 → 2', () => {
    spyConsole()
    expect(main(['--input', path.join(outDir, 'no-such-dir'), '--version', 'v'])).toBe(2)
  })

  it('干净输入 → 0；含硬错误输入 → 1', () => {
    spyConsole()
    expect(main(['--input', cleanInput, '--output', path.join(outDir, 'cli-clean'), '--version', 'v'])).toBe(0)
    expect(main(['--input', errorInput, '--output', path.join(outDir, 'cli-err'), '--version', 'v'])).toBe(1)
  })
})

describe('路径边界防护（根目录界内校验，CWE-22）', () => {
  it('根目录之内的相对片段正常解析', () => {
    const base = path.join(outDir, 'guard-base')
    expect(resolveWithin(base, 'sub')).toBe(path.resolve(base, 'sub'))
    expect(resolveWithin(base, path.join('sub', 'file.md'))).toBe(path.resolve(base, 'sub', 'file.md'))
  })

  it('../ 越出根目录 → 抛 ImportPathEscapeError', () => {
    const base = path.join(outDir, 'guard-base')
    expect(() => resolveWithin(base, '../escape')).toThrow(ImportPathEscapeError)
    expect(() => resolveWithin(base, 'a/../../escape')).toThrow(ImportPathEscapeError)
  })
})
