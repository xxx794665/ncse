/**
 * 图片阶段（T1-05）：读 runImport 的 JSON 产物 → 收集全部图片段
 * （题干/选项/解析/材料四处宿主，模块序 → 试卷序 → items 序 → 段序）→
 * 定位源文件 → 压缩（位图转 webp）或原字节透传（gif）→ 派生内容寻址键 →
 * 写 r2/ 工件 → 模块 JSON 图片段 path 原位重写 → 写 images-manifest.json →
 * （阶段 B，--bucket 启用时）r2/ 工件全量上传 R2。
 * 幂等与确定性：同产物 + 同输入 → 逐字节相同输出（工件字节由源字节与固定
 * sharp 参数决定；模块 JSON 重写沿用 pipeline 的确定性序列化格式；产物无任何
 * 变更的重跑为纯校验性 no-op，不写出文件——全部段已是键且工件齐备时如此。
 * 上传成功本身不产生本地文件写：上传成功且无其他变更时不写 images-manifest）。
 * 容错哲学与解析/入库阶段一致：单图失败（路径越界/文件缺失/类型不支持/
 * 处理失败/工件缺失）只记 error 级 issue 且该段保持源路径，其余图片继续；
 * 上传阶段同理（单对象失败记 r2_upload_failed，其余对象继续，结果按输入序
 * 聚合）。带 --bucket 的重跑 = 全量 re-put（R2 put 幂等覆盖，内容寻址同键同
 * 字节，语义安全）。
 * 键设计（ADR-0007）：img/<源字节 sha256>.webp|.gif——内容寻址，同内容
 * 天然去重、再蒸馏重导入键不变；DB 存裸键，访问 URL 由服务层构造。
 * 安全：产物根与输入根均为受信根（CLI 显式指定或 manifest 登记），全部派生
 * 读写路径一律经 resolveWithin 界内校验（CWE-22）；本阶段自身无凭据（R2
 * 凭据走 wrangler 本机 OAuth，bucket 名是 CLI 参数；上传经 node 直启仓库根
 * wrangler.js、不经 shell，见 r2-upload.ts）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { InvalidProductsError } from './db-stage.js'
import { moduleFolderOfCode } from './modules.js'
import { resolveWithin } from './pipeline.js'
import { uploadArtifacts } from './r2-upload.js'
import type {
  ImageMapping,
  ImagesManifest,
  ImagesStageOptions,
  ImagesStageResult,
  ImagesStageStats,
  ImportIssue,
  ModuleCode,
} from './types.js'

/** 输入目录缺失或不是目录（CLI 转退出码 2，属用法错误而非产物问题） */
export class InvalidInputDirError extends Error {
  constructor(dir: string) {
    super(`输入目录不存在或不是目录：${dir}`)
    this.name = 'InvalidInputDirError'
  }
}

/** 已重写内容寻址键形态：img/<64 位小写十六进制>.webp 或 .gif */
const KEYED_PATH_PATTERN = /^img\/[0-9a-f]{64}\.(webp|gif)$/

/** 可压缩源扩展名（小写；经 sharp 转 webp） */
const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'tiff',
  'bmp',
])

/** gif 扩展名（动图保真：原字节透传，不做压缩） */
const GIF_EXTENSION = 'gif'

/**
 * 压缩边长上限（像素，宽高各自不超过）：1400 覆盖 PC 阅读栏最大宽度与
 * 移动端 3x retina（约 390pt × 3 ≈ 1170px）两档阅读场景，超出仅缩不放。
 */
const MAX_DIMENSION = 1400

/** Webp 质量档位：82 为视觉无损级（题库图表线条与公式文字保真优先于压缩率） */
const WEBP_QUALITY = 82

/* ============ 图片阶段视角的产物结构（字段级校验后的读取形态） ============ */

/** 富片段（JSON 原值的强类型收窄；path 就地改写直接作用于 JSON 原对象，整文件随后重新序列化） */
type SegmentView = { type: 'text'; text: string } | { type: 'image'; path: string; alt?: string }

/** 题目（图片段宿主：题干/选项内容/解析） */
interface QuestionView {
  qid: string
  stem: SegmentView[]
  options: Array<{ key: string; content: SegmentView[] }>
  analysis: SegmentView[]
}

/** 题组（图片段宿主：材料） */
interface GroupView {
  material: SegmentView[]
}

