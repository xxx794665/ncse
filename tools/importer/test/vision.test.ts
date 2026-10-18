/**
 * 视觉提取阶段测试（T1-06 阶段 A）：runImport + runImagesStage 键化产物 → 手工写
 * staging（vision-in/<键>.txt）→ runVisionStage，断言吸收回写（各段文本 '\n' 连接、
 * 题干段序 → 选项序 → 解析段序、staging trim 吸收内部换行保留）、题组材料不枚举、
 * 共享键 refs 跨题累计、无图片题保持空串、按题原子（不写半截）、pending/空白
 * staging/缓存优先/幂等 no-op、重新 parse 从缓存恢复（免重提取）、未键路径与工件
 * 缺失 error（工件检查仅对缺文本键）、孤儿 staging 静默忽略、manifest 字节确定性
 * 与 CLI 退出码。
 * 夹具全部为 sharp 现场合成的 8x8 纯色位图 + 合成虚构试卷（不含真实题库，ADR-0004）；
 * 产物写入系统临时目录，测试后清理。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { InvalidProductsError } from '../src/db-stage.js'
import { runImagesStage } from '../src/image-stage.js'
import { main } from '../src/main.js'
import { runImport, resolveWithin } from '../src/pipeline.js'
import { runVisionStage } from '../src/vision-stage.js'
import type { ParsedGroup, ParsedPaper, ParsedQuestion } from '../src/types.js'
import type { RichContent, RichSegment } from '@ncse/shared'

/* ============ 夹具生成（模块加载即建：合成输入 → runImport → runImagesStage 得键化产物） ============ */

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncse-importer-vision-'))
const inputDir = path.join(outDir, 'input')
const baseProducts = path.join(outDir, 'base-products')

/** 生成 8x8 纯色 png 位图字节（不同颜色 → 不同内容寻址键） */
async function solidBytes(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer()
}

const PNG_MATERIAL = await solidBytes({ r: 39, g: 174, b: 96 })
const PNG_STEM = await solidBytes({ r: 192, g: 57, b: 43 })
const PNG_OPTION = await solidBytes({ r: 41, g: 128, b: 185 })
const PNG_ANALYSIS = await solidBytes({ r: 142, g: 68, b: 173 })
const PNG_SHARED = await solidBytes({ r: 241, g: 196, b: 15 })
const PNG_Q4A = await solidBytes({ r: 22, g: 160, b: 133 })
const PNG_Q4B = await solidBytes({ r: 52, g: 73, b: 94 })

const visionPaper = `---
类型: "真题"
试卷: "2024年虚构省公务员录用考试《行测》题（视觉甲卷）"
地区: "虚构省"
年份: "2024"
模块: "政治理论"
题数: "5"
来源: "合成夹具（T1-06 视觉提取阶段测试，全虚构）"
---

# 2024年虚构省公务员录用考试《行测》题（视觉甲卷）

> 政治理论 · 5 题 · 虚构省 2024

## 材料 1

<p><img src="../90-图片/题目图/material-v.png" alt="虚构材料图" /><br></p>

### 第 1 题　<sub>qid 700301 · 马克思主义</sub>

<p>根据虚构材料图作答：</p><p><img src="../90-图片/题目图/stem-v.png" alt="虚构题干图" /></p>

- **A**. <p><img flag="tex" src="../90-图片/公式图/option-v.png" /></p>
- **B**. 虚构选项二　✅
- **C**. 虚构选项三
- **D**. 虚构选项四

**答案**：B

**官方解析**

<p>解析配图：<img src="../90-图片/题目图/analysis-v.png" alt="虚构解析图" /></p><p>故正确答案为B。</p>

---

## 第 2 题　<sub>qid 700302 · 毛泽东思想</sub>

纯文本题干。

- **A**. 虚构选项一
- **B**. 虚构选项二　✅
- **C**. 虚构选项三
- **D**. 虚构选项四

**答案**：B

**官方解析**

<p>共享配图（与第 3 题题干同源）：<img src="../90-图片/题目图/shared-v.png" /></p><p>故正确答案为B。</p>

---

## 第 3 题　<sub>qid 700303 · 邓小平理论</sub>

<p>题干引用共享图：<img src="../90-图片/题目图/shared-v.png" /></p>

- **A**. 虚构选项一　✅
- **B**. 虚构选项二
- **C**. 虚构选项三
- **D**. 虚构选项四

**答案**：A

**官方解析**

纯文本解析。

---

## 第 4 题　<sub>qid 700304 · 三个代表</sub>

<p>题干配图两张：</p><p><img src="../90-图片/题目图/q4a-v.png" alt="虚构题四甲图" /></p><p><img src="../90-图片/题目图/q4b-v.png" alt="虚构题四乙图" /></p>

- **A**. 虚构选项一　✅
- **B**. 虚构选项二
- **C**. 虚构选项三
- **D**. 虚构选项四

**答案**：A

**官方解析**

纯文本解析。

---

## 第 5 题　<sub>qid 700305 · 科学发展观</sub>

纯文本题干（无图片段）。

- **A**. 虚构选项一　✅
- **B**. 虚构选项二
- **C**. 虚构选项三
- **D**. 虚构选项四

**答案**：A

**官方解析**

纯文本解析。

---
`

