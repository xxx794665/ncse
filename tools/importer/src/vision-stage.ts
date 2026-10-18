/**
 * 视觉提取阶段（T1-06 阶段 A）：读 images 阶段产物（键化模块 JSON 与 r2/ 工件）→
 * 枚举题目宿主图片段（题干/选项内容/解析三处宿主；题组材料不枚举——questions 表
 * 之外无 vision_text 列）→ 吸收外部视觉子代理写入 staging 的提取文本（<产物目录>/
 * vision-in/<键>.txt，键含斜杠）→ 按题原子回写题目 visionText（各段文本按 '\n'
 * 连接）→ 写 vision-manifest.json（entries 即下次运行的缓存）。
 * 执行模型：本阶段零网络、零凭据、零子进程——实际「看图」由外部视觉子代理完成
 * （读产物目录 r2/ 工件，文本经 vision-in/ 交换）；本阶段只做枚举、吸收、缓存、
 * 回写与记录，可反复重跑。
 * 幂等与缓存：键为内容寻址（img/<源字节 sha256>.webp|.gif），跨导入版本复用——
 * 重新 parse 后 images 重新键化得到相同键，vision 从缓存直接恢复 visionText 免重
 * 提取；缓存命中优先于 staging（已缓存键本次不再读 staging 文件，staging 内容事后
 * 变更不影响已缓存文本——防抖动；方法论变更重提取 = 手动删 vision-manifest 对应
 * 条目）。manifest 的 version 取自 import-manifest.json 仅作登记，缓存判定只看键。
 * 模块 JSON 回写按题原子（ADR-0011 两级宿主）：题干与选项为必选宿主——仅当该题
 * 全部必选段已有文本（缓存或本次吸收）时回写 visionText（解析段文本在手则并入
 * 拼接、缺失不阻塞——「解析缺省可入」），任一必选段 pending 或 error 保持现值
 * 不动（不写半截）；仅在计算值 ≠ 现值时写文件（序列化格式与既有产物完全一致）。
 * 提取范围（manifest.pending 与 pending 键的工件存在性检查）只覆盖必选键——被任
 * 意题目的题干或选项引用过的键才进 pending（纯解析键出范围；其已有文本仍入
 * entries 缓存）。manifest 写出 dirty 判定 =
 * 文件不存在或新序列化字节 ≠ 磁盘字节；无变更重跑（全缓存、无 pending 变化、无
 * 新 issue）为纯校验性 no-op，不写任何文件。孤儿 staging 文件（键未被任何枚举段
 * 引用）静默忽略——吸收只认枚举键。
 * 容错哲学与 images 阶段一致：单段问题（未键路径/staging 读取失败/空白文本）只
 * 记 issue 且该题不回写，其余题目继续；工件缺失记 error（同 images 阶段
 * artifact_missing 语义：需重新 parse 后重跑），该检查仅对缺文本的键做——文本
 * 已在手（缓存或本次吸收）的键不查工件（工件仅子代理提取时需要）；pending（无
 * staging 文本）是等待子代理提取的正常状态，不记 issue。
 * 安全：产物根为受信根（CLI 显式指定），全部派生读写路径（vision-manifest、模块
 * JSON、staging、r2 工件存在性检查）一律经 resolveWithin 界内校验（CWE-22）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { InvalidProductsError } from './db-stage.js'
import { KEYED_PATH_PATTERN, readModuleView, readProductsManifest } from './image-stage.js'
import type { QuestionView, SegmentView } from './image-stage.js'
import { resolveWithin, serializeJson } from './pipeline.js'
import type {
  ImportIssue,
  VisionManifest,
  VisionStageOptions,
  VisionStageResult,
  VisionStageStats,
  VisionTextEntry,
} from './types.js'

/* ============ 视觉提取阶段的键状态与遍历上下文 ============ */

/** 单键状态（首见序 = Map 插入序；text 为 null 表示 pending） */
interface KeyState {
  key: string
  /** 提取文本（缓存命中或本次吸收；'' = 已提取-空；null = pending） */
  text: string | null
  /** 题目宿主引用计数（本次运行枚举重计；仅计有文本的键） */
  refs: number
  /** 工件存在性检查是否已做（检查按键去重，防同键多段重复 issue） */
  artifactChecked: boolean
  /** 是否被必选宿主（题干/选项）引用过（ADR-0011：提取范围只收必选键；解析独占键出范围） */
  inScope: boolean
}