/** 试卷（file 为图片 src 的解析基准：src 相对试卷 md 所在目录） */
interface PaperView {
  file: string
  items: Array<QuestionView | GroupView>
}

/** 模块产物（root 保留 JSON 原值，重写后整体重新序列化） */
interface ModuleView {
  root: Record<string, unknown>
  papers: PaperView[]
}

/** 段处理共享的可变上下文（统计/问题清单/映射/写出记录） */
interface SegmentContext {
  productsRoot: string
  inputRoot: string
  issues: ImportIssue[]
  stats: ImagesStageStats
  /** 源相对路径（输入根内 POSIX）→ 首见映射（refs 跨试卷累计） */
  mappings: Map<string, ImageMapping>
  /** 写出的产物文件（绝对路径；含 r2 工件） */
  wrote: string[]
  /** 本阶段写出的 r2 工件数（产物无变更判定输入之一） */
  artifactsWritten: number
}

/** sharp metadata 消费切片（源格式与原始像素；正常位图恒有值，只收窄不耦合完整类型） */
interface ImageMetadata {
  format: string
  width: number
  height: number
}

/* ============ 产物读取与结构校验（宽松 unknown → 强类型收窄，坏结构抛 InvalidProductsError；风格同 db-stage） ============ */

/** 校验通过的 manifest 图片阶段消费切片 */
interface ManifestSlice {
  version: string
  input: string
  moduleOrder: ModuleCode[]
}

/** 读 import-manifest.json 并校验图片阶段消费字段（缺失/损坏 → InvalidProductsError） */
function readProductsManifest(productsRoot: string): ManifestSlice {
  const where = 'import-manifest.json'
  const manifestPath = resolveWithin(productsRoot, where)
  const root = asRecord(parseJsonText(readTextFile(manifestPath, where), where), where)
  const version = expectString(root['version'], `${where} 的 version 字段`)
  const input = expectString(root['input'], `${where} 的 input 字段`)
  const orderValue = expectArray(root['moduleOrder'], `${where} 的 moduleOrder 字段`)
  const moduleOrder = orderValue.map((code, index) =>
    expectModuleCode(expectString(code, `${where} moduleOrder[${index}]`), `${where} moduleOrder[${index}]`),
  )
  return { version, input, moduleOrder }
}

/** 模块 code 校验：未登记的 code 抛 InvalidProductsError，登记则返回 ModuleCode */
function expectModuleCode(code: string, where: string): ModuleCode {
  const folder = moduleFolderOfCode(code)
  if (folder === undefined) {
    throw new InvalidProductsError(`${where} 为未登记模块 code：${code}`)
  }
  return folder.code
}

/**
 * 读单个模块产物 modules/<code>.json 并校验结构。
 * 文件不存在返回 null（runImport 只为有试卷的模块写文件，缺失不是错误）；
 * 存在但不可读/非法 JSON/结构不符 → InvalidProductsError。
 * 返回的视图对象即 JSON.parse 原值（校验后收窄），path 改写作用于原对象。
 */
function readModuleView(productsRoot: string, code: ModuleCode): ModuleView | null {
  const where = `modules/${code}.json`
  const modulePath = resolveWithin(productsRoot, where)
  if (!fs.existsSync(modulePath)) return null
  const root = asRecord(parseJsonText(readTextFile(modulePath, where), where), where)
  const moduleField = expectString(root['module'], `${where} 的 module 字段`)
  if (moduleField !== code) {
    throw new InvalidProductsError(`${where} 的 module 字段为 ${moduleField}，与文件名不一致`)
  }
  const papersValue = expectArray(root['papers'], `${where} 的 papers 字段`)
  const papers = papersValue.map((paper, index) => validatePaper(paper, `${where} papers[${index}]`))
  return { root, papers }
}

/** 校验试卷结构（file/items 必需；返回原对象的收窄） */
function validatePaper(value: unknown, where: string): PaperView {
  const record = asRecord(value, where)
  expectString(record['file'], `${where} 的 file 字段`)
  const items = expectArray(record['items'], `${where} 的 items 字段`)
  for (let index = 0; index < items.length; index++) {
    validateItem(items[index], `${where} items[${index}]`)
  }
  return record as unknown as PaperView
}

