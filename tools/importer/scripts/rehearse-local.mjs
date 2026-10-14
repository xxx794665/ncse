#!/usr/bin/env node
/**
 * 本地彩排脚本（T1-08h 前半）：把合成夹具数据链（parse → images → R2 本地态 put →
 * db → D1 迁移 → D1 入库）在进程内一次跑通，落库本地 D1 与 apps/api 本地 R2 态，
 * 供主会话 `wrangler dev`（同态）冒烟直接消费。
 * 用法：
 *   node tools/importer/scripts/rehearse-local.mjs --source <题库源目录>
 *     [--products <产物目录，默认 .import-out>] [--version <正整数，默认 1>]
 *     [--db <D1库名，默认 ncse-db>] [--bucket <R2桶名，默认 ncse-images>]
 * 设计要点：
 * - --source 必填、相对当前 cwd 解析（--products 同理）；脚本自身的 import/spawn
 *   定位一律从 import.meta.url 解析（scripts/ 与 dist/ 同属 tools/importer/），
 *   不依赖 cwd。
 * - parse/images/db 三阶段进程内复用 tools/importer/dist 的 main()（退出码语义与
 *   CLI 完全一致）；images 阶段不带 --bucket——上传由本脚本接手（原因见下）。
 * - R2 本地态 put 必须以 cwd=apps/api 执行 wrangler 才落 apps-api 本地态
 *   （wrangler dev 同态可读；T1-08d 实证）。importer 的 uploadArtifacts 固定以
 *   r2/ 工件根为 spawn cwd（远端/通用场景），落态不在 apps/api，本地彩排不适用。
 * - put 循环顺序执行：T1-05 实测 wrangler 4.148 本地态并发 put 会写冲突（500）。
 * - 安全模式照抄 src/r2-upload.ts（CWE-78 纵深防御）：①node 直启仓库根
 *   node_modules/wrangler/bin/wrangler.js（绝不走 shell——spawn 显式 shell:false、
 *   参数数组直传）；②put 前先以「--file=对象键」的规范形态过 isSafePutArgs 白名单
 *   复检（桶名/对象键/mime 动态参数与旗标位在此完成校验；实际 spawn 的 --file 为
 *   相对 apps/api 的工件相对路径——以 '.' 开头非旗标形态，其界内一致性由 resolve
 *   复检兜底，绝对路径不进 argv）；③ensureWranglerJs 定位 wrangler.js；④mime 按
 *   扩展（.webp→image/webp、.gif→image/gif，其余跳过并计数告警——工件区只应有
 *   webp/gif）；⑤单对象失败记日志不中断其余，结尾有失败则本步失败。
 * - 全程 --local 零网络零凭据；D1 迁移幂等（已应用则 no-op）；入库 SQL 为确定性
 *   幂等 upsert（同 version 重跑覆盖不增行，import_runs 唯一键 version）。
 * - 交互式确认：子进程 stdin 为 ignore（非 TTY），正常不应触发确认挂起（迁移已
 *   应用应为 no-op、d1 execute --local 无确认）；本脚本不设超时，若真挂起将如实
 *   暴露待调查——不吞错、不用超时掩盖。
 * 退出码：0 = 全绿；1 = 任一彩排步骤失败（阶段退出码非 0 / 子进程退出码非 0 /
 * 启动失败）；2 = 用法错误（参数缺失或形态不符、源目录不存在）或环境缺构建产物
 * （dist 缺失，与 importer 的 MissingWranglerError→2 同语义：环境缺工具属用法级）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const USAGE =
  '用法：node tools/importer/scripts/rehearse-local.mjs --source <题库源目录> [--products <产物目录，默认 .import-out>] [--version <正整数，默认 1>] [--db <D1库名，默认 ncse-db>] [--bucket <R2桶名，默认 ncse-images>]'

/** 脚本与仓库定位：一律从 import.meta.url 解析，不依赖 cwd（apps-api 路径亦然） */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const IMPORTER_ROOT = path.resolve(SCRIPT_DIR, '..')
const REPO_ROOT = path.resolve(IMPORTER_ROOT, '../..')
const DIST_MAIN = path.join(IMPORTER_ROOT, 'dist', 'main.js')
const DIST_R2_UPLOAD = path.join(IMPORTER_ROOT, 'dist', 'r2-upload.js')
/** wrangler.js 直启路径（仓库根 node_modules；scripts/ 上两级即仓库根） */
const WRANGLER_JS = path.join(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
/** 本地态落点：wrangler 子命令必须以 cwd=apps/api 执行才落 apps-api 本地态（T1-08d 实证） */
const APPS_API_DIR = path.join(REPO_ROOT, 'apps', 'api')

/** 失败消息携带的子进程输出尾部截断长度（诊断够用即可，避免日志失控） */
const OUTPUT_TAIL_LIMIT = 300

/** 彩排步骤总数（步骤序号打印用；结尾汇总不计步） */
const STEP_COUNT = 7

/**
 * 彩排运行态：步骤状态与 R2 上传统计（汇总打印用；失败明细记入 images.failures，
 * 单对象失败不中断循环，结尾统一裁决）。
 */
const runState = {
  steps: [],
  images: { keys: 0, uploaded: 0, skipped: 0, failures: [] },
}

/** 彩排步骤失败（中文消息 + 退出码；由顶层统一汇总并非零退出，不在各步散落 process.exit） */
class StepFailure extends Error {
  /** 退出码：1 = 管线失败；2 = 用法级/环境缺工具 */
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'StepFailure'
    this.exitCode = exitCode
  }
}

