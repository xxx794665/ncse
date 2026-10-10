/**
 * R2 上传器（T1-05 阶段 B）：<产物目录>/r2/ 工件区全量上传至 R2。
 * 机制：`wrangler r2 object put <bucket>/<key> --file <对象键> --content-type <mime>`
 * （local 态追加 --local；--file 以相对键引用工件，进程 cwd = r2 工件根，绝对路径
 * 不进 argv），经 node 直启仓库根 node_modules/wrangler/bin/wrangler.js（src 与
 * dist 同深度，两者都成立），spawn 显式 shell:false、参数数组直传，凭据走
 * wrangler 本机 OAuth，本模块零凭据。键 = 工件相对 r2/ 的 POSIX 路径（即
 * 内容寻址键 img/<sha256>.webp|.gif）。
 * 并发：固定 worker 池消费键数组（默认 4、可调 2–16，真实题库约 3.9 万图串行过
 * 慢）；结果与 issue 一律按输入序聚合——并发完成序不确定，产出顺序必须确定
 * （images-manifest.json 字节确定性要求）。put 幂等覆盖（内容寻址同键同字节），
 * 全量重传语义安全。
 * 容错：单对象退出码非 0 只记 error 级 issue r2_upload_failed（消息含键、退出码
 * 与 stderr 尾部截断——上传问题消息允许环境相关文本），其余对象继续；r2/ 目录
 * 不存在 = 无图可传的合法状态，返回空结果而非错误。wrangler.js 缺失（仓库根未
 * npm install）抛 MissingWranglerError，CLI 映射退出码 2（用法级：环境缺工具）。
 * 安全（CWE-78 纵深防御，三层）：①uploadArtifacts 入口对桶名/全部对象键做
 * 白名单校验（桶名按 R2 命名规则，键首字符限字母数字，杜绝「--」值被 wrangler
 * 解析为旗标）；②动态参数只含白名单字符集的值（桶名、键、mime——绝对路径不
 * 进 argv）；③spawn 汇点处对完整参数形态做结构化复检（defaultPutRunner 内，
 * 不合规折算该对象失败，绝不进子进程）。工件遍历与派生路径一律经 resolveWithin
 * 界内校验（CWE-22）；bucket 名是 CLI 参数不是凭据；不经 shell。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWithin } from './pipeline.js'
import type { ImportIssue, R2PutRunner, R2UploadOptions, R2UploadResult } from './types.js'

/** wrangler.js 直启路径（本模块目录上三级即仓库根；src 与 dist 同深度） */
const WRANGLER_JS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../node_modules/wrangler/bin/wrangler.js',
)

/**
 * R2 桶名白名单（R2 命名规则：3-63 位小写字母/数字/连字符、首尾字母数字）。
 * 用户可控参数进入子进程参数前的显式收窄（CWE-78 防线第①层）。
 * 无锚片段与键片段供汇点组合式复用（锚定式不可直接拼接——$ 后接 / 永不匹配）。
 */
const BUCKET_NAME_SOURCE = '[a-z0-9][a-z0-9-]{1,61}[a-z0-9]'
const BUCKET_NAME_PATTERN = new RegExp(`^${BUCKET_NAME_SOURCE}$`)
/**
 * 对象键白名单：首字符限定字母数字（防「--」旗标伪装），其余限定字母/数字/
 * 点/下划线/连字符/斜杠——内容寻址键 img/<hex>.<ext> 天然满足。
 */
const KEY_SOURCE = '[A-Za-z0-9][A-Za-z0-9._/-]{0,1022}'
const KEY_PATTERN = new RegExp(`^${KEY_SOURCE}$`)
/** 汇点复检用「桶名/对象键」复合形态 */
const BUCKET_KEY_PATTERN = new RegExp(`^${BUCKET_NAME_SOURCE}/${KEY_SOURCE}$`)
/** mime 白名单（contentTypeOf 的值域；汇点结构复检用） */
const MIME_PATTERN = /^(?:image\/webp|image\/gif|application\/octet-stream)$/