/** 校验 items 条目（含 qid 键为题目，否则为题组；返回原对象的收窄） */
function validateItem(value: unknown, where: string): QuestionView | GroupView {
  const record = asRecord(value, where)
  if ('qid' in record) {
    expectString(record['qid'], `${where} 的 qid 字段`)
    validateSegments(record['stem'], `${where} 的 stem 字段`)
    const options = expectArray(record['options'], `${where} 的 options 字段`)
    for (let index = 0; index < options.length; index++) {
      const optionWhere = `${where} options[${index}]`
      const option = asRecord(options[index], optionWhere)
      expectString(option['key'], `${optionWhere} 的 key 字段`)
      validateSegments(option['content'], `${optionWhere} 的 content 字段`)
    }
    validateSegments(record['analysis'], `${where} 的 analysis 字段`)
    return record as unknown as QuestionView
  }
  validateSegments(record['material'], `${where} 的 material 字段`)
  return record as unknown as GroupView
}

/** 校验富片段数组（text/image 两态；返回原数组元素的收窄，对象身份不变） */
function validateSegments(value: unknown, where: string): SegmentView[] {
  const segments = expectArray(value, where)
  for (let index = 0; index < segments.length; index++) {
    const segmentWhere = `${where}[${index}]`
    const record = asRecord(segments[index], segmentWhere)
    const type = expectString(record['type'], `${segmentWhere} 的 type 字段`)
    if (type === 'text') {
      expectString(record['text'], `${segmentWhere} 的 text 字段`)
    } else if (type === 'image') {
      expectString(record['path'], `${segmentWhere} 的 path 字段`)
      const alt = record['alt']
      if (alt !== undefined && typeof alt !== 'string') {
        throw new InvalidProductsError(`${segmentWhere} 的 alt 字段应为字符串`)
      }
    } else {
      throw new InvalidProductsError(`${segmentWhere} 的 type 字段为未知片段类型：${type}`)
    }
  }
  return segments as unknown as SegmentView[]
}

/* ============ 编排 ============ */

/**
 * 执行一次图片阶段：读产物 → 逐段定位/压缩/透传 → 工件写 r2/ → 模块 JSON
 * 路径重写 →（--bucket 启用时）r2/ 工件全量上传 R2 → 写 images-manifest.json
 * （同产物 + 同输入逐字节确定）。产物无变更的重跑（全部段已键且工件齐备且无
 * 问题）为纯校验性 no-op，不写文件；上传成功本身不产生本地文件写。
 * import-manifest.json 不回写（那是 parse 阶段的记录）。
 */