/** 用法错误（消息含完整用法说明；顶层统一打印并退出 2，避免 process.exit 截断管道输出） */
class UsageError extends Error {
  constructor(message) {
    super(`${message}\n${USAGE}`)
    this.name = 'UsageError'
  }
}

/** 步骤序号日志（统一「[n/7] 步骤名：说明」形态） */
function logStep(index, message) {
  console.log(`[${index}/${STEP_COUNT}] ${message}`)
}

/** 记录一步成功状态（汇总打印用） */
function markStep(name, note) {
  runState.steps.push({ name, status: '成功', note })
}

/** 步骤失败：记录失败状态后抛 StepFailure（顶层兜底汇总并非零退出） */
function failStep(name, message, exitCode = 1) {
  runState.steps.push({ name, status: '失败', note: message })
  throw new StepFailure(message, exitCode)
}

/** 子进程输出尾部截断（错误诊断多在尾部；截断以「…」前缀标记） */
function tailOf(text) {
  const trimmed = text.trim()
  return trimmed.length <= OUTPUT_TAIL_LIMIT ? trimmed : `…${trimmed.slice(-OUTPUT_TAIL_LIMIT)}`
}

/** Windows 路径分隔符转 POSIX（子进程 argv 中的相对路径统一正斜杠形态） */
function toPosix(p) {
  return p.replace(/\\/g, '/')
}

/**
 * 命令行参数解析（node:util parseArgs；用法错误打印用法并退出 2）。
 * --source 必填且须为存在的目录；--version 须为正整数；--db 首字符限定字母数字
 * （防「--」旗标伪装——库名会进入子进程 argv，与 r2-upload 键白名单同理）；
 * --bucket 不在此处校验（put 前经 isSafePutArgs 桶名白名单复检，无图片工件时
 * 不会用到桶名）。
 */
function parseCliArgs(argv) {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        source: { type: 'string' },
        products: { type: 'string', default: '.import-out' },
        version: { type: 'string', default: '1' },
        db: { type: 'string', default: 'ncse-db' },
        bucket: { type: 'string', default: 'ncse-images' },
      },
    }).values
  } catch (err) {
    throw new UsageError(`参数错误：${err instanceof Error ? err.message : String(err)}`)
  }
  if (values.source === undefined || values.source === '') {
    throw new UsageError('--source 必填')
  }
  if (!/^[0-9]+$/.test(values.version) || Number(values.version) <= 0) {
    throw new UsageError(`--version 须为正整数：${values.version}`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(values.db)) {
    throw new UsageError(
      `--db 须为合法库名（首字符字母数字，仅字母/数字/下划线/连字符）：${values.db}`,
    )
  }
  // 源目录存在性：与 importer 各阶段同语义的用法级校验（相对当前 cwd 解析）
  const sourceDir = path.resolve(values.source)
  let isDir = false
  try {
    isDir = fs.statSync(sourceDir).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) {
    throw new UsageError(`源目录不存在或不是目录：${sourceDir}`)
  }
  return {
    sourceDir,
    productsDir: path.resolve(values.products),
    version: values.version,
    db: values.db,
    bucket: values.bucket,
  }
}

/**
 * 递归收集 r2/ 工件键（相对 r2Root 的 POSIX 路径，排序确定性）。
 * 语义照抄 dist/r2-upload.ts 的 collectKeys（其未导出，此处等价重实现）：点开头的
 * 隐藏条目（目录与文件）一律跳过——工件区内容寻址键永不以 '.' 开头，而 wrangler
 * --local 会把本地态写进其 cwd 下的 .wrangler/，不跳过则重跑会误把状态文件当工件。
 * 键的组成部分来自实际 readdir 条目（非用户输入），路径越界无从发生；进入 argv
 * 前另有 isSafePutArgs 与 resolve 界内复检兜底。
 */