/** 向输入树写一个文件（自动建父目录；resolveWithin 界内校验——与源码同一防线） */
function writeFile(root: string, rel: string, content: Buffer | string): void {
  const target = resolveWithin(root, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

fs.mkdirSync(path.join(inputDir, '01-政治理论'), { recursive: true })
writeFile(inputDir, '90-图片/题目图/material-v.png', PNG_MATERIAL)
writeFile(inputDir, '90-图片/题目图/stem-v.png', PNG_STEM)
writeFile(inputDir, '90-图片/公式图/option-v.png', PNG_OPTION)
writeFile(inputDir, '90-图片/题目图/analysis-v.png', PNG_ANALYSIS)
writeFile(inputDir, '90-图片/题目图/shared-v.png', PNG_SHARED)
writeFile(inputDir, '90-图片/题目图/q4a-v.png', PNG_Q4A)
writeFile(inputDir, '90-图片/题目图/q4b-v.png', PNG_Q4B)
writeFile(
  inputDir,
  '01-政治理论/2024年虚构省公务员录用考试《行测》题（视觉甲卷）.md',
  visionPaper,
)
runImport({ inputDir, outputDir: baseProducts, version: 'v-vis' })
await runImagesStage({ productsDir: baseProducts })

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/* ============ 断言辅助 ============ */

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/** 源字节 → 内容寻址键（png 压缩为 webp，键锚定源字节） */
const keyOf = (bytes: Buffer): string => `img/${sha256(bytes)}.webp`

const K_STEM = keyOf(PNG_STEM)
const K_OPTION = keyOf(PNG_OPTION)
const K_ANALYSIS = keyOf(PNG_ANALYSIS)
const K_SHARED = keyOf(PNG_SHARED)
const K_Q4A = keyOf(PNG_Q4A)
const K_Q4B = keyOf(PNG_Q4B)
const K_MATERIAL = keyOf(PNG_MATERIAL)
/** 孤儿 staging 键形态（未被任何枚举段引用） */
const K_ORPHAN = `img/${'f'.repeat(64)}.webp`

/** staging 文本（合成虚构内容） */
const T_STEM = '题干图提取：虚构折线图文字\n（题一提取行二）'
const T_STEM_RAW = `  题干图提取：虚构折线图文字
（题一提取行二）
`
const T_OPTION = '选项图提取：公式 a²+b²=c²'
const T_ANALYSIS = '解析图提取：虚构柱状图说明'
const T_SHARED = '共享图提取：跨题复用配图文本'
const T_Q4A = '题四甲图提取文本'
const T_Q4B = '题四乙图提取文本'
/** 第 1 题 visionText：题干段序 → 选项序 → 解析段序，'\n' 连接 */
const V1_TEXT = [T_STEM, T_OPTION, T_ANALYSIS].join('\n')
/** 第 4 题 visionText（两图全齐时） */
const V4_TEXT = [T_Q4A, T_Q4B].join('\n')

/** 基础产物 → 独立场景目录（拷贝含键化模块、r2 工件与 images-manifest；resolveWithin 界内校验——与源码同一防线） */
function scenario(name: string): string {
  const dir = resolveWithin(outDir, name)
  fs.cpSync(baseProducts, dir, { recursive: true })
  return dir
}

/** 写 staging 文本（键含斜杠：vision-in/<键>.txt；自动建父目录） */
function writeStaging(productsRoot: string, key: string, text: string): void {
  const target = resolveWithin(productsRoot, `vision-in/${key}.txt`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text, 'utf8')
}

/** 全部题目宿主键写 staging（题干 staging 带首尾空白验证 trim；除题四乙键外全覆盖） */
function stageAllExceptQ4b(productsRoot: string): void {
  writeStaging(productsRoot, K_STEM, T_STEM_RAW)
  writeStaging(productsRoot, K_OPTION, T_OPTION)
  writeStaging(productsRoot, K_ANALYSIS, T_ANALYSIS)
  writeStaging(productsRoot, K_SHARED, T_SHARED)
  writeStaging(productsRoot, K_Q4A, T_Q4A)
}

/** 产物模块 JSON → 试卷数组 */
function readPapers(productsRoot: string, module: string): ParsedPaper[] {
  const raw = fs.readFileSync(path.join(productsRoot, 'modules', `${module}.json`), 'utf8')
  return (JSON.parse(raw) as { papers: ParsedPaper[] }).papers
}

function findQuestion(papers: ParsedPaper[], qid: string): ParsedQuestion | undefined {
  for (const paper of papers) {
    for (const item of paper.items) {
      if ('qid' in item && item.qid === qid) return item
    }
  }
  return undefined
}

function findGroup(papers: ParsedPaper[], index: number): ParsedGroup | undefined {
  for (const paper of papers) {
    for (const item of paper.items) {
      if (!('qid' in item) && item.index === index) return item
    }
  }
  return undefined
}

/** 富内容中的图片段（收窄后便于断言 path） */
function imagesOf(content: RichContent): Array<{ type: 'image'; path: string; alt?: string }> {
  return content.filter((segment): segment is Extract<RichSegment, { type: 'image' }> => segment.type === 'image')
}

function readVisionManifest(productsRoot: string): {
  version: string
  stats: Record<string, number>
  entries: Array<{ key: string; text: string; refs: number }>
  pending: string[]
  issues: Array<{ severity: string; code: string; file: string; qid: string | null; message: string }>
} {
  return JSON.parse(fs.readFileSync(path.join(productsRoot, 'vision-manifest.json'), 'utf8'))
}

/** 全部题目的期望 visionText（场景默认 staging 布局下的回写期望） */
const EXPECTED_VISION_TEXT: Record<string, string> = {
  '700301': V1_TEXT,
  '700302': T_SHARED,
  '700303': T_SHARED,
  '700304': '',
  '700305': '',
}

/* ============ 吸收回写与枚举范围 ============ */

describe('runVisionStage：吸收回写', () => {
  it('staging 文本 → visionText = 各段文本按题干段序→选项序→解析段序以换行连接；trim 吸收内部换行保留；模块 JSON 其余字段不变', async () => {
    const dir = scenario('absorb')
    stageAllExceptQ4b(dir)
    const before = readPapers(dir, 'political_theory')
    const result = await runVisionStage({ productsDir: dir })
    expect(result.stats).toEqual({
      references: 7,
      images: 6,
      extracted: 5,
      pending: 1,
      errors: 0,
      warnings: 0,
    })
    expect(result.issues).toEqual([])
    expect(result.rewrote).toEqual([path.join(dir, 'modules', 'political_theory.json')])
    expect(result.wrote).toEqual([
      path.join(dir, 'modules', 'political_theory.json'),
      path.join(dir, 'vision-manifest.json'),
    ])

    const after = readPapers(dir, 'political_theory')
    expect(findQuestion(after, '700301')?.visionText).toBe(V1_TEXT)
    expect(findQuestion(after, '700302')?.visionText).toBe(T_SHARED)
    expect(findQuestion(after, '700303')?.visionText).toBe(T_SHARED)
    expect(findQuestion(after, '700304')?.visionText).toBe('')
    expect(findQuestion(after, '700305')?.visionText).toBe('')
    // 模块 JSON 其余字段不变：逐题仅 visionText 差异（题组与非枚举字段原样）
    expect(after).toEqual(
      before.map((paper) => ({
        ...paper,
        items: paper.items.map((item) =>
          'qid' in item ? { ...item, visionText: EXPECTED_VISION_TEXT[item.qid] ?? '<unexpected>' } : item,
        ),
      })),
    )
  })

  it('vision-manifest.json：version 登记、entries 首见序与 refs、pending 首见序、2 空格缩进尾随换行', async () => {
    const dir = scenario('manifest-shape')
    stageAllExceptQ4b(dir)
    await runVisionStage({ productsDir: dir })
    const manifest = readVisionManifest(dir)
    expect(manifest.version).toBe('v-vis')
    expect(manifest.stats).toEqual({
      references: 7,
      images: 6,
      extracted: 5,
      pending: 1,
      errors: 0,
      warnings: 0,
    })
    // 首见序 = 模块序 → 试卷序 → items 序 → 宿主序（题干 → 选项 → 解析）→ 段序
    expect(manifest.entries).toEqual([
      { key: K_STEM, text: T_STEM, refs: 1 },
      { key: K_OPTION, text: T_OPTION, refs: 1 },
      { key: K_ANALYSIS, text: T_ANALYSIS, refs: 1 },
      { key: K_SHARED, text: T_SHARED, refs: 2 },
      { key: K_Q4A, text: T_Q4A, refs: 1 },
    ])
    expect(manifest.pending).toEqual([K_Q4B])
    expect(manifest.issues).toEqual([])
    expect(fs.readFileSync(path.join(dir, 'vision-manifest.json'), 'utf8').endsWith('\n')).toBe(true)
  })

  it('题组材料图片不枚举：不进 entries/pending，references 不计材料段，材料段 path 保持键化原样', async () => {
    const dir = scenario('material-skip')
    stageAllExceptQ4b(dir)
    await runVisionStage({ productsDir: dir })
    const manifest = readVisionManifest(dir)
    expect(manifest.entries.map((entry) => entry.key)).not.toContain(K_MATERIAL)
    expect(manifest.pending).not.toContain(K_MATERIAL)
    // references 7 = 第 1 题三段 + 第 2 题一段 + 第 3 题一段 + 第 4 题两段；材料段不计
    expect(manifest.stats.references).toBe(7)
    const papers = readPapers(dir, 'political_theory')
    expect(imagesOf(findGroup(papers, 1)?.material ?? [])[0]?.path).toBe(K_MATERIAL)
  })

  it('共享键跨题：单 entries 条目 refs=2，两题均回写同一文本', async () => {
    const dir = scenario('shared-key')
    stageAllExceptQ4b(dir)
    const result = await runVisionStage({ productsDir: dir })
    expect(result.issues).toEqual([])
    const papers = readPapers(dir, 'political_theory')
    expect(findQuestion(papers, '700302')?.visionText).toBe(T_SHARED)
    expect(findQuestion(papers, '700303')?.visionText).toBe(T_SHARED)
    expect(readVisionManifest(dir).entries.filter((entry) => entry.key === K_SHARED)).toEqual([
      { key: K_SHARED, text: T_SHARED, refs: 2 },
    ])
  })

  it('无图片题 visionText 保持空串；按题原子：一题两图仅一图有文本 → 该题保持现值，全齐题回写', async () => {
    const dir = scenario('atomic')
    stageAllExceptQ4b(dir)
    await runVisionStage({ productsDir: dir })
    const papers = readPapers(dir, 'political_theory')
    // 第 4 题：题四甲图有文本、题四乙图 pending → 不写半截，保持空串
    expect(findQuestion(papers, '700304')?.visionText).toBe('')
    // 第 5 题无图片段：保持空串（不产生任何枚举与条目）
    expect(findQuestion(papers, '700305')?.visionText).toBe('')
    const manifest = readVisionManifest(dir)
    // 题四甲图已有文本（entries 条目存在），题四乙图 pending：原子性由段状态而非条目缺失决定
    expect(manifest.entries.find((entry) => entry.key === K_Q4A)?.text).toBe(T_Q4A)
    expect(manifest.pending).toEqual([K_Q4B])
    // 第 1 题全齐 → 已回写（对照组）
    expect(findQuestion(papers, '700301')?.visionText).toBe(V1_TEXT)
  })
})

/* ============ 解析缺省可入（ADR-0011 两级宿主） ============ */

describe('runVisionStage：解析缺省可入（ADR-0011）', () => {
  it('必选全齐而解析无 staging → 该题回写题干+选项文本（不含解析）；pending 为空（纯解析键出范围）', async () => {
    const dir = scenario('analysis-optional')
    // 全部必选键 + 共享键有 staging，唯解析键（K_ANALYSIS）的 staging 删除
    stageAllExceptQ4b(dir)
    writeStaging(dir, K_Q4B, T_Q4B)
    fs.rmSync(resolveWithin(dir, `vision-in/${K_ANALYSIS}.txt`))
    const result = await runVisionStage({ productsDir: dir })
    expect(result.stats).toEqual({
      references: 7,
      images: 6,
      extracted: 5,
      pending: 0,
      errors: 0,
      warnings: 0,
    })
    const papers = readPapers(dir, 'political_theory')
    // 第 1 题：题干+选项文本回写，解析缺省不入拼接
    expect(findQuestion(papers, '700301')?.visionText).toBe([T_STEM, T_OPTION].join('\n'))
    // 第 4 题两图全齐 → 正常回写（对照）
    expect(findQuestion(papers, '700304')?.visionText).toBe(V4_TEXT)
    // 纯解析键：无 entries 条目、不在 pending（出提取范围）
    const manifest = readVisionManifest(dir)
    expect(manifest.entries.find((entry) => entry.key === K_ANALYSIS)).toBeUndefined()
    expect(manifest.pending).toEqual([])
  })

  it('解析段未键化 → error vision_requires_images 仍记录，但不阻塞该题回写（必选全齐）', async () => {
    const dir = scenario('analysis-unkeyed')
    stageAllExceptQ4b(dir)
    writeStaging(dir, K_Q4B, T_Q4B)
    // 手工把第 1 题解析段 path 改回源相对路径（模拟 images 阶段该段失败保持源路径）
    const papersPath = path.join(dir, 'modules', 'political_theory.json')
    const root = JSON.parse(fs.readFileSync(papersPath, 'utf8')) as { papers: ParsedPaper[] }
    const q1Analysis = findQuestion(root.papers, '700301')?.analysis
    const seg = q1Analysis?.find((s) => s.type === 'image')
    if (!seg) throw new Error('夹具第 1 题解析段缺失图片段')
    seg.path = '../90-图片/题目图/analysis-v.png'
    fs.writeFileSync(papersPath, JSON.stringify(root), 'utf8')
    const result = await runVisionStage({ productsDir: dir })
    expect(result.stats).toEqual({
      references: 7,
      images: 5,
      extracted: 5,
      pending: 0,
      errors: 1,
      warnings: 0,
    })
    expect(result.issues).toEqual([
      {
        severity: 'error',
        code: 'vision_requires_images',
        file: '01-政治理论/2024年虚构省公务员录用考试《行测》题（视觉甲卷）.md',
        qid: '700301',
        message: expect.stringContaining('../90-图片/题目图/analysis-v.png'),
      },
    ])
    // 必选全齐 → 该题照常回写（解析未键不阻塞）
    expect(findQuestion(readPapers(dir, 'political_theory'), '700301')?.visionText).toBe(
      [T_STEM, T_OPTION].join('\n'),
    )
  })

  it('纯解析 pending 键工件缺失 → 不报 artifact_missing（出范围不做工件检查）', async () => {
    const dir = scenario('analysis-artifact-missing')
    // 无任何 staging（全 pending 态）且删除解析键工件：旧语义会报 artifact_missing，ADR-0011 后纯解析键不检查
    fs.rmSync(resolveWithin(dir, `r2/${K_ANALYSIS}`))
    const result = await runVisionStage({ productsDir: dir })
    expect(result.issues).toEqual([])
    expect(result.stats.errors).toBe(0)
    expect(result.pending).not.toContain(K_ANALYSIS)
    // 必选键的工件缺失仍检查（对照：删题干工件必报）
    fs.rmSync(resolveWithin(dir, `r2/${K_STEM}`))
    const second = await runVisionStage({ productsDir: dir })
    expect(second.issues).toEqual([
      {
        severity: 'error',
        code: 'artifact_missing',
        file: '01-政治理论/2024年虚构省公务员录用考试《行测》题（视觉甲卷）.md',
        qid: '700301',
        message: expect.stringContaining(K_STEM),
      },
    ])
  })
})

/* ============ pending 与空白 staging ============ */

describe('runVisionStage：pending 与空白 staging', () => {
  it('无 staging → manifest.pending 只含必选键（ADR-0011：纯解析键 K_ANALYSIS 出范围），仅 manifest 落盘，模块 JSON 不回写', async () => {
    const dir = scenario('pending-all')
    const result = await runVisionStage({ productsDir: dir })
    expect(result.stats).toEqual({
      references: 7,
      images: 6,
      extracted: 0,
      pending: 5,
      errors: 0,
      warnings: 0,
    })
    expect(result.pending).toEqual([K_STEM, K_OPTION, K_SHARED, K_Q4A, K_Q4B])
    expect(result.rewrote).toEqual([])
    expect(result.wrote).toEqual([path.join(dir, 'vision-manifest.json')])
    // 待提取是正常状态：不算 issue，退出语义由 CLI 判 1（见 CLI describe）
    expect(result.issues).toEqual([])
    // 无文本回写：模块 JSON 与键化产物一致（visionText 全空串）
    const papers = readPapers(dir, 'political_theory')
    for (const qid of ['700301', '700302', '700303', '700304', '700305']) {
      expect(findQuestion(papers, qid)?.visionText).toBe('')
    }
  })

  it('空白 staging 文件 → warning vision_text_empty、缓存空串、算 extracted 不 pending', async () => {
    const dir = scenario('empty-staging')
    stageAllExceptQ4b(dir)
    writeStaging(dir, K_Q4A, '   \n\t \n') // 题四甲图 staging 空白
    const result = await runVisionStage({ productsDir: dir })
    expect(result.stats).toEqual({
      references: 7,
      images: 6,
      extracted: 5,
      pending: 1,
      errors: 0,
      warnings: 1,
    })
    expect(result.issues).toEqual([
      {
        severity: 'warning',
        code: 'vision_text_empty',
        file: '01-政治理论/2024年虚构省公务员录用考试《行测》题（视觉甲卷）.md',
        qid: '700304',
        message: expect.stringContaining(K_Q4A),
      },
    ])
    // 空白条目：text = ''，算已提取（entries 5 条），不进 pending
    const manifest = readVisionManifest(dir)
    expect(manifest.entries.find((entry) => entry.key === K_Q4A)).toEqual({
      key: K_Q4A,
      text: '',
      refs: 1,
    })
    expect(manifest.pending).toEqual([K_Q4B])
    // 第 4 题仍有 pending 段 → 按题原子保持空串（不因空串条目半截回写）
    expect(findQuestion(readPapers(dir, 'political_theory'), '700304')?.visionText).toBe('')
  })

  it('staging 读取抛错（staging 路径被目录占位）→ error vision_stage_read_failed（含错误消息），键保持 pending', async () => {
    const dir = scenario('read-failed')
    stageAllExceptQ4b(dir)
    // 题干 staging 文件换成同名目录：exists 为真、readFileSync 抛错（确定性触发读取失败）
    const stemStaging = resolveWithin(dir, `vision-in/${K_STEM}.txt`)
    fs.rmSync(stemStaging)
    fs.mkdirSync(stemStaging)
    const result = await runVisionStage({ productsDir: dir })
    expect(result.stats.errors).toBe(1)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({
      severity: 'error',
      code: 'vision_stage_read_failed',
      file: '01-政治理论/2024年虚构省公务员录用考试《行测》题（视觉甲卷）.md',
      qid: '700301',
    })
    expect(result.issues[0].message).toContain(K_STEM)
    // 键保持 pending：不进 entries（artifact 在位故无 artifact_missing 二连报）
    const manifest = readVisionManifest(dir)
    expect(manifest.entries.find((entry) => entry.key === K_STEM)).toBeUndefined()
    expect(manifest.pending).toEqual([K_STEM, K_Q4B])
    // 该题按原子保持空串
    expect(findQuestion(readPapers(dir, 'political_theory'), '700301')?.visionText).toBe('')
  })
})

/* ============ 缓存与幂等 ============ */

describe('runVisionStage：缓存与幂等', () => {
  it('幂等 no-op：全缓存重跑 → wrote 为空、manifest 与模块 JSON 字节均不变', async () => {
    const dir = scenario('idempotent')
    stageAllExceptQ4b(dir)
    await runVisionStage({ productsDir: dir })
    const manifestBytes = fs.readFileSync(path.join(dir, 'vision-manifest.json'))
    const moduleBytes = fs.readFileSync(path.join(dir, 'modules', 'political_theory.json'))
    const second = await runVisionStage({ productsDir: dir })
    expect(second.stats).toEqual({
      references: 7,
      images: 6,
      extracted: 5,
      pending: 1,
      errors: 0,
      warnings: 0,
    })
    expect(second.wrote).toEqual([])
    expect(second.rewrote).toEqual([])
    expect(second.issues).toEqual([])
    expect(fs.readFileSync(path.join(dir, 'vision-manifest.json')).equals(manifestBytes)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'modules', 'political_theory.json')).equals(moduleBytes)).toBe(true)
  })

  it('缓存优先：吸收后删除 staging 重跑 → no-op 文本保留；staging 事后改为新文本 → 缓存文本胜出', async () => {
    const dir = scenario('cache-priority')
    stageAllExceptQ4b(dir)
    await runVisionStage({ productsDir: dir })

    // 删除全部 staging → 重跑 no-op，visionText 保留
    fs.rmSync(path.join(dir, 'vision-in'), { recursive: true, force: true })
    const afterDelete = await runVisionStage({ productsDir: dir })
    expect(afterDelete.wrote).toEqual([])
    expect(findQuestion(readPapers(dir, 'political_theory'), '700301')?.visionText).toBe(V1_TEXT)

    // staging 事后写入新文本 → 缓存文本胜出（防抖动；不重吸收）
    writeStaging(dir, K_STEM, '事后变更的新提取文本')
    const afterFlip = await runVisionStage({ productsDir: dir })
    expect(afterFlip.wrote).toEqual([])
    expect(findQuestion(readPapers(dir, 'political_theory'), '700301')?.visionText).toBe(V1_TEXT)
    expect(readVisionManifest(dir).entries.find((entry) => entry.key === K_STEM)?.text).toBe(T_STEM)
  })

  it('重新 parse 恢复：visionText 归零、images 重键化同键 → 从缓存恢复回写（免重提取）', async () => {
    const dir = scenario('reparse')
    stageAllExceptQ4b(dir)
    await runVisionStage({ productsDir: dir })
    // 删除 staging：恢复只可能来自缓存
    fs.rmSync(path.join(dir, 'vision-in'), { recursive: true, force: true })
    // 重跑 parse（visionText 归空串、path 归源路径）→ images 重键化（内容寻址同键）
    runImport({ inputDir, outputDir: dir, version: 'v-vis' })
    expect(findQuestion(readPapers(dir, 'political_theory'), '700301')?.visionText).toBe('')
    await runImagesStage({ productsDir: dir })
    const result = await runVisionStage({ productsDir: dir })
    // 缓存恢复：全部题目文本回来，entries 来自缓存（无 staging 可读）
    expect(result.stats.extracted).toBe(5)
    expect(result.stats.pending).toBe(1)
    const papers = readPapers(dir, 'political_theory')
    expect(findQuestion(papers, '700301')?.visionText).toBe(V1_TEXT)
    expect(findQuestion(papers, '700302')?.visionText).toBe(T_SHARED)
    expect(findQuestion(papers, '700303')?.visionText).toBe(T_SHARED)
    expect(findQuestion(papers, '700304')?.visionText).toBe('')
    // 模块 JSON 回写；manifest 与缓存态逐字节同 → 不重写
    expect(result.wrote).toEqual([path.join(dir, 'modules', 'political_theory.json')])
  })

  it('manifest 字节确定性：同状态两个独立产物目录两次运行 → vision-manifest.json 逐字节相同', async () => {
    const dirA = scenario('determinism-a')
    const dirB = scenario('determinism-b')
    stageAllExceptQ4b(dirA)
    stageAllExceptQ4b(dirB)
    await runVisionStage({ productsDir: dirA })
    await runVisionStage({ productsDir: dirB })
    const bytesA = fs.readFileSync(path.join(dirA, 'vision-manifest.json'))
    const bytesB = fs.readFileSync(path.join(dirB, 'vision-manifest.json'))
    expect(bytesB.equals(bytesA)).toBe(true)
    // 同状态第二次运行不重写（字节保持）
    await runVisionStage({ productsDir: dirA })
    expect(fs.readFileSync(path.join(dirA, 'vision-manifest.json')).equals(bytesA)).toBe(true)
  })
})