/** 题目视图（image-stage 收窄 + visionText 字段；回写作用于 JSON 原对象，整模块随后重新序列化） */
interface VisionQuestionView extends QuestionView {
  visionText: string
}

/** 段处理共享的可变上下文（统计/问题清单/缓存/键状态） */
interface VisionContext {
  productsRoot: string
  issues: ImportIssue[]
  stats: VisionStageStats
  /** 上次运行 vision-manifest.json 的 entries（键 → 文本；缓存命中优先于 staging） */
  cache: Map<string, string>
  /** 键状态（首见序） */
  keyStates: Map<string, KeyState>
}

/* ============ 缓存读取（上次运行 manifest 的 entries） ============ */

/**
 * 读上次运行写出的 vision-manifest.json 的 entries 作为缓存（键 → 文本）。
 * 文件不存在返回空缓存（首次运行）；存在但不可读/非法 JSON/结构不符 →
 * InvalidProductsError。refs/version/pending 不入缓存：refs 本次运行枚举重计，
 * version 仅作登记，pending 每次重新判定。
 */
function readVisionCache(productsRoot: string): Map<string, string> {
  const where = 'vision-manifest.json'
  const manifestPath = resolveWithin(productsRoot, where)
  if (!fs.existsSync(manifestPath)) return new Map()
  const root = asRecord(parseJsonText(readTextFile(manifestPath, where), where), where)
  const entriesValue = expectArray(root['entries'], `${where} 的 entries 字段`)
  const cache = new Map<string, string>()
  for (let index = 0; index < entriesValue.length; index++) {
    const entryWhere = `${where} entries[${index}]`
    const record = asRecord(entriesValue[index], entryWhere)
    const key = expectString(record['key'], `${entryWhere} 的 key 字段`)
    const text = expectString(record['text'], `${entryWhere} 的 text 字段`)
    cache.set(key, text)
  }
  return cache
}

/* ============ 编排 ============ */

/**
 * 执行一次视觉提取阶段：读产物 → 枚举题目宿主图片段 → 吸收/缓存 → 按题原子回写
 * visionText → 写 vision-manifest.json。遍历序 = 模块序（manifest.moduleOrder）→
 * 试卷序 → items 序，宿主内 = 题干段序 → 选项数组序 → 解析段序（全确定性）。
 * import-manifest.json 不回写（那是 parse 阶段的记录）。
 * 遍历/聚合同步逻辑为主，async 签名保留未来 API 提取器接入空间。
 */
