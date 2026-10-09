/**
 * 导入编排：扫描输入目录 → 逐文件解析 → 全局 qid 去重 → 汇总统计 → 写 JSON 产物。
 * 幂等与确定性：同输入目录 + 同版本号 → 逐字节相同输出（不写时间戳等不确定值；
 * 排序固定为 模块序(01→06) → 文件名序(JS 码元序) → 文件内出现序）。
 * 题库数据不入 Git 仓库（ADR-0004）：产物目录由调用方保证已忽略（默认 .import-out/）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { MODULE_FOLDERS, moduleCodeOfFolder } from './modules.js'
import { parsePaper } from './parser/markdown.js'
import type {
  ImportIssue,
  ImportManifest,
  ModuleCode,
  ModuleStat,
  ParsedGroup,
  ParsedPaper,
  ParsedQuestion,
  RunImportResult,
} from './types.js'

export interface RunImportOptions {
  /** xingcezhenti 检出目录（绝对或相对路径） */
  inputDir: string
  /** 产物目录（建议默认 .import-out/，须已被 .gitignore 忽略） */
  outputDir: string
  /** 导入版本号（幂等键；import_runs 版本依据） */
  version: string
}

/** 路径越界（输入/产物根目录边界防护触发；CLI 转 退出码 2） */
export class ImportPathEscapeError extends Error {
  constructor(relative: string) {
    super(`路径越界，拒绝访问受限目录之外的路径：${relative}`)
    this.name = 'ImportPathEscapeError'
  }
}

/**
 * 解析 base 之下的相对片段并强制不越出 base（根目录边界，防路径穿越 CWE-22）：
 * 片段含 `../` 等导致 resolve 后逃出 base 时抛 ImportPathEscapeError。
 * base 为受信根（CLI 显式指定的输入/产物目录）；相对片段来自目录枚举与常量表。
 */
export function resolveWithin(base: string, relative: string): string {
  const root = path.resolve(base)
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ImportPathEscapeError(relative)
  }
  return resolved
}

/** isQuestion / isGroup 类型守卫（items 平铺混排） */
function isQuestion(item: ParsedQuestion | ParsedGroup): item is ParsedQuestion {
  return 'qid' in item
}

/** 输入目录内相对路径 → 模块 code（未登记目录返回 undefined） */
function moduleOfFile(file: string): ModuleCode | undefined {
  return moduleCodeOfFolder(file.split('/')[0] ?? '')
}

/**
 * 执行一次文本导入。
 * 退出语义由调用方决定：manifest.issues 中 severity 'error' 的条数 > 0 即存在硬错误。
 */