function collectKeys(r2Root) {
  const keys = []
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 目录不可读 = 无图可传（r2/ 整体缺失的场景由调用方先行跳过本步）
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue // 隐藏条目 = 工具自身状态（如 .wrangler/），非工件
      const childRel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel)
      else if (entry.isFile()) keys.push(childRel) // 符号链接等非常规文件不计（工件恒为常规文件）
    }
  }
  walk(r2Root, '')
  return keys.sort()
}

/** 扩展名 → Content-Type（工件区只应有 webp/gif；其余返回 null，调用方跳过并计数告警） */
function contentTypeOf(key) {
  if (key.endsWith('.webp')) return 'image/webp'
  if (key.endsWith('.gif')) return 'image/gif'
  return null
}

/**
 * 执行一次 wrangler 子命令：node 直启仓库根 wrangler.js（绝不走 shell——spawn
 * 显式 shell:false、参数数组直传），stdio 全采集。返回 { code, stdout, stderr }；
 * 进程级异常（启动失败/信号终止）折算 code -1 并把错误消息放入 stderr——局部化为
 * 该次调用的失败并如实携带诊断，不裸抛也不吞错。
 */
function runWrangler(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRANGLER_JS, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: `wrangler 进程启动失败：${err.message}` })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** 子进程失败诊断输出（stderr 优先、为空回退 stdout——wrangler 的诊断可能走任一流） */
function diagnosticOf(outcome) {
  return outcome.stderr !== '' ? outcome.stderr : outcome.stdout
}

/** 转发子进程输出（缩进两格；迁移/入库步骤留「no-op」「行数」等证据，静默则不打印） */
function printChildOutput(outcome) {
  const text = (outcome.stdout + (outcome.stderr !== '' ? `\n${outcome.stderr}` : '')).trim()
  if (text === '') return
  for (const line of text.split('\n')) console.log(`  ${line}`)
}

/**
 * 上传单个 r2 工件至本地 R2 态（由 put 循环顺序调用——T1-05 实测本地态并发 put
 * 写冲突）。安全模式照抄 r2-upload.ts：先以「--file=对象键」的规范形态过
 * isSafePutArgs 白名单复检（桶名/键/mime 与旗标位），实际 spawn 仅替换 --file 为
 * 相对 apps/api 的工件路径（POSIX 分隔、绝对路径不进 argv、resolve 界内复检）。
 * 单对象失败只记日志与失败明细，不中断其余对象。
 */
async function putArtifact(key, r2Root, cfg, safePutArgs) {
  const mime = contentTypeOf(key)
  if (mime === null) {
    runState.images.skipped++
    console.warn(`  告警：非 webp/gif 工件跳过上传（键 ${key}）`)
    return
  }
  const artifactAbs = path.join(r2Root, key)
  // --file 传相对 apps/api 的路径（wrangler 以 spawn cwd=apps/api 解析；绝对路径不进 argv）
  const fileRel = toPosix(path.relative(APPS_API_DIR, artifactAbs))
  // 界内复检：不得为绝对路径（products 与 apps/api 跨盘时 path.relative 会给绝对路径）、
  // 不得为旗标形态（首字符 '-'）、从 apps/api resolve 回去必须与预期工件一致（CWE-22）
  if (
    path.isAbsolute(fileRel) ||
    fileRel.startsWith('-') ||
    path.resolve(APPS_API_DIR, fileRel) !== path.resolve(artifactAbs)
  ) {
    runState.images.failures.push({
      key,
      code: -1,
      output: `--file 相对路径界内复检失败：${fileRel}`,
    })
    console.error(`  put ${key}：失败（--file 相对路径界内复检失败：${fileRel}）`)
    return
  }
  // isSafePutArgs 复检：以「--file=对象键」的规范形态校验桶名/对象键/mime 白名单与
  // 旗标位字面量（r2-upload 汇点第③层语义）；实际参数与规范形态仅 --file 一位不同
  const canonicalArgs = [
    'r2',
    'object',
    'put',
    `${cfg.bucket}/${key}`,
    '--file',
    key,
    '--content-type',
    mime,
    '--local',
  ]
  if (!safePutArgs(canonicalArgs)) {
    runState.images.failures.push({
      key,
      code: -1,
      output: `wrangler 参数白名单复检失败（形态不符，拒绝执行）：${cfg.bucket}/${key}`,
    })
    console.error(`  put ${key}：失败（参数白名单复检不符，拒绝执行）`)
    return
  }
  const args = [
    'r2',
    'object',
    'put',
    `${cfg.bucket}/${key}`,
    '--file',
    fileRel,
    '--content-type',
    mime,
    '--local',
  ]
  const outcome = await runWrangler(args, APPS_API_DIR)
  if (outcome.code === 0) {
    runState.images.uploaded++
    console.log(`  put ${key}：成功`)
    return
  }
  runState.images.failures.push({ key, code: outcome.code, output: diagnosticOf(outcome) })
  console.error(`  put ${key}：失败（退出码 ${outcome.code}）：${tailOf(diagnosticOf(outcome))}`)
}