/* ============ 错误路径与产物校验 ============ */

describe('runVisionStage：问题清单与产物校验', () => {
  it('未键路径（只 parse 不 images）→ error vision_requires_images（含该段 path）；题组材料段不枚举故不报', async () => {
    const dir = path.join(outDir, 'unkeyed-products')
    runImport({ inputDir, outputDir: dir, version: 'v-vis' })
    const result = await runVisionStage({ productsDir: dir })
    // 7 个题目宿主段全部未键化（材料段不枚举 → 8 个 image 段中只报 7 个）
    expect(result.stats).toEqual({
      references: 7,
      images: 0,
      extracted: 0,
      pending: 0,
      errors: 7,
      warnings: 0,
    })
    expect(result.issues.every((entry) => entry.code === 'vision_requires_images')).toBe(true)
    const first = result.issues[0]
    expect(first).toMatchObject({
      severity: 'error',
      file: '01-政治理论/2024年虚构省公务员录用考试《行测》题（视觉甲卷）.md',
      qid: '700301',
    })
    expect(first.message).toContain('需先跑 images 阶段')
    expect(first.message).toContain('../90-图片/题目图/stem-v.png')
    // 未键 → 键不可判 → 无 entries/pending；全部题目保持空串
    expect(result.pending).toEqual([])
    const papers = readPapers(dir, 'political_theory')
    expect(findQuestion(papers, '700301')?.visionText).toBe('')
  })

  it('工件缺失（键在但删 r2 工件）→ error artifact_missing；缓存已有文本的键删工件 → 不报', async () => {
    const dir = scenario('artifact-missing')
    stageAllExceptQ4b(dir)
    await runVisionStage({ productsDir: dir })
    // 吸收后删两件工件：题四乙（pending 键）与题干（已缓存键）；r2/<键> 派生删除路径经 resolveWithin 界内校验
    fs.rmSync(resolveWithin(dir, `r2/${K_Q4B}`))
    fs.rmSync(resolveWithin(dir, `r2/${K_STEM}`))
    const second = await runVisionStage({ productsDir: dir })
    expect(second.stats.errors).toBe(1)
    expect(second.issues).toEqual([
      {
        severity: 'error',
        code: 'artifact_missing',
        file: '01-政治理论/2024年虚构省公务员录用考试《行测》题（视觉甲卷）.md',
        qid: '700304',
        message: expect.stringContaining('需重新 parse 后重跑'),
      },
    ])
    expect(second.issues[0].message).toContain(K_Q4B)
    // 已缓存键（题干）工件缺失不报：文本保留、题目不受影响
    expect(findQuestion(readPapers(dir, 'political_theory'), '700301')?.visionText).toBe(V1_TEXT)
  })

  it('孤儿 staging（材料键与未引用键形态）→ 静默忽略：不进 entries/pending、不产生 issue', async () => {
    const dir = scenario('orphan-staging')
    writeStaging(dir, K_MATERIAL, '材料孤儿文本')
    writeStaging(dir, K_ORPHAN, '未引用孤儿文本')
    const result = await runVisionStage({ productsDir: dir })
    expect(result.issues).toEqual([])
    expect(result.stats.extracted).toBe(0)
    expect(result.pending).toEqual([K_STEM, K_OPTION, K_SHARED, K_Q4A, K_Q4B])
    const manifest = readVisionManifest(dir)
    expect(manifest.entries).toEqual([])
    expect(manifest.pending).not.toContain(K_MATERIAL)
    expect(manifest.pending).not.toContain(K_ORPHAN)
  })

  it('产物结构无效（无 manifest / vision-manifest 损坏）→ InvalidProductsError', async () => {
    const empty = path.join(outDir, 'empty-products')
    fs.mkdirSync(empty, { recursive: true })
    await expect(runVisionStage({ productsDir: empty })).rejects.toThrow(InvalidProductsError)
    const corrupted = scenario('corrupted-manifest')
    fs.writeFileSync(path.join(corrupted, 'vision-manifest.json'), '{ not json', 'utf8')
    await expect(runVisionStage({ productsDir: corrupted })).rejects.toThrow(InvalidProductsError)
  })
})