/** 默认并发（真实题库约 3.9 万图，串行过慢） */
const DEFAULT_CONCURRENCY = 4
/** 并发夹取域（CLI --concurrency 校验 2–16；直调越界值夹回域内，池永不因 0/负值挂起） */
const MIN_CONCURRENCY = 2
const MAX_CONCURRENCY = 16

/** 失败消息携带的 stderr 尾部长度上限（诊断够用即可，避免 issue 文本失控） */
const STDERR_TAIL_LIMIT = 300

/** wrangler 未安装（仓库根 node_modules 缺 wrangler.js；CLI 转退出码 2，属用法级环境缺工具） */
export class MissingWranglerError extends Error {
  constructor() {
    super(`wrangler 未安装：${WRANGLER_JS} 不存在；请在仓库根执行 npm install 后重试`)
    this.name = 'MissingWranglerError'
  }
}

/** 桶名/对象键不合规（白名单外；CLI 转退出码 2，属用法级参数校验） */
export class InvalidUploadTargetError extends Error {
  constructor(target: string) {
    super(`R2 桶名或对象键不合规（桶名 3-63 位小写字母/数字/连字符，键首字符须字母数字）：${target}`)
    this.name = 'InvalidUploadTargetError'
  }
}

/**
 * wrangler.js 可用性校验（uploadArtifacts 入口调用；独立导出供测试对任意路径断言行为，
 * 不触发真子进程）。
 */
export function ensureWranglerJs(wranglerJs: string): void {
  if (!fs.existsSync(wranglerJs)) throw new MissingWranglerError()
}

/**
 * 执行一次上传：遍历 <产物目录>/r2/ 全部工件 → 固定并发池逐对象 put →
 * 按输入序聚合结果与 issue。runPut 注入点：缺省 defaultPutRunner 真 spawn
 * wrangler，测试注入替身记录调用并可控失败。r2/ 不存在 → 空结果（无图可
 * 传是合法状态）。
 */
export async function uploadArtifacts(
  options: R2UploadOptions,
  runPut: R2PutRunner = defaultPutRunner,
): Promise<R2UploadResult> {
  ensureWranglerJs(WRANGLER_JS)
  if (!BUCKET_NAME_PATTERN.test(options.bucket)) throw new InvalidUploadTargetError(options.bucket)

  const productsRoot = path.resolve(options.productsDir)
  const r2Root = resolveWithin(productsRoot, 'r2')
  const keys = collectKeys(r2Root)
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) throw new InvalidUploadTargetError(key)
  }

  // ---- 固定 worker 池：消费键数组（键序即输入序）；每格记录退出结果，聚合延后保证顺序确定 ----
  const poolSize = Math.min(
    MAX_CONCURRENCY,
    Math.max(MIN_CONCURRENCY, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)),
  )
  const outcomes: Array<{ code: number; stderr: string } | undefined> = keys.map(() => undefined)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++
      if (index >= keys.length) return
      const key = keys[index]
      // --file 传对象键（相对 cwd = r2 工件根）：绝对路径不进 argv，动态参数全部为白名单字符集内的值
      const args = [
        'r2',
        'object',
        'put',
        `${options.bucket}/${key}`,
        '--file',
        key,
        '--content-type',
        contentTypeOf(key),
        ...(options.local === true ? ['--local'] : []),
      ]
      outcomes[index] = await runPut(args, r2Root)
    }
  }
  await Promise.all(Array.from({ length: Math.min(poolSize, keys.length) }, () => worker()))

  // ---- 按输入序聚合（并发完成序不影响 issue 顺序与计数） ----
  const issues: ImportIssue[] = []
  let uploaded = 0
  let failed = 0
  for (let index = 0; index < keys.length; index++) {
    const outcome = outcomes[index]
    if (outcome === undefined) continue // 不可达（池消费全部键）；防御性跳过
    if (outcome.code === 0) {
      uploaded++
      continue
    }
    failed++
    issues.push(uploadIssue(keys[index], outcome.code, outcome.stderr))
  }
  return { uploaded, failed, keys, issues }
}

