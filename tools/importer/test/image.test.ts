/**
 * 图片阶段测试（T1-05 阶段 A）：runImport 产物 → runImagesStage 压缩/透传/键派生/路径重写，
 * 断言模块 JSON 段级重写（alt 保留）、r2 工件可读回（sharp webp 元数据）、gif 原字节透传、
 * 映射与统计（images-manifest.json）、四类 error issue（缺失/类型/越界/工件缺失）、
 * 幂等重跑（无变更 no-op 不写文件）、整体字节确定性、--input 覆盖与 CLI 退出码。
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
import { runImagesStage, InvalidInputDirError } from '../src/image-stage.js'
import { main } from '../src/main.js'
import { runImport, resolveWithin } from '../src/pipeline.js'
import type { ParsedGroup, ParsedPaper, ParsedQuestion } from '../src/types.js'
import type { RichContent, RichSegment } from '@ncse/shared'

/* ============ 夹具生成（模块加载即建：describe 体在 beforeAll 之前执行会引用产物路径） ============ */

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncse-importer-image-'))
const cleanInput = path.join(outDir, 'clean-input')
const errorInput = path.join(outDir, 'error-input')
const cleanProducts = path.join(outDir, 'clean-products')
const errorProducts = path.join(outDir, 'error-products')

/** 生成 8x8 纯色位图字节 */
async function solidBytes(color: { r: number; g: number; b: number }, format: 'png' | 'gif'): Promise<Buffer> {
  const image = sharp({ create: { width: 8, height: 8, channels: 3, background: color } })
  return format === 'png' ? image.png().toBuffer() : image.gif().toBuffer()
}

const PNG_MATERIAL = await solidBytes({ r: 39, g: 174, b: 96 }, 'png')
const PNG_STEM = await solidBytes({ r: 192, g: 57, b: 43 }, 'png')
const PNG_FORMULA = await solidBytes({ r: 41, g: 128, b: 185 }, 'png')
const GIF_ANIM = await solidBytes({ r: 241, g: 196, b: 15 }, 'gif')
/** 迁移场景替换图（同路径不同内容 → 内容寻址键不同） */
const PNG_STEM_ALT = await solidBytes({ r: 22, g: 160, b: 133 }, 'png')

const cleanPaper = `---
类型: "真题"
试卷: "2024年虚构省公务员录用考试《行测》题（图片甲卷）"
地区: "虚构省"
年份: "2024"
模块: "政治理论"
题数: "2"
来源: "合成夹具（T1-05 图片阶段测试，全虚构）"
---

# 2024年虚构省公务员录用考试《行测》题（图片甲卷）

> 政治理论 · 2 题 · 虚构省 2024

## 材料 1

<p><img src="../90-图片/题目图/material-01.png" alt="虚构材料图" /><br></p>

### 第 1 题　<sub>qid 700101 · 马克思主义</sub>

<p>根据虚构材料图作答：</p><p><img src="../90-图片/题目图/stem-01.png" alt="虚构题干图" /></p>

- **A**. <p><img flag="tex" src="../90-图片/公式图/formula-01.png" /></p>
- **B**. 虚构选项二　✅
- **C**. 虚构选项三
- **D**. 虚构选项四

**答案**：B

**官方解析**

<p>解析配图（动图）：<img src="../90-图片/题目图/anim-01.gif" alt="虚构动图" /></p><p>故正确答案为B。</p>

---

## 第 2 题　<sub>qid 700102 · 毛泽东思想</sub>

纯文本题干（无图片段，验证文本段与结构不受图片阶段影响）。

- **A**. 虚构选项一
- **B**. 虚构选项二　✅
- **C**. 虚构选项三
- **D**. 虚构选项四

**答案**：B

**官方解析**

<p>复用题干配图（同源文件二次引用）：<img src="../90-图片/题目图/stem-01.png" /></p><p>故正确答案为B。</p>

---
`