export async function runVisionStage(options: VisionStageOptions): Promise<VisionStageResult> {
  const productsRoot = path.resolve(options.productsDir)
  const manifest = readProductsManifest(productsRoot)
  const cache = readVisionCache(productsRoot)

  const issues: ImportIssue[] = []
  const stats: VisionStageStats = {
    references: 0,
    images: 0,
    extracted: 0,
    pending: 0,
    errors: 0,
    warnings: 0,
  }
  const ctx: VisionContext = { productsRoot, issues, stats, cache, keyStates: new Map() }
  const wrote: string[] = []
  const rewrote: string[] = []

  for (const code of manifest.moduleOrder) {
    const view = readModuleView(productsRoot, code)
    if (view === null) continue
    const modulePath = resolveWithin(productsRoot, `modules/${code}.json`)
    let moduleChanged = false
    for (let paperIndex = 0; paperIndex < view.papers.length; paperIndex++) {
      const paper = view.papers[paperIndex]
      for (let itemIndex = 0; itemIndex < paper.items.length; itemIndex++) {
        const item = paper.items[itemIndex]
        // 仅题目宿主枚举：题组材料图片不枚举（questions 表之外无 vision_text 列）
        if (!('qid' in item)) continue
        const where = `modules/${code}.json papers[${paperIndex}] items[${itemIndex}]`
        const question = asVisionQuestion(item, where)
        if (processQuestion(ctx, question, paper.file)) moduleChanged = true
      }
    }
    if (moduleChanged) {
      fs.writeFileSync(modulePath, serializeJson(view.root), 'utf8')
      wrote.push(modulePath)
      rewrote.push(modulePath)
    }
  }

  // ---- entries / pending 聚合（首见序 = 键状态插入序）与统计收口 ----
  const entries: VisionTextEntry[] = []
  const pending: string[] = []
  for (const state of ctx.keyStates.values()) {
    if (state.text !== null) entries.push({ key: state.key, text: state.text, refs: state.refs })
    // pending 只收必选键（ADR-0011：纯解析键出提取范围，不驱动批次与退出码）
    else if (state.inScope) pending.push(state.key)
  }
  stats.images = ctx.keyStates.size
  stats.extracted = entries.length
  stats.pending = pending.length
  stats.errors = issues.filter((entry) => entry.severity === 'error').length
  stats.warnings = issues.filter((entry) => entry.severity === 'warning').length

  // ---- vision-manifest.json 写出（dirty = 文件不存在或新序列化字节 ≠ 磁盘字节；
  //      无变更重跑不写：幂等 no-op 保持文件字节不变） ----
  const visionManifest: VisionManifest = { version: manifest.version, stats, entries, pending, issues }
  const manifestPath = resolveWithin(productsRoot, 'vision-manifest.json')
  const serialized = serializeJson(visionManifest)
  const dirty =
    !fs.existsSync(manifestPath) || !fs.readFileSync(manifestPath).equals(Buffer.from(serialized, 'utf8'))
  if (dirty) {
    fs.writeFileSync(manifestPath, serialized, 'utf8')
    wrote.push(manifestPath)
  }

  return { stats, issues, wrote, rewrote, pending }
}

/* ============ 单题处理 ============ */

/**
 * 处理单道题的题目宿主图片段。宿主分两级（ADR-0011）：题干与选项为必选宿主，
 * 解析为可选宿主（「解析缺省可入」）：
 * - 必选段全部有文本（缓存或本次吸收）→ 参与回写拼接；任一必选段 pending 或
 *   error（未键路径/读取失败）→ 该题不回写（按题原子保持现值，防半截）。
 * - 可选段文本在手 → 并入拼接（段序仍为题干 → 选项序 → 解析序）；未就绪（pending
 *   或未键）→ 不阻塞该题回写、不检查工件（纯解析键出提取范围，pending 不收）。
 * 题目最终 visionText = texts 以 '\n' 连接（仅计算值 ≠ 现值时改写 JSON 原对象，
 * 整模块随后重新序列化）。返回该题是否发生 visionText 改写。
 */
function processQuestion(
  ctx: VisionContext,
  question: VisionQuestionView,
  paperFile: string,
): boolean {
  const texts: string[] = []
  // 必选宿主（题干/选项）：任一段未就绪该题不回写；可选宿主（解析）：缺省可入（ADR-0011）
  const mandatoryReady = processHosts(
    ctx,
    [question.stem, ...question.options.map((option) => option.content)],
    paperFile,
    question.qid,
    texts,
    true,
  )
  processHosts(ctx, [question.analysis], paperFile, question.qid, texts, false)
  if (!mandatoryReady) return false
  const computed = texts.join('\n')
  if (computed === question.visionText) return false
  question.visionText = computed
  return true
}

/**
 * 处理一组宿主的图片段。mandatory=true（必选宿主=题干/选项）：未就绪段（未键路径
 * /pending）使返回 false，pending 键做工件存在性检查；mandatory=false（可选宿主=
 * 解析）：未键路径仍记 error（images 阶段失败的可见性），但 pending 不阻塞、不做
 * 工件检查（纯解析键出提取范围）。有文本的段计入 refs 与 texts（段序保持遍历序，
 * 题干 → 选项序 → 解析序的拼接次序由调用方两次调用保证）。
 */