export async function runImagesStage(options: ImagesStageOptions): Promise<ImagesStageResult> {
  const productsRoot = path.resolve(options.productsDir)
  const manifest = readProductsManifest(productsRoot)

  // 输入根：--input 覆盖 manifest.input（源仓库迁移场景）；与 manifest.input 同格式（正斜杠绝对路径）
  const inputRoot = path.resolve(options.inputDir ?? manifest.input).replace(/\\/g, '/')
  let inputIsDir = false
  try {
    inputIsDir = fs.statSync(inputRoot).isDirectory()
  } catch {
    inputIsDir = false
  }
  if (!inputIsDir) throw new InvalidInputDirError(inputRoot)

  const issues: ImportIssue[] = []
  const stats: ImagesStageStats = {
    references: 0,
    images: 0,
    compressed: 0,
    passthrough: 0,
    alreadyKeyed: 0,
    errors: 0,
    warnings: 0,
  }
  const ctx: SegmentContext = {
    productsRoot,
    inputRoot,
    issues,
    stats,
    mappings: new Map(),
    wrote: [],
    artifactsWritten: 0,
  }
  const rewrote: string[] = []

  for (const code of manifest.moduleOrder) {
    const view = readModuleView(productsRoot, code)
    if (view === null) continue
    const modulePath = resolveWithin(productsRoot, `modules/${code}.json`)
    let moduleChanged = false
    for (const paper of view.papers) {
      for (const item of paper.items) {
        // 图片段宿主收集：题目 = 题干 + 选项内容（数组序）+ 解析（文档出现序）；题组 = 材料
        const hosts: Array<{ qid: string | null; content: SegmentView[] }> = []
        if ('qid' in item) {
          hosts.push({ qid: item.qid, content: item.stem })
          for (const option of item.options) hosts.push({ qid: item.qid, content: option.content })
          hosts.push({ qid: item.qid, content: item.analysis })
        } else {
          hosts.push({ qid: null, content: item.material })
        }
        for (const host of hosts) {
          for (const segment of host.content) {
            if (segment.type !== 'image') continue
            stats.references++
            const rewritten = await rewriteSegment(ctx, segment, paper.file, host.qid)
            if (rewritten) moduleChanged = true
          }
        }
      }
    }
    if (moduleChanged) {
      fs.writeFileSync(modulePath, serializeJson(view.root), 'utf8')
      ctx.wrote.push(modulePath)
      rewrote.push(modulePath)
    }
  }

  stats.images = ctx.mappings.size

  // ---- R2 上传（阶段 B，--bucket 启用）：r2/ 工件全量 put；issues 并入总清单（统计随后重算） ----
  let upload: { uploaded: number; failed: number } | undefined
  if (options.bucket !== undefined) {
    const uploadResult = await uploadArtifacts(
      {
        productsDir: productsRoot,
        bucket: options.bucket,
        local: options.local,
        concurrency: options.concurrency,
      },
      options.runPut,
    )
    issues.push(...uploadResult.issues)
    upload = { uploaded: uploadResult.uploaded, failed: uploadResult.failed }
  }

  stats.errors = issues.filter((entry) => entry.severity === 'error').length
  stats.warnings = issues.filter((entry) => entry.severity === 'warning').length

  // ---- images-manifest.json 写出（无变更重跑不写：幂等 no-op 保持文件字节不变；
  //      上传失败计入 issues → dirty；上传成功不写文件） ----
  const imagesManifestPath = resolveWithin(productsRoot, 'images-manifest.json')
  const dirty =
    rewrote.length > 0 ||
    ctx.artifactsWritten > 0 ||
    issues.length > 0 ||
    !fs.existsSync(imagesManifestPath)
  if (dirty) {
    const imagesManifest: ImagesManifest = {
      version: manifest.version,
      input: inputRoot,
      stats,
      images: [...ctx.mappings.values()],
      issues,
    }
    fs.writeFileSync(imagesManifestPath, serializeJson(imagesManifest), 'utf8')
    ctx.wrote.push(imagesManifestPath)
  }

  return { stats, hardErrors: stats.errors, issues, wrote: ctx.wrote, rewrote, upload }
}

/**
 * 处理单个图片段：已键段仅校验 r2/ 工件在位（幂等重跑路径）；源路径段
 * 定位 → 读字节 → 压缩/透传 → 键派生 → 工件写出 → path 原位改写（alt 保留）。
 * 返回是否发生 path 改写；任何失败只记 error 级 issue 且段保持原样（不中断其他图片）。
 */
