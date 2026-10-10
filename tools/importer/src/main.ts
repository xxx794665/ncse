/**
 * @ncse/importer CLI 入口（T1-04 文本导入；T1-15 增 db 入库子命令；T1-05 增 images 图片子命令）。
 * parse 模式：node dist/main.js --input <xingcezhenti 检出目录> [--output <产物目录>] --version <导入版本号>
 * db 模式：node dist/main.js db --products <JSON 产物目录> --version <正整数> [--force]
 * （SQL 固定生成至 <产物目录>/import.sql，经 `wrangler d1 execute --file` 应用入库）
 * images 模式：node dist/main.js images --products <JSON 产物目录> [--input <源仓库目录>]
 * （压缩工件写至 <产物目录>/r2/，模块 JSON 图片段 path 原位重写为内容寻址键，
 * 问题清单与映射记 <产物目录>/images-manifest.json；--input 覆盖 manifest 登记的
 * 输入目录（源仓库迁移场景）。R2 上传属阶段 B——本子命令不做任何网络操作）
 * 产物目录默认 .import-out/（已被 .gitignore 忽略，题库数据不入 Git——ADR-0004）。
 * 退出码：parse 0 = 无硬错误（允许有 warning）；1 = 问题清单存在 error；2 = 参数/输入目录错误。
 * db 0 = SQL 生成成功（含跳过质量问题题目）；1 = 产物结构无效（manifest 缺失/模块 JSON 损坏）；
 * 2 = 用法错误（缺参数、version 非正整数、products 目录不存在）。
 * images 0 = 图片阶段成功（允许有 warning）；1 = 图片问题清单存在 error 或产物结构无效；
 * 2 = 用法错误（缺参数、products/input 目录不存在、路径越界）。
 * 本工具只读本地文件、不做任何网络请求。
 * main 为 async（images 阶段含 sharp 异步压缩）；测试与 CLI 入口均 await 其退出码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { runDbStage, InvalidProductsError } from './db-stage.js'
import { runImagesStage, InvalidInputDirError } from './image-stage.js'
import { ImportPathEscapeError, runImport } from './pipeline.js'
import type { DbStageResult, ImagesStageResult, RunImportResult } from './types.js'

const USAGE =
  '用法：node dist/main.js --input <xingcezhenti 检出目录> [--output <产物目录，默认 .import-out>] --version <导入版本号>'

const DB_USAGE =
  '用法：node dist/main.js db --products <JSON 产物目录> --version <正整数> [--force]（SQL 生成至 <产物目录>/import.sql）'

const IMAGES_USAGE =
  '用法：node dist/main.js images --products <JSON 产物目录> [--input <源仓库目录>]（工件写至 <产物目录>/r2/，路径重写写回 modules/*.json）'

/** 问题清单打印上限（其余完整记录在 import-manifest.json / images-manifest.json） */
const PRINT_ISSUE_LIMIT = 20

/** CLI 选项值（input/version 必填校验在命令函数内做） */
interface CliValues {
  input?: string
  output?: string
  version?: string
}

/** db 子命令选项值 */
interface DbCliValues {
  products?: string
  version?: string
  force?: boolean
}

/** images 子命令选项值 */
interface ImagesCliValues {
  products?: string
  input?: string
}

/**
 * CLI 主函数（供测试直接调用；返回退出码，不直接 process.exit 以保证输出冲刷）。
 * argv[0] === 'db' 进入 db 入库模式；argv[0] === 'images' 进入 images 图片模式；
 * 其余参数照旧为 parse 模式（行为向后兼容）。
 */
export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'db') return runDbCommand(argv.slice(1))
  if (argv[0] === 'images') return runImagesCommand(argv.slice(1))
  return runParseCommand(argv)
}