export function runImport(options: RunImportOptions): RunImportResult {
  const inputAbs = path.resolve(options.inputDir).replace(/\\/g, '/')
  const outputAbs = path.resolve(options.outputDir)
  const issues: ImportIssue[] = []
  const papersByModule = new Map<ModuleCode, ParsedPaper[]>()
  const filesByModule = new Map<ModuleCode, number>()
  /** qid → 首见文件（全局去重依据；qid 为全库唯一自然键） */
  const seenQids = new Map<string, string>()

  for (const moduleFolder of MODULE_FOLDERS) {
    const moduleDir = resolveWithin(inputAbs, moduleFolder.folder)
    let dirStat: fs.Stats | undefined
    try {
      dirStat = fs.statSync(moduleDir)
    } catch {
      dirStat = undefined
    }
    if (dirStat === undefined || !dirStat.isDirectory()) continue // 输入允许只含部分模块

    const fileNames = fs
      .readdirSync(moduleDir)
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .sort()
    for (const fileName of fileNames) {
      const fileRel = `${moduleFolder.folder}/${fileName}`
      let source: string
      try {
        source = fs.readFileSync(resolveWithin(moduleDir, fileName), 'utf8')
      } catch (err) {
        issues.push(
          importIssue(
            'error',
            'read_error',
            fileRel,
            null,
            `文件读取失败：${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        continue
      }
      filesByModule.set(moduleFolder.code, (filesByModule.get(moduleFolder.code) ?? 0) + 1)
      const { paper, issues: fileIssues } = parsePaper(source, {
        file: fileRel,
        module: moduleFolder.code,
      })
      issues.push(...fileIssues)
      if (paper === null) continue
      dropDuplicateQids(paper, issues, seenQids)
      const list = papersByModule.get(moduleFolder.code) ?? []
      list.push(paper)
      papersByModule.set(moduleFolder.code, list)
    }
  }

  // ---- 统计（issues 按文件归属模块；统计键序 = MODULE_FOLDERS 固定序） ----
  const byModule: Partial<Record<ModuleCode, ModuleStat>> = {}
  const emptyStat = (): ModuleStat => ({
    files: 0,
    papers: 0,
    questions: 0,
    groups: 0,
    errors: 0,
    warnings: 0,
  })
  for (const moduleFolder of MODULE_FOLDERS) {
    const code = moduleFolder.code
    if (!filesByModule.has(code)) continue
    const stat = emptyStat()
    stat.files = filesByModule.get(code) ?? 0
    for (const paper of papersByModule.get(code) ?? []) {
      stat.papers++
      for (const item of paper.items) {
        if (isQuestion(item)) stat.questions++
        else stat.groups++
      }
    }
    for (const entry of issues) {
      const issueModule = moduleOfFile(entry.file)
      if (issueModule !== code) continue
      if (entry.severity === 'error') stat.errors++
      else stat.warnings++
    }
    byModule[code] = stat
  }
  const totalStat: ModuleStat = {
    files: 0,
    papers: 0,
    questions: 0,
    groups: 0,
    errors: 0,
    warnings: 0,
  }
  for (const code of Object.keys(byModule) as ModuleCode[]) {
    const stat = byModule[code]
    if (stat === undefined) continue
    totalStat.files += stat.files
    totalStat.papers += stat.papers
    totalStat.questions += stat.questions
    totalStat.groups += stat.groups
    totalStat.errors += stat.errors
    totalStat.warnings += stat.warnings
  }

  const manifest: ImportManifest = {
    version: options.version,
    input: inputAbs,
    moduleOrder: MODULE_FOLDERS.map((m) => m.code),
    stats: totalStat,
    byModule,
    issues,
  }

  // ---- 产物写出（先清空旧 modules/*.json，实现同目录重跑的干净覆盖） ----
  const modulesDir = resolveWithin(outputAbs, 'modules')
  fs.mkdirSync(modulesDir, { recursive: true })
  for (const stale of fs.existsSync(modulesDir) ? fs.readdirSync(modulesDir) : []) {
    if (stale.endsWith('.json')) fs.rmSync(resolveWithin(modulesDir, stale))
  }
  const wrote: string[] = []
  const manifestPath = resolveWithin(outputAbs, 'import-manifest.json')
  fs.writeFileSync(manifestPath, serializeJson(manifest), 'utf8')
  wrote.push(manifestPath)
  for (const moduleFolder of MODULE_FOLDERS) {
    const papers = papersByModule.get(moduleFolder.code)
    if (papers === undefined || papers.length === 0) continue
    const modulePath = resolveWithin(modulesDir, `${moduleFolder.code}.json`)
    fs.writeFileSync(modulePath, serializeJson({ module: moduleFolder.code, papers }), 'utf8')
    wrote.push(modulePath)
  }

  return { manifest, hardErrors: totalStat.errors, wrote }
}

/**
 * 全局 qid 去重：保留首见、丢弃后见并记入问题清单（不静默丢弃）；
 * 题组 questionQids 引用同步清除被丢弃的小题。
 */
function dropDuplicateQids(
  paper: ParsedPaper,
  issues: ImportIssue[],
  seenQids: Map<string, string>,
): void {
  const dropped = new Set<string>()
  paper.items = paper.items.filter((item) => {
    if (!isQuestion(item)) return true
    const firstSeen = seenQids.get(item.qid)
    if (firstSeen === undefined) {
      seenQids.set(item.qid, paper.file)
      return true
    }
    dropped.add(item.qid)
    issues.push(
      importIssue(
        'error',
        'duplicate_qid',
        paper.file,
        item.qid,
        `qid 重复（首见 ${firstSeen}），丢弃后见题目`,
      ),
    )
    return false
  })
  if (dropped.size === 0) return
  for (const item of paper.items) {
    if (isQuestion(item)) continue
    item.questionQids = item.questionQids.filter((qid) => !dropped.has(qid))
  }
}

/** 确定性 JSON 序列化：2 空格缩进 + 尾随换行（UTF-8、LF、无 BOM） */
function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function importIssue(
  severity: ImportIssue['severity'],
  code: string,
  file: string,
  qid: string | null,
  message: string,
): ImportIssue {
  return { severity, code, file, qid, message }
}