async function rewriteSegment(
  ctx: SegmentContext,
  segment: { type: 'image'; path: string; alt?: string },
  paperFile: string,
  qid: string | null,
): Promise<boolean> {
  const src = segment.path

  // 已重写键：工件在位 → alreadyKeyed 跳过；缺失 → 提示重新 parse（本阶段无法从键反查源文件）
  if (KEYED_PATH_PATTERN.test(src)) {
    const artifactPath = resolveWithin(ctx.productsRoot, `r2/${src}`)
    if (fs.existsSync(artifactPath)) {
      ctx.stats.alreadyKeyed++
      return false
    }
    ctx.issues.push(
      issue('error', 'artifact_missing', paperFile, qid, `产物工件缺失，需重新 parse 后重跑：${src}`),
    )
    return false
  }

  // 源相对路径：相对试卷 md 所在目录解析 → 输入根内规范化 POSIX 相对路径（首见去重键）
  const rel = path.posix.normalize(path.posix.join(posixDirname(paperFile), src))
  let sourceAbs: string
  try {
    sourceAbs = resolveWithin(ctx.inputRoot, rel)
  } catch {
    ctx.issues.push(issue('error', 'image_path_escape', paperFile, qid, `图片路径越界（逃出输入根）：${src}`))
    return false
  }
  let sourceStat: fs.Stats | undefined
  try {
    sourceStat = fs.statSync(sourceAbs)
  } catch {
    sourceStat = undefined
  }
  if (sourceStat === undefined || !sourceStat.isFile()) {
    ctx.issues.push(issue('error', 'image_missing', paperFile, qid, `图片文件缺失：${src}`))
    return false
  }

  // 首见去重：同源文件已处理过 → 复用键、计数并改写
  const existing = ctx.mappings.get(rel)
  if (existing !== undefined) {
    existing.refs++
    segment.path = existing.key
    return true
  }

  // 首见处理：读字节 → 元数据（宽高与源格式入映射）
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(sourceAbs)
  } catch (err) {
    ctx.issues.push(
      issue('error', 'image_process_failed', paperFile, qid, `图片读取失败：${src}（${messageOf(err)}）`),
    )
    return false
  }
  let metadata: ImageMetadata
  try {
    metadata = await sharp(bytes).metadata()
  } catch (err) {
    ctx.issues.push(
      issue(
        'error',
        'image_process_failed',
        paperFile,
        qid,
        `图片元数据读取失败：${src}（${messageOf(err)}）`,
      ),
    )
    return false
  }

  const extension = path.posix.extname(rel).slice(1).toLowerCase()
  let key: string
  let outBytes: Buffer
  if (extension === GIF_EXTENSION) {
    // gif 原字节透传（动图保真；键后缀 .gif，工件字节 = 原始字节）
    key = `img/${digestOf(bytes)}.gif`
    outBytes = bytes
  } else if (COMPRESSIBLE_EXTENSIONS.has(extension)) {
    try {
      outBytes = await compressImage(bytes)
    } catch (err) {
      ctx.issues.push(
        issue('error', 'image_process_failed', paperFile, qid, `图片压缩失败：${src}（${messageOf(err)}）`),
      )
      return false
    }
    key = `img/${digestOf(bytes)}.webp`
  } else {
    ctx.issues.push(
      issue(
        'error',
        'unsupported_image_type',
        paperFile,
        qid,
        `不支持的图片类型（可压缩位图或透传 gif）：${src}`,
      ),
    )
    return false
  }

  // 工件写出（内容寻址键幂等覆盖：同键同字节；目录递归创建，仅在有工件时建立 r2/）
  const artifactPath = resolveWithin(ctx.productsRoot, `r2/${key}`)
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
  fs.writeFileSync(artifactPath, outBytes)
  ctx.wrote.push(artifactPath)
  ctx.artifactsWritten++
  if (extension === GIF_EXTENSION) ctx.stats.passthrough++
  else ctx.stats.compressed++

  ctx.mappings.set(rel, {
    source: rel,
    key,
    refs: 1,
    origBytes: bytes.length,
    outBytes: outBytes.length,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
  })
  segment.path = key
  return true
}

/** 压缩为 webp：边长超限等比内缩（fit inside、不放大小图），质量 82；同输入字节 → 同输出字节 */
function compressImage(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes)
    .resize({ fit: 'inside', withoutEnlargement: true, width: MAX_DIMENSION, height: MAX_DIMENSION })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}

/** 原始字节 sha256（内容寻址键成分：键锚定源内容，与工件字节解耦） */
function digestOf(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/** POSIX 目录名（'a/b.md' → 'a'；根级文件 → '.'） */
function posixDirname(file: string): string {
  const index = file.lastIndexOf('/')
  return index === -1 ? '.' : file.slice(0, index)
}

/** 确定性 JSON 序列化（与 pipeline.ts 相同格式：2 空格缩进 + 尾随换行，保证重写后与 parse 产物同构） */
function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** 读文本文件（不可读 → InvalidProductsError） */
function readTextFile(filePath: string, where: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new InvalidProductsError(`${where} 读取失败：${messageOf(err)}`)
  }
}

/** 解析 JSON（非法 JSON → InvalidProductsError；结果以 unknown 携带避免 any 扩散） */
function parseJsonText(text: string, where: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new InvalidProductsError(`${where} 不是合法 JSON：${messageOf(err)}`)
  }
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidProductsError(`${where} 应为 JSON 对象`)
  }
  return value as Record<string, unknown>
}

function expectArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidProductsError(`${where} 应为数组`)
  return value
}

function expectString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new InvalidProductsError(`${where} 应为字符串`)
  return value
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function issue(
  severity: ImportIssue['severity'],
  code: string,
  file: string,
  qid: string | null,
  message: string,
): ImportIssue {
  return { severity, code, file, qid, message }
}