/** parse 模式（T1-04 原行为）：文本导入 → JSON 中间产物 */
function runParseCommand(argv: string[]): number {
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

/** db 模式（T1-15）：JSON 产物 → 确定性幂等 upsert SQL（写回 <产物目录>/import.sql） */
function runDbCommand(argv: string[]): number {
  let values: DbCliValues
  try {
    values = parseArgs({
      args: argv,
      options: {
        products: { type: 'string' },
        version: { type: 'string' },
        force: { type: 'boolean' },
      },
    }).values
  } catch (err) {
    console.error(`参数错误：${err instanceof Error ? err.message : String(err)}\n${DB_USAGE}`)
    return 2
  }
  const products = values.products
  const version = values.version
  if (products === undefined || products === '' || version === undefined || version === '') {
    console.error(DB_USAGE)
    return 2
  }
  if (!/^[0-9]+$/.test(version) || Number(version) <= 0) {
    console.error(`--version 须为正整数：${version}`)
    return 2
  }
  const productsAbs = path.resolve(products)
  let isDir = false
  try {
    isDir = fs.statSync(productsAbs).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) {
    console.error(`产物目录不存在或不是目录：${productsAbs}`)
    return 2
  }

  let result: DbStageResult
  try {
    result = runDbStage({
      productsDir: productsAbs,
      version: Number(version),
      force: values.force,
    })
  } catch (err) {
    // 产物结构无效 → 1（可由重新 parse 修复）；路径越界按用法错误 → 2；其余异常如实上抛
    if (err instanceof InvalidProductsError) {
      console.error(err.message)
      return 1
    }
    if (err instanceof ImportPathEscapeError) {
      console.error(err.message)
      return 2
    }
    throw err
  }
  console.log(`入库 SQL 已生成：${result.sqlPath}`)
  console.log(`导入统计：题目 ${result.stats.questions}，题组 ${result.stats.questionGroups}`)
  if (result.skippedQids.length > 0) {
    console.error(
      `数据质量门：跳过题目 ${result.skippedQids.length} 道（--force 可强制导入，问题明细见 import-manifest.json）`,
    )
  }
  return 0
}

/** images 模式（T1-05 阶段 A）：产物图片段 → 压缩工件 + 内容寻址键 + 路径重写 */
async function runImagesCommand(argv: string[]): Promise<number> {
  let values: ImagesCliValues
  try {
    values = parseArgs({
      args: argv,
      options: {
        products: { type: 'string' },
        input: { type: 'string' },
      },
    }).values
  } catch (err) {
    console.error(`参数错误：${err instanceof Error ? err.message : String(err)}\n${IMAGES_USAGE}`)
    return 2
  }
  const products = values.products
  if (products === undefined || products === '') {
    console.error(IMAGES_USAGE)
    return 2
  }
  const productsAbs = path.resolve(products)
  let isDir = false
  try {
    isDir = fs.statSync(productsAbs).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) {
    console.error(`产物目录不存在或不是目录：${productsAbs}`)
    return 2
  }

  let result: ImagesStageResult
  try {
    result = await runImagesStage({ productsDir: productsAbs, inputDir: values.input })
  } catch (err) {
    // 产物结构无效 → 1（可由重新 parse 修复）；输入目录缺失/路径越界按用法错误 → 2；其余异常如实上抛
    if (err instanceof InvalidProductsError) {
      console.error(err.message)
      return 1
    }
    if (err instanceof InvalidInputDirError || err instanceof ImportPathEscapeError) {
      console.error(err.message)
      return 2
    }
    throw err
  }
  const stats = result.stats
  console.log(
    `图片阶段完成：图片段 ${stats.references}，成功 ${stats.compressed + stats.passthrough}，已重写 ${stats.alreadyKeyed}`,
  )
  console.log(`问题清单：错误 ${stats.errors}，警告 ${stats.warnings}（详见 images-manifest.json）`)
  console.log(`产物目录：${productsAbs}`)
  for (const entry of result.issues.slice(0, PRINT_ISSUE_LIMIT)) {
    const qid = entry.qid === null ? '' : ` qid=${entry.qid}`
    console.error(`[${entry.severity}] ${entry.file}${qid}：${entry.code} — ${entry.message}`)
  }
  const hidden = result.issues.length - PRINT_ISSUE_LIMIT
  if (hidden > 0) console.error(`…另有 ${hidden} 条问题未打印（见 images-manifest.json）`)
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
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