/** 彩排主流程：七步顺序执行，任一步失败立即中止（StepFailure 上抛由顶层兜底） */
async function rehearse(cfg) {
  console.log(`彩排配置：source=${cfg.sourceDir}`)
  console.log(`  products=${cfg.productsDir}，version=${cfg.version}，db=${cfg.db}，bucket=${cfg.bucket}`)
  console.log(`  本地态根：${APPS_API_DIR}${path.sep}.wrangler（D1/R2 与 wrangler dev 同态）`)

  // ---- [1/7] 前置：dist 构建产物可用性 ----
  logStep(1, `前置检查：importer dist 构建产物（${path.join(IMPORTER_ROOT, 'dist')}）`)
  for (const distFile of [DIST_MAIN, DIST_R2_UPLOAD]) {
    if (!fs.existsSync(distFile)) {
      failStep(
        '前置',
        `构建产物缺失：${distFile}；请先在仓库根执行 npm run build:shared && npm run build -w tools/importer`,
        2,
      )
    }
  }
  markStep('前置', 'dist 构建产物就绪')
  // dist 模块进程内载入（main 为 async 返回退出码；r2-upload 提供安全模式工具）
  const { main } = await import(pathToFileURL(DIST_MAIN).href)
  const { ensureWranglerJs, isSafePutArgs } = await import(pathToFileURL(DIST_R2_UPLOAD).href)

  // ---- [2/7] parse：文本导入 → JSON 中间产物 ----
  logStep(2, `parse：--input ${cfg.sourceDir} --output ${cfg.productsDir} --version ${cfg.version}`)
  const parseCode = await main([
    '--input',
    cfg.sourceDir,
    '--output',
    cfg.productsDir,
    '--version',
    cfg.version,
  ])
  if (parseCode !== 0) {
    failStep('parse', `parse 阶段退出码 ${parseCode}（阶段日志见上，问题明细见 import-manifest.json）`)
  }
  markStep('parse', '退出码 0')

  // ---- [3/7] images：压缩工件 + 内容寻址键 + 路径重写（不带 --bucket，上传由本脚本接手） ----
  logStep(3, `images：--products ${cfg.productsDir}（不带 --bucket，R2 put 由本脚本以 cwd=apps/api 执行）`)
  const imagesCode = await main(['images', '--products', cfg.productsDir])
  if (imagesCode !== 0) {
    failStep('images', `images 阶段退出码 ${imagesCode}（阶段日志见上，问题明细见 images-manifest.json）`)
  }
  markStep('images', '退出码 0')

  // ---- [4/7] R2 本地态上传：顺序 put，落 apps-api 本地态 ----
  logStep(4, `R2 本地态上传：r2 object put ${cfg.bucket}/<键> --local（cwd=apps/api，顺序执行）`)
  const r2Root = path.join(cfg.productsDir, 'r2')
  if (!fs.existsSync(r2Root)) {
    console.log('  无图片工件（产物目录不含 r2/），跳过本步')
    runState.steps.push({ name: 'R2 上传', status: '跳过', note: '无图片工件' })
  } else {
    try {
      ensureWranglerJs(WRANGLER_JS)
    } catch (err) {
      failStep('R2 上传', err instanceof Error ? err.message : String(err), 2)
    }
    const keys = collectKeys(r2Root)
    runState.images.keys = keys.length
    for (const key of keys) {
      // 顺序执行（T1-05 实测 wrangler 4.148 本地态并发 put 写冲突 500）
      await putArtifact(key, r2Root, cfg, isSafePutArgs)
    }
    const { uploaded, skipped, failures } = runState.images
    console.log(`  put 结束：成功 ${uploaded}/${keys.length}，跳过 ${skipped}，失败 ${failures.length}`)
    if (failures.length > 0) {
      failStep('R2 上传', `R2 本地态上传失败 ${failures.length}/${keys.length} 个对象（失败明细见汇总）`)
    }
    markStep('R2 上传', `对象 ${uploaded}，跳过 ${skipped}`)
  }

  // ---- [5/7] db：JSON 产物 → 确定性幂等 upsert SQL（<产物目录>/import.sql） ----
  logStep(5, `db：--products ${cfg.productsDir} --version ${cfg.version}`)
  const dbCode = await main(['db', '--products', cfg.productsDir, '--version', cfg.version])
  if (dbCode !== 0) {
    failStep('db', `db 阶段退出码 ${dbCode}（阶段日志见上；退出码 1 = 产物结构无效）`)
  }
  markStep('db', '退出码 0')

  // ---- [6/7] D1 迁移：幂等（已应用则 no-op）----
  logStep(6, `D1 迁移：wrangler d1 migrations apply ${cfg.db} --local（cwd=apps/api，幂等）`)
  const migrateOutcome = await runWrangler(['d1', 'migrations', 'apply', cfg.db, '--local'], APPS_API_DIR)
  if (migrateOutcome.code !== 0) {
    failStep(
      'D1 迁移',
      `wrangler d1 migrations apply 退出码 ${migrateOutcome.code}：${tailOf(diagnosticOf(migrateOutcome))}`,
    )
  }
  printChildOutput(migrateOutcome)
  markStep('D1 迁移', '退出码 0')

  // ---- [7/7] D1 入库：执行 import.sql（幂等 upsert，同 version 重跑覆盖不增行）----
  const importSqlPath = path.join(cfg.productsDir, 'import.sql')
  logStep(7, `D1 入库：wrangler d1 execute ${cfg.db} --local --file ${toPosix(importSqlPath)}（cwd=apps/api）`)
  if (!fs.existsSync(importSqlPath)) {
    failStep('D1 入库', `import.sql 缺失：${importSqlPath}（db 阶段应已生成，请复核 db 阶段日志）`)
  }
  // --file 传相对 apps/api 的路径（绝对路径不进 argv；界内复检同 put 步）
  const sqlRel = toPosix(path.relative(APPS_API_DIR, importSqlPath))
  if (
    path.isAbsolute(sqlRel) ||
    sqlRel.startsWith('-') ||
    path.resolve(APPS_API_DIR, sqlRel) !== path.resolve(importSqlPath)
  ) {
    failStep('D1 入库', `import.sql 相对路径界内复检失败：${sqlRel}`)
  }
  const executeOutcome = await runWrangler(
    ['d1', 'execute', cfg.db, '--local', '--file', sqlRel],
    APPS_API_DIR,
  )
  if (executeOutcome.code !== 0) {
    failStep(
      'D1 入库',
      `wrangler d1 execute 退出码 ${executeOutcome.code}：${tailOf(diagnosticOf(executeOutcome))}`,
    )
  }
  printChildOutput(executeOutcome)
  markStep('D1 入库', '退出码 0')
}

