/**
 * @ncse/importer CLI 入口（T1-04 文本导入）。
 * 用法：node dist/main.js --input <xingcezhenti 检出目录> [--output <产物目录>] --version <导入版本号>
 * 产物目录默认 .import-out/（已被 .gitignore 忽略，题库数据不入 Git——ADR-0004）。
 * 退出码：0 = 无硬错误（允许有 warning）；1 = 问题清单存在 error；2 = 参数/输入目录错误。
 * 本工具只读本地文件、不做任何网络请求；D1 入库与图片/视觉处理属 T1-05/T1-06。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { ImportPathEscapeError, runImport } from './pipeline.js'
import type { RunImportResult } from './types.js'

const USAGE =
  '用法：node dist/main.js --input <xingcezhenti 检出目录> [--output <产物目录，默认 .import-out>] --version <导入版本号>'

/** 问题清单打印上限（其余完整记录在 import-manifest.json） */
const PRINT_ISSUE_LIMIT = 20

/** CLI 选项值（input/version 必填校验在 main 内做） */
interface CliValues {
  input?: string
  output?: string
  version?: string
}

/**
 * CLI 主函数（供测试直接调用；返回退出码，不直接 process.exit 以保证输出冲刷）。
 */
export function main(argv: string[]): number {
  let values: CliValues
  try {
    values = parseArgs({
      args: argv,
      options: {
        input: { type: 'string' },
        output: { type: 'string', default: '.import-out' },
        version: { type: 'string' },
      },
    }).values
  } catch (err) {
    console.error(`参数错误：${err instanceof Error ? err.message : String(err)}\n${USAGE}`)
    return 2
  }
  const input = values.input
  const version = values.version
  if (input === undefined || input === '' || version === undefined || version === '') {
    console.error(USAGE)
    return 2
  }
  const inputAbs = path.resolve(input)
  let isDir = false
  try {
    isDir = fs.statSync(inputAbs).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) {
    console.error(`输入目录不存在或不是目录：${inputAbs}`)
    return 2
  }

  const outputDir = path.resolve(values.output ?? '.import-out')
  let result: RunImportResult
  try {
    result = runImport({ inputDir: inputAbs, outputDir, version })
  } catch (err) {
    // 输入/产物路径越界按参数级错误处理（退出码 2）；其余异常如实上抛
    if (err instanceof ImportPathEscapeError) {
      console.error(err.message)
      return 2
    }
    throw err
  }
  const stats = result.manifest.stats
  console.log(
    `导入完成：文件 ${stats.files}，试卷 ${stats.papers}，题目 ${stats.questions}，题组 ${stats.groups}`,
  )
  console.log(`问题清单：错误 ${stats.errors}，警告 ${stats.warnings}（详见 import-manifest.json）`)
  console.log(`产物目录：${outputDir}`)
  for (const entry of result.manifest.issues.slice(0, PRINT_ISSUE_LIMIT)) {
    const qid = entry.qid === null ? '' : ` qid=${entry.qid}`
    console.error(`[${entry.severity}] ${entry.file}${qid}：${entry.code} — ${entry.message}`)
  }
  const hidden = result.manifest.issues.length - PRINT_ISSUE_LIMIT
  if (hidden > 0) console.error(`…另有 ${hidden} 条问题未打印（见 import-manifest.json）`)
  return result.hardErrors > 0 ? 1 : 0
}

// 直接以 node 运行时自动执行（被测试 import 时不触发）
const isCliInvoke = (() => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
})()
if (isCliInvoke) {
  process.exitCode = main(process.argv.slice(2))
}