/**
 * spawn 汇点参数结构复检（CWE-78 防线第③层）：固定子命令形态 + 动态参数逐位
 * 白名单（桶/键复合、对象键、mime；旗标位必须是字面量）。不合规直接判该对象
 * 失败，绝不带可疑参数进子进程。独立导出供测试直接断言（真 spawn 路径无法注入）。
 */
export function isSafePutArgs(args: string[]): boolean {
  if (args.length !== 8 && args.length !== 9) return false
  if (args[0] !== 'r2' || args[1] !== 'object' || args[2] !== 'put') return false
  if (!BUCKET_KEY_PATTERN.test(args[3] ?? '')) return false
  if (args[4] !== '--file' || !KEY_PATTERN.test(args[5] ?? '')) return false
  if (args[6] !== '--content-type' || !MIME_PATTERN.test(args[7] ?? '')) return false
  const tail = args[8]
  return tail === undefined || tail === '--local'
}

/**
 * 默认 put 执行器：spawn(process.execPath, [wranglerJs, ...args])，参数数组直传、
 * 显式 shell:false、cwd = r2 工件根（--file 相对键由此解析），stdio pipe 收集。
 * 汇点参数先经 isSafePutArgs 结构复检。进程级异常（spawn error / 信号终止）折算
 * 为 code -1 的失败（局部化为该对象的 issue，不中断其余上传）；stderr 为空时回退
 * stdout（wrangler 的错误诊断可能走任一流，如本地态并发写冲突的 500 报错）。
 */
const defaultPutRunner: R2PutRunner = (args, cwd) => {
  if (!isSafePutArgs(args)) {
    return Promise.resolve({ code: -1, stderr: 'wrangler 参数白名单复检失败（形态不符，拒绝执行）' })
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRANGLER_JS, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      resolve({ code: -1, stderr: `wrangler 进程启动失败：${err.message}` })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stderr: stderr !== '' ? stderr : stdout })
    })
  })
}

/**
 * 递归收集 r2/ 下全部文件键（相对 r2/ 的 POSIX 路径，排序确定性；目录不存在 → 空数组）。
 * 点开头的隐藏条目（目录与文件）跳过：工件区内容寻址键永不以 '.' 开头，而
 * wrangler --local 会把本地态写进其 cwd（= r2 工件根）下的 .wrangler/——不跳过则
 * 重跑会误把状态文件当工件（键首字符 '.' 亦过不了白名单）。
 */
function collectKeys(r2Root: string): string[] {
  const keys: string[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在或不可读 = 无图可传（合法状态）；子目录由本函数自建，正常不会失败
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue // 隐藏条目 = 工具自身状态（如 --local 的 .wrangler/），非工件
      const childRel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const child = resolveWithin(r2Root, childRel)
      if (entry.isDirectory()) walk(child, childRel)
      else if (entry.isFile()) keys.push(childRel) // 符号链接等非常规文件不计（工件恒为常规文件）
    }
  }
  walk(r2Root, '')
  return keys.sort()
}

/** 扩展名 → Content-Type（工件区只应有 webp/gif；其余按八进制流兜底） */
function contentTypeOf(key: string): string {
  if (key.endsWith('.webp')) return 'image/webp'
  if (key.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

/** r2_upload_failed issue（file 即对象键：相对 r2/ 的工件路径；消息允许环境相关文本） */
function uploadIssue(key: string, code: number, stderr: string): ImportIssue {
  return {
    severity: 'error',
    code: 'r2_upload_failed',
    file: key,
    qid: null,
    message: `R2 上传失败：${key}（退出码 ${code}）：${tailOf(stderr)}`,
  }
}

/** stderr 尾部截断（错误诊断多在尾部；截断以「…」前缀标记） */
function tailOf(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= STDERR_TAIL_LIMIT ? trimmed : `…${trimmed.slice(-STDERR_TAIL_LIMIT)}`
}