/** 结尾汇总：各步状态、图片对象数、失败清单（失败场景由顶层兜底同样调用） */
function printSummary() {
  console.log('\n===== 彩排汇总 =====')
  for (const step of runState.steps) {
    const note = step.note === '' ? '' : `（${step.note}）`
    console.log(`  ${step.name}：${step.status}${note}`)
  }
  const { keys, uploaded, skipped, failures } = runState.images
  console.log(`  图片对象：共 ${keys}，上传 ${uploaded}，跳过 ${skipped}，失败 ${failures.length}`)
  if (failures.length > 0) {
    console.log('  失败清单：')
    for (const failure of failures) console.error(`    ${failure.key}（退出码 ${failure.code}）`)
  }
}

// ---- 入口 ----
try {
  const config = parseCliArgs(process.argv.slice(2))
  await rehearse(config)
  printSummary()
  console.log('彩排全绿：本地 D1 与本地 R2 态已就绪（wrangler dev 同态可读）')
  process.exitCode = 0
} catch (err) {
  if (err instanceof UsageError) {
    console.error(err.message)
    process.exitCode = 2
  } else if (err instanceof StepFailure) {
    console.error(`\n彩排中止：${err.message}`)
    printSummary()
    process.exitCode = err.exitCode
  } else {
    // 非预期异常（dist 模块载入失败等）：如实携带堆栈上抛报告，绝不静默吞错
    console.error(`\n彩排异常中止：${err instanceof Error ? err.stack : String(err)}`)
    printSummary()
    process.exitCode = 1
  }
}