const errorPaper = `---
类型: "真题"
试卷: "虚构图片错误卷"
地区: "虚构省"
年份: "2024"
模块: "政治理论"
题数: "2"
来源: "合成夹具（T1-05 图片阶段错误路径测试，全虚构）"
---

# 虚构图片错误卷

> 政治理论 · 2 题 · 虚构省 2024

## 第 1 题　<sub>qid 700201 · 量变质变</sub>

<p>缺失图：<img src="../90-图片/题目图/absent-01.png" alt="虚构缺失图" /></p>

- **A**. 虚构选项一　✅
- **B**. 虚构选项二
- **C**. 虚构选项三
- **D**. 虚构选项四

**答案**：A

**官方解析**

<p>未知类型图：<img src="../90-图片/题目图/weird-01.svg" /></p>

---

## 第 2 题　<sub>qid 700202 · 矛盾论</sub>

<p>越界图：<img src="../../escape-01.png" alt="虚构越界图" /></p>

- **A**. 虚构选项一　✅
- **B**. 虚构选项二
- **C**. 虚构选项三
- **D**. 虚构选项四

**答案**：A

**官方解析**

纯文本解析。

---
`

/** 向输入树写一个文件（自动建父目录；POSIX 相对路径；resolveWithin 界内校验——与源码同一防线） */
function writeFile(root: string, rel: string, content: Buffer | string): void {
  const target = resolveWithin(root, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

fs.mkdirSync(path.join(cleanInput, '01-政治理论'), { recursive: true })
writeFile(cleanInput, '90-图片/题目图/material-01.png', PNG_MATERIAL)
writeFile(cleanInput, '90-图片/题目图/stem-01.png', PNG_STEM)
writeFile(cleanInput, '90-图片/公式图/formula-01.png', PNG_FORMULA)
writeFile(cleanInput, '90-图片/题目图/anim-01.gif', GIF_ANIM)
writeFile(
  cleanInput,
  '01-政治理论/2024年虚构省公务员录用考试《行测》题（图片甲卷）.md',
  cleanPaper,
)
runImport({ inputDir: cleanInput, outputDir: cleanProducts, version: 'v-img' })

fs.mkdirSync(path.join(errorInput, '01-政治理论'), { recursive: true })
writeFile(
  errorInput,
  '90-图片/题目图/weird-01.svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#000"/></svg>',
)
writeFile(errorInput, '01-政治理论/虚构图片错误卷.md', errorPaper)
runImport({ inputDir: errorInput, outputDir: errorProducts, version: 'v-img-err' })

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

/** 富内容中的图片段（收窄后便于断言 path/alt） */
function imagesOf(content: RichContent): Array<{ type: 'image'; path: string; alt?: string }> {
  return content.filter((segment): segment is Extract<RichSegment, { type: 'image' }> => segment.type === 'image')
}

function readImagesManifest(productsRoot: string): {
  version: string
  input: string
  stats: Record<string, number>
  images: Array<{
    source: string
    key: string
    refs: number
    origBytes: number
    outBytes: number
    width: number
    height: number
    format: string
  }>
  issues: Array<{ severity: string; code: string; file: string; qid: string | null; message: string }>
} {
  return JSON.parse(fs.readFileSync(path.join(productsRoot, 'images-manifest.json'), 'utf8'))
}

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

/* ============ 成功路径：压缩重写与映射 ============ */

describe('runImagesStage：成功压缩重写（clean 产物）', () => {
  it('四处宿主图片段全部重写为内容寻址键，alt 保留；工件可被 sharp 读回 webp 元数据', async () => {
    const result = await runImagesStage({ productsDir: cleanProducts })
    expect(result.hardErrors).toBe(0)
    expect(result.stats).toEqual({
      references: 5,
      images: 4,
      compressed: 3,
      passthrough: 1,
      alreadyKeyed: 0,
      errors: 0,
      warnings: 0,
    })
    expect(result.rewrote).toEqual([path.join(cleanProducts, 'modules', 'political_theory.json')])

    const papers = readPapers(cleanProducts, 'political_theory')

    // 材料（题组宿主）
    const materialImage = imagesOf(findGroup(papers, 1)?.material ?? [])[0]
    expect(materialImage).toMatchObject({ type: 'image', alt: '虚构材料图' })
    expect(materialImage?.path).toBe(`img/${sha256(PNG_MATERIAL)}.webp`)

    // 题干
    const question = findQuestion(papers, '700101')
    const stemImage = imagesOf(question?.stem ?? [])[0]
    expect(stemImage).toMatchObject({ type: 'image', alt: '虚构题干图' })
    expect(stemImage?.path).toBe(`img/${sha256(PNG_STEM)}.webp`)

    // 选项 content（公式图场景）
    const optionImage = imagesOf(question?.options.find((option) => option.key === 'A')?.content ?? [])[0]
    expect(optionImage?.path).toBe(`img/${sha256(PNG_FORMULA)}.webp`)

    // 解析（gif 透传）
    const analysisImage = imagesOf(question?.analysis ?? [])[0]
    expect(analysisImage).toMatchObject({ type: 'image', alt: '虚构动图' })
    expect(analysisImage?.path).toBe(`img/${sha256(GIF_ANIM)}.gif`)

    // 工件存在且可被 sharp 读回（webp 元数据）
    const artifact = fs.readFileSync(path.join(cleanProducts, 'r2', ...(stemImage?.path ?? '').split('/')))
    const artifactMeta = await sharp(artifact).metadata()
    expect(artifactMeta.format).toBe('webp')
    expect(artifactMeta.width).toBe(8)
    expect(artifactMeta.height).toBe(8)
    // r2 目录 = 4 个工件，命名全部符合内容寻址键形态
    expect(listFiles(path.join(cleanProducts, 'r2'))).toHaveLength(4)
    for (const rel of listFiles(path.join(cleanProducts, 'r2'))) {
      expect(rel).toMatch(/^img\/[0-9a-f]{64}\.(webp|gif)$/)
    }

    // 文本段与试卷结构保留（JSON 原位改写不破坏其余字段）
    expect(papers[0].name).toBe('2024年虚构省公务员录用考试《行测》题（图片甲卷）')
    expect(question?.stem[0]).toEqual({ type: 'text', text: '根据虚构材料图作答：' })
    expect(question?.options.find((option) => option.key === 'B')?.content).toEqual([
      { type: 'text', text: '虚构选项二' },
    ])
    expect(findQuestion(papers, '700102')?.stem).toEqual([
      { type: 'text', text: '纯文本题干（无图片段，验证文本段与结构不受图片阶段影响）。' },
    ])
    expect(papers[0].meta['年份']).toBe('2024')
  })

  it('gif 原字节透传：工件字节与源文件逐字节一致', async () => {
    const papers = readPapers(cleanProducts, 'political_theory')
    const analysisImage = imagesOf(findQuestion(papers, '700101')?.analysis ?? [])[0]
    if (analysisImage === undefined) throw new Error('解析图片段缺失')
    const artifact = fs.readFileSync(path.join(cleanProducts, 'r2', ...analysisImage.path.split('/')))
    expect(artifact.equals(GIF_ANIM)).toBe(true)
    expect(analysisImage.path.endsWith('.gif')).toBe(true)
  })

  it('images-manifest.json：映射（首见序、refs 跨段累计）与统计；wrote 覆盖工件/模块/清单', async () => {
    const manifest = readImagesManifest(cleanProducts)
    expect(manifest.version).toBe('v-img')
    expect(manifest.input).toBe(path.resolve(cleanInput).replace(/\\/g, '/'))
    expect(manifest.stats).toEqual({
      references: 5,
      images: 4,
      compressed: 3,
      passthrough: 1,
      alreadyKeyed: 0,
      errors: 0,
      warnings: 0,
    })
    // 首见序 = 模块序 → 试卷序 → items 序 → 段序（材料 → 题干 → 选项 → 解析动图）
    expect(manifest.images.map((entry) => entry.source)).toEqual([
      '90-图片/题目图/material-01.png',
      '90-图片/题目图/stem-01.png',
      '90-图片/公式图/formula-01.png',
      '90-图片/题目图/anim-01.gif',
    ])
    const stemMapping = manifest.images.find((entry) => entry.source === '90-图片/题目图/stem-01.png')
    expect(stemMapping).toEqual({
      source: '90-图片/题目图/stem-01.png',
      key: `img/${sha256(PNG_STEM)}.webp`,
      refs: 2, // 第 1 题题干 + 第 2 题解析（同源文件二次引用）
      origBytes: PNG_STEM.length,
      outBytes: fs.statSync(path.join(cleanProducts, 'r2', 'img', `${sha256(PNG_STEM)}.webp`)).size,
      width: 8,
      height: 8,
      format: 'png',
    })
    const gifMapping = manifest.images.find((entry) => entry.source === '90-图片/题目图/anim-01.gif')
    expect(gifMapping).toMatchObject({
      key: `img/${sha256(GIF_ANIM)}.gif`,
      refs: 1,
      origBytes: GIF_ANIM.length,
      outBytes: GIF_ANIM.length,
      width: 8,
      height: 8,
      format: 'gif',
    })
    expect(manifest.issues).toEqual([])
    // images-manifest.json 为确定性格式（2 空格缩进 + 尾随换行）
    expect(fs.readFileSync(path.join(cleanProducts, 'images-manifest.json'), 'utf8').endsWith('\n')).toBe(true)

    // import-manifest.json 不被回写（parse 阶段的记录）
    const importManifest = JSON.parse(
      fs.readFileSync(path.join(cleanProducts, 'import-manifest.json'), 'utf8'),
    ) as { version: string }
    expect(importManifest.version).toBe('v-img')
  })
})

/* ============ 错误路径：四类 error issue ============ */

describe('runImagesStage：问题清单（error 产物）', () => {
  it('缺失图片 → image_missing；未知扩展 → unsupported_image_type；越界 → image_path_escape；段全部保持源路径', async () => {
    const result = await runImagesStage({ productsDir: errorProducts })
    expect(result.hardErrors).toBe(3)
    expect(result.stats).toEqual({
      references: 3,
      images: 0,
      compressed: 0,
      passthrough: 0,
      alreadyKeyed: 0,
      errors: 3,
      warnings: 0,
    })

    const missing = result.issues.find((entry) => entry.code === 'image_missing')
    expect(missing).toMatchObject({
      severity: 'error',
      file: '01-政治理论/虚构图片错误卷.md',
      qid: '700201',
    })
    expect(missing?.message).toContain('absent-01.png')

    const unsupported = result.issues.find((entry) => entry.code === 'unsupported_image_type')
    expect(unsupported).toMatchObject({ severity: 'error', qid: '700201' })
    expect(unsupported?.message).toContain('weird-01.svg')

    const pathEscape = result.issues.find((entry) => entry.code === 'image_path_escape')
    expect(pathEscape).toMatchObject({ severity: 'error', qid: '700202' })
    expect(pathEscape?.message).toContain('../../escape-01.png')

    // 失败段保持源路径（不静默篡改），模块 JSON 无改写、r2 未建立、仅 manifest 落盘
    const papers = readPapers(errorProducts, 'political_theory')
    expect(imagesOf(findQuestion(papers, '700201')?.stem ?? [])[0]?.path).toBe('../90-图片/题目图/absent-01.png')
    expect(imagesOf(findQuestion(papers, '700201')?.analysis ?? [])[0]?.path).toBe('../90-图片/题目图/weird-01.svg')
    expect(imagesOf(findQuestion(papers, '700202')?.stem ?? [])[0]?.path).toBe('../../escape-01.png')
    expect(result.rewrote).toEqual([])
    expect(fs.existsSync(path.join(errorProducts, 'r2'))).toBe(false)
    expect(result.wrote).toEqual([path.join(errorProducts, 'images-manifest.json')])
    expect(readImagesManifest(errorProducts).issues.map((entry) => entry.code).sort()).toEqual([
      'image_missing',
      'image_path_escape',
      'unsupported_image_type',
    ])
  })

  it('已键段工件缺失 → artifact_missing（提示重新 parse；其余已键段 alreadyKeyed）', async () => {
    const broken = path.join(outDir, 'broken-products')
    fs.cpSync(cleanProducts, broken, { recursive: true })
    fs.rmSync(path.join(broken, 'r2', 'img', `${sha256(PNG_MATERIAL)}.webp`))
    const result = await runImagesStage({ productsDir: broken })
    expect(result.hardErrors).toBe(1)
    expect(result.stats).toEqual({
      references: 5,
      images: 0,
      compressed: 0,
      passthrough: 0,
      alreadyKeyed: 4,
      errors: 1,
      warnings: 0,
    })
    expect(result.issues[0]).toMatchObject({
      severity: 'error',
      code: 'artifact_missing',
      file: '01-政治理论/2024年虚构省公务员录用考试《行测》题（图片甲卷）.md',
      qid: null, // 材料段不挂具体题目
    })
    expect(result.issues[0].message).toContain('需重新 parse 后重跑')
  })
})

/* ============ 幂等与整体确定性 ============ */

describe('幂等与确定性', () => {
  it('重跑（不重 parse）→ 全部 alreadyKeyed、无任何写出、产物逐字节不变', async () => {
    const before = snapshotDir(cleanProducts)
    const second = await runImagesStage({ productsDir: cleanProducts })
    expect(second.stats).toEqual({
      references: 5,
      images: 0,
      compressed: 0,
      passthrough: 0,
      alreadyKeyed: 5,
      errors: 0,
      warnings: 0,
    })
    expect(second.wrote).toEqual([])
    expect(second.rewrote).toEqual([])
    expect(second.issues).toEqual([])
    const after = snapshotDir(cleanProducts)
    expect([...after.keys()]).toEqual([...before.keys()])
    for (const [rel, bytes] of before) {
      expect(after.get(rel)?.equals(bytes)).toBe(true)
    }
  })

  it('清空产物重跑 parse + images → 与首次逐字节一致', async () => {
    const fresh = path.join(outDir, 'fresh-products')
    runImport({ inputDir: cleanInput, outputDir: fresh, version: 'v-img' })
    await runImagesStage({ productsDir: fresh })
    const snapA = snapshotDir(cleanProducts)
    const snapB = snapshotDir(fresh)
    expect([...snapB.keys()]).toEqual([...snapA.keys()])
    for (const [rel, bytes] of snapA) {
      expect(snapB.get(rel)?.equals(bytes)).toBe(true)
    }
  })
})

/* ============ 入参与产物校验 ============ */

describe('产物/输入校验（InvalidProductsError / InvalidInputDirError）', () => {
  it('无 manifest → InvalidProductsError；输入目录缺失 → InvalidInputDirError', async () => {
    const empty = path.join(outDir, 'empty-products')
    fs.mkdirSync(empty, { recursive: true })
    await expect(runImagesStage({ productsDir: empty })).rejects.toThrow(InvalidProductsError)
    await expect(
      runImagesStage({ productsDir: cleanProducts, inputDir: path.join(outDir, 'gone-input') }),
    ).rejects.toThrow(InvalidInputDirError)
  })
})

/* ============ CLI images 子命令 ============ */

describe('CLI images 子命令（main）', () => {
  const spyConsole = (): void => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  it('用法错误 → 2（缺 --products、products 目录不存在、输入目录不存在）', async () => {
    spyConsole()
    expect(await main(['images'])).toBe(2)
    expect(await main(['images', '--products'])).toBe(2)
    expect(await main(['images', '--products', path.join(outDir, 'no-such-products')])).toBe(2)
    expect(
      await main(['images', '--products', cleanProducts, '--input', path.join(outDir, 'no-such-input')]),
    ).toBe(2)
  })

  it('--input 覆盖 manifest.input（源仓库迁移：键锚定迁移后源字节）', async () => {
    spyConsole()
    const movedInput = path.join(outDir, 'moved-input')
    fs.cpSync(cleanInput, movedInput, { recursive: true })
    writeFile(movedInput, '90-图片/题目图/stem-01.png', PNG_STEM_ALT)
    const movedProducts = path.join(outDir, 'moved-products')
    runImport({ inputDir: cleanInput, outputDir: movedProducts, version: 'v-img' })
    expect(await main(['images', '--products', movedProducts, '--input', movedInput])).toBe(0)
    const papers = readPapers(movedProducts, 'political_theory')
    // 题干图键 = 迁移后源字节（PNG_STEM_ALT）的 sha256，而非 manifest 登记的旧输入
    expect(imagesOf(findQuestion(papers, '700101')?.stem ?? [])[0]?.path).toBe(`img/${sha256(PNG_STEM_ALT)}.webp`)
    // 二次引用同键（同源文件）
    expect(imagesOf(findQuestion(papers, '700102')?.analysis ?? [])[0]?.path).toBe(
      `img/${sha256(PNG_STEM_ALT)}.webp`,
    )
    const manifest = readImagesManifest(movedProducts)
    expect(manifest.input).toBe(path.resolve(movedInput).replace(/\\/g, '/'))
  })

  it('图片问题（error 产物）→ 1；产物结构无效 → 1', async () => {
    spyConsole()
    expect(await main(['images', '--products', errorProducts])).toBe(1)
    expect(await main(['images', '--products', path.join(outDir, 'empty-products')])).toBe(1)
  })
})