/* ============ CLI vision 子命令 ============ */

describe('CLI vision 子命令（main）', () => {
  const spyConsole = (): void => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  it('用法错误 → 2（缺 --products、products 目录不存在）', async () => {
    spyConsole()
    expect(await main(['vision'])).toBe(2)
    expect(await main(['vision', '--products'])).toBe(2)
    expect(await main(['vision', '--products', path.join(outDir, 'no-such-products')])).toBe(2)
  })

  it('完整产物全吸收 → 0（无 error 且无 pending）', async () => {
    spyConsole()
    const dir = scenario('cli-full')
    stageAllExceptQ4b(dir)
    writeStaging(dir, K_Q4B, T_Q4B)
    expect(await main(['vision', '--products', dir])).toBe(0)
    const papers = readPapers(dir, 'political_theory')
    expect(findQuestion(papers, '700304')?.visionText).toBe(V4_TEXT)
    expect(readVisionManifest(dir).pending).toEqual([])
  })

  it('有 pending → 1；有 error → 1；产物结构无效 → 1', async () => {
    spyConsole()
    const pendingDir = scenario('cli-pending')
    stageAllExceptQ4b(pendingDir) // 题四乙键无 staging → pending → 退出 1
    expect(await main(['vision', '--products', pendingDir])).toBe(1)

    const unkeyed = path.join(outDir, 'cli-unkeyed')
    runImport({ inputDir, outputDir: unkeyed, version: 'v-vis' })
    expect(await main(['vision', '--products', unkeyed])).toBe(1)

    const empty = path.join(outDir, 'cli-empty')
    fs.mkdirSync(empty, { recursive: true })
    expect(await main(['vision', '--products', empty])).toBe(1)
  })
})