function processHosts(
  ctx: VisionContext,
  hosts: SegmentView[][],
  paperFile: string,
  qid: string,
  texts: string[],
  mandatory: boolean,
): boolean {
  let ready = true
  for (const segments of hosts) {
    for (const segment of segments) {
      if (segment.type !== 'image') continue
      ctx.stats.references++
      // 未键路径：images 阶段未跑或该段失败，视觉无键可定位 → error；必选宿主同时置不就绪
      if (!KEYED_PATH_PATTERN.test(segment.path)) {
        ctx.issues.push(
          issue(
            'error',
            'vision_requires_images',
            paperFile,
            qid,
            `图片段 path 未键化，需先跑 images 阶段：${segment.path}`,
          ),
        )
        if (mandatory) ready = false
        continue
      }
      const state = resolveKeyState(ctx, segment.path, paperFile, qid)
      if (mandatory) state.inScope = true
      if (state.text !== null) {
        state.refs++
        texts.push(state.text)
      } else if (mandatory) {
        checkArtifact(ctx, state, paperFile, qid)
        ready = false
      }
    }
  }
  return ready
}

/**
 * 取键状态（首见时确定文本来源，此后复用）：缓存命中优先于 staging——已缓存键
 * 本次不再读 staging 文件（staging 内容事后变更不影响已缓存文本）；缓存未命中 →
 * 吸收 staging 文本（不存在则 pending，等待子代理写入）。
 */
function resolveKeyState(ctx: VisionContext, key: string, paperFile: string, qid: string): KeyState {
  const existing = ctx.keyStates.get(key)
  if (existing !== undefined) return existing
  const state: KeyState = {
    key,
    text: ctx.cache.get(key) ?? null,
    refs: 0,
    artifactChecked: false,
    inScope: false,
  }
  if (state.text === null) absorbStaging(ctx, state, paperFile, qid)
  ctx.keyStates.set(key, state)
  return state
}

/**
 * 吸收 staging 文本（<产物目录>/vision-in/<键>.txt）：不存在 → pending（等待子
 * 代理提取，正常状态不记 issue）；读取抛错 → error 且键保持 pending；trim 后为空
 * → warning 且 text = ''（已提取-空，不再 pending）；trim 后非空 → text = trim
 * 后全文（内部换行保留）。
 */
function absorbStaging(ctx: VisionContext, state: KeyState, paperFile: string, qid: string): void {
  const stagingPath = resolveWithin(ctx.productsRoot, `vision-in/${state.key}.txt`)
  if (!fs.existsSync(stagingPath)) return
  let raw: string
  try {
    raw = fs.readFileSync(stagingPath, 'utf8')
  } catch (err) {
    ctx.issues.push(
      issue(
        'error',
        'vision_stage_read_failed',
        paperFile,
        qid,
        `staging 文本读取失败：${state.key}（${messageOf(err)}）`,
      ),
    )
    return
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    ctx.issues.push(
      issue('warning', 'vision_text_empty', paperFile, qid, `staging 文本为空白（按已提取-空处理）：${state.key}`),
    )
    state.text = ''
  } else {
    state.text = trimmed
  }
}

/**
 * 工件存在性检查（仅缺文本的键、按键去重只查一次）：r2/<键> 缺失 → error
 * artifact_missing（同 images 阶段语义：本阶段无法从键反查源文件，需重新 parse
 * 后重跑）。缓存/吸收已有文本的键不查——文本已在手，工件仅子代理提取时需要。
 */
function checkArtifact(ctx: VisionContext, state: KeyState, paperFile: string, qid: string): void {
  if (state.artifactChecked) return
  state.artifactChecked = true
  const artifactPath = resolveWithin(ctx.productsRoot, `r2/${state.key}`)
  if (!fs.existsSync(artifactPath)) {
    ctx.issues.push(
      issue('error', 'artifact_missing', paperFile, qid, `产物工件缺失，需重新 parse 后重跑：${state.key}`),
    )
  }
}

/** 题目收窄 + visionText 字段校验（runImport 恒写出该字段；缺失/非字符串 → InvalidProductsError） */
function asVisionQuestion(item: QuestionView, where: string): VisionQuestionView {
  const record = item as unknown as Record<string, unknown>
  if (typeof record['visionText'] !== 'string') {
    throw new InvalidProductsError(`${where} 的 visionText 字段应为字符串`)
  }
  return item as VisionQuestionView
}

/* ============ 读取与构造辅助（风格同 image-stage/db-stage） ============ */

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
