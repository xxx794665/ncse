/**
 * R2 上传器测试（T1-05 阶段 B）：uploadArtifacts 与 runImagesStage/--bucket 编排、CLI 用法。
 * 全部经 R2PutRunner 注入替身（记录调用、模拟延迟与可控失败），不真调 wrangler、不 spawn 进程；
 * 夹具为手工构造的已键产物（keyed 段 + r2/ 工件齐备，阶段 A 为 no-op）与纯文本产物
 * （无 r2/，无图可传的合法状态），不含真实题库（ADR-0004）；产物写入系统临时目录，测试后清理。
 * 断言要点：调用参数序列（bucket/key、--file 指向 r2 工件、--content-type、--local 传递）、
 * 调用顺序 = key 排序序、并发池上限、失败按输入序聚合、images-manifest 落盘判定
 * （上传成功且无其他变更不写文件、上传失败记 issue）、CLI 用法错误退出码 2。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { runImagesStage } from '../src/image-stage.js'
import { main } from '../src/main.js'
import { resolveWithin } from '../src/pipeline.js'
import { ensureWranglerJs, isSafePutArgs, MissingWranglerError, uploadArtifacts } from '../src/r2-upload.js'
import type { R2PutRunner } from '../src/types.js'

/* ============ 夹具生成（模块加载即建：describe 体引用产物路径） ============ */

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncse-importer-upload-'))
/** 输入根（已键产物不再读源文件，空目录即可满足 input 校验） */
const inputSrc = path.join(outDir, 'input-src')
/** 已键产物：图片段全部为内容寻址键且 r2/ 工件齐备（阶段 A no-op）；6 个工件（3 个被段引用） */
const keyedProducts = path.join(outDir, 'keyed-products')
/** 纯文本产物：无图片段、无 r2/（无图可传的合法状态） */
const textProducts = path.join(outDir, 'text-products')

fs.mkdirSync(inputSrc, { recursive: true })
fs.mkdirSync(path.join(keyedProducts, 'modules'), { recursive: true })
fs.mkdirSync(path.join(textProducts, 'modules'), { recursive: true })

/** 64 位十六进制串（内容寻址键形态；'a'*64 < 'b'*64 < … 排序确定） */
const hex = (char: string): string => char.repeat(64)
const KEY_A = `img/${hex('a')}.webp`
const KEY_B = `img/${hex('b')}.gif`
/** 未被任何段引用的工件（上传口径 = r2/ 全部文件，与段引用无关） */
const KEY_C = `img/${hex('c')}.webp`
const KEY_D = `img/${hex('d')}.webp`
const KEY_E = `img/${hex('e')}.webp`
const KEY_F = `img/${hex('f')}.webp`
const ALL_KEYS = [KEY_A, KEY_B, KEY_C, KEY_D, KEY_E, KEY_F] // 已按排序序

/** 向目录写文件（POSIX 相对路径；resolveWithin 界内校验——与源码同一防线） */
function writeFile(root: string, rel: string, content: string): void {
  const target = resolveWithin(root, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

const manifestText = `${JSON.stringify(
  { version: 'v-up', input: path.resolve(inputSrc).replace(/\\/g, '/'), moduleOrder: ['political_theory'] },
  null,
  2,
)}\n`

/** 手工构造模块产物（题干/选项 A/解析可注入：已键形态的图片段或纯文本段；结构满足 image-stage 校验） */
function moduleJson(stem: unknown, optionAContent: unknown, analysis: unknown): string {
  return `${JSON.stringify(
    {
      module: 'political_theory',
      papers: [
        {
          file: '01-政治理论/虚构上传卷.md',
          name: '虚构上传卷',
          year: 2024,
          region: '虚构省',
          paperType: null,
          module: 'political_theory',
          meta: {},
          items: [
            {
              qid: '710001',
              kind: 'single_choice',
              stem,
              options: [
                { key: 'A', content: optionAContent },
                { key: 'B', content: [{ type: 'text', text: '文本选项' }] },
              ],
              answer: 'A',
              analysis,
              visionText: '',
              groupIndex: null,
            },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`
}

writeFile(keyedProducts, 'import-manifest.json', manifestText)
writeFile(
  keyedProducts,
  'modules/political_theory.json',
  moduleJson(
    [{ type: 'image', path: KEY_A, alt: '虚构甲图' }],
    [{ type: 'image', path: KEY_B }],
    [{ type: 'image', path: KEY_A }],
  ),
)
for (const key of ALL_KEYS) {
  writeFile(keyedProducts, `r2/${key}`, `artifact-${key.slice(4, 8)}`)
}

writeFile(textProducts, 'import-manifest.json', manifestText)
writeFile(
  textProducts,
  'modules/political_theory.json',
  moduleJson(
    [{ type: 'text', text: '纯文本题干。' }],
    [{ type: 'text', text: '文本选项甲' }],
    [{ type: 'text', text: '纯文本解析。' }],
  ),
)

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/* ============ fake 执行器（记录调用、模拟延迟与可控失败；不触发真 spawn） ============ */

interface FakeExec {
  runPut: R2PutRunner
  /** 已发生的调用（args 快照；追加序 = 调用发起序） */
  calls: string[][]
  /** 每次调用的 cwd 快照（与 calls 同序；应恒为 r2 工件根） */
  cwds: string[]
  /** 观测到的最大在飞（并发中）调用数 */
  maxInflight: () => number
}

/** 造 fake 执行器：成功调用延迟 delayMs（制造并发重叠），fail 命中的调用立即失败返回给定退出码 */
function createFakeExec(options: { delayMs?: number; fail?: (args: string[]) => number | undefined } = {}): FakeExec {
  const calls: string[][] = []
  const cwds: string[] = []
  let inflight = 0
  let peak = 0
  const runPut: R2PutRunner = async (args, cwd) => {
    calls.push(args)
    cwds.push(cwd)
    inflight++
    peak = Math.max(peak, inflight)
    const failCode = options.fail?.(args)
    try {
      if (failCode === undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 5))
      }
    } finally {
      inflight--
    }
    return failCode === undefined
      ? { code: 0, stderr: '' }
      : { code: failCode, stderr: `fake 上传失败：${args[3]}` }
  }
  return { runPut, calls, cwds, maxInflight: () => peak }
}

function readImagesManifest(productsRoot: string): {
  stats: Record<string, number>
  issues: Array<{ severity: string; code: string; file: string; qid: string | null; message: string }>
} {
  return JSON.parse(fs.readFileSync(path.join(productsRoot, 'images-manifest.json'), 'utf8'))
}

/* ============ uploadArtifacts：调用参数、顺序与并发 ============ */

describe('uploadArtifacts：调用参数与顺序（替身注入）', () => {
  it('参数序列：r2 object put <bucket>/<key> --file <对象键> --content-type 按 扩展名、--local 传递；调用顺序 = key 排序序', async () => {
    const fake = createFakeExec()
    const result = await uploadArtifacts(
      { productsDir: keyedProducts, bucket: 'bkt', local: true },
      fake.runPut,
    )
    expect(result).toEqual({ uploaded: 6, failed: 0, keys: ALL_KEYS, issues: [] })
    expect(fake.calls).toHaveLength(6)
    // 调用发起序 = 键排序序（worker 池顺序取键，输入序即调用序）
    expect(fake.calls.map((args) => args[3])).toEqual(ALL_KEYS.map((key) => `bkt/${key}`))
    // cwd 恒为 r2 工件根（--file 相对键由此解析，绝对路径不进 argv）
    expect(fake.cwds.every((cwd) => cwd === path.join(keyedProducts, 'r2'))).toBe(true)
    // webp 键的完整参数（--file 为对象键、--content-type image/webp、尾部 --local）
    expect(fake.calls[0]).toEqual([
      'r2',
      'object',
      'put',
      `bkt/${KEY_A}`,
      '--file',
      KEY_A,
      '--content-type',
      'image/webp',
      '--local',
    ])
    // gif 键：image/gif
    expect(fake.calls[1]).toEqual([
      'r2',
      'object',
      'put',
      `bkt/${KEY_B}`,
      '--file',
      KEY_B,
      '--content-type',
      'image/gif',
      '--local',
    ])
  })

  it('无 --local → 不带 --local 旗标；未知扩展工件 → application/octet-stream 兜底', async () => {
    const mixed = path.join(outDir, 'mixed-products')
    fs.cpSync(keyedProducts, mixed, { recursive: true })
    writeFile(mixed, 'r2/other.bin', 'octet-stream-payload')
    const fake = createFakeExec()
    const result = await uploadArtifacts({ productsDir: mixed, bucket: 'bkt' }, fake.runPut)
    expect(result.uploaded).toBe(7)
    expect(result.keys).toEqual([...ALL_KEYS, 'other.bin'])
    for (const call of fake.calls) {
      expect(call).not.toContain('--local')
    }
    const octet = fake.calls.find((call) => call[3] === 'bkt/other.bin')
    expect(octet?.[octet?.indexOf('--content-type') + 1]).toBe('application/octet-stream')
    expect(octet?.[octet?.indexOf('--file') + 1]).toBe('other.bin')
  })

  it('并发池：默认 4（6 键 → 峰值在飞恰为 4）；concurrency 2 → 峰值恰为 2（上限被遵守）', async () => {
    const defaultPool = createFakeExec()
    await uploadArtifacts({ productsDir: keyedProducts, bucket: 'bkt', local: true }, defaultPool.runPut)
    expect(defaultPool.maxInflight()).toBe(4)
    expect(defaultPool.calls).toHaveLength(6)

    const serial = createFakeExec()
    await uploadArtifacts(
      { productsDir: keyedProducts, bucket: 'bkt', local: true, concurrency: 2 },
      serial.runPut,
    )
    expect(serial.maxInflight()).toBe(2)
    expect(serial.calls).toHaveLength(6)
  })

  it('失败聚合：指定键退出码非 0 → r2_upload_failed 按输入序（失败先完成也不打乱）、消息含键/退出码/stderr', async () => {
    // 键序第 3（index 2）退出码 1、第 5（index 4）退出码 2；失败立即返回、成功延迟 5ms
    // → 完成序与输入序相反，聚合仍须按输入序
    const failOf = (args: string[]): number | undefined => {
      if (args[3] === `bkt/${KEY_C}`) return 1
      if (args[3] === `bkt/${KEY_E}`) return 2
      return undefined
    }
    const fake = createFakeExec({ fail: failOf })
    const result = await uploadArtifacts({ productsDir: keyedProducts, bucket: 'bkt', local: true }, fake.runPut)
    expect(result.uploaded).toBe(4)
    expect(result.failed).toBe(2)
    expect(result.issues).toHaveLength(2)
    const [first, second] = result.issues
    expect(first).toMatchObject({ severity: 'error', code: 'r2_upload_failed', file: KEY_C, qid: null })
    expect(first.message).toContain(KEY_C)
    expect(first.message).toContain('退出码 1')
    expect(first.message).toContain(`fake 上传失败：bkt/${KEY_C}`)
    expect(second).toMatchObject({ severity: 'error', code: 'r2_upload_failed', file: KEY_E, qid: null })
    expect(second.message).toContain('退出码 2')
  })

  it('r2/ 目录不存在 → uploaded 0、keys 空、issues 空（无图可传是合法状态，非错误）', async () => {
    const fake = createFakeExec()
    const result = await uploadArtifacts({ productsDir: textProducts, bucket: 'bkt', local: true }, fake.runPut)
    expect(result).toEqual({ uploaded: 0, failed: 0, keys: [], issues: [] })
    expect(fake.calls).toHaveLength(0)
  })

  it('隐藏条目排除：r2/ 下点开头的文件与目录（wrangler --local 本地态落 cwd）不计入工件键', async () => {
    const stashed = path.join(outDir, 'stashed-products')
    fs.cpSync(keyedProducts, stashed, { recursive: true })
    // 模拟 wrangler --local 在 cwd（= r2 工件根）下写出的本地态
    writeFile(stashed, 'r2/.wrangler/state/v3/r2/ncse-bkt/blobs/abc', 'local-state-blob')
    writeFile(stashed, 'r2/.DS_Store', 'junk')
    const fake = createFakeExec()
    const result = await uploadArtifacts({ productsDir: stashed, bucket: 'bkt', local: true }, fake.runPut)
    expect(result.keys).toEqual(ALL_KEYS) // 隐藏条目不进键集
    expect(fake.calls).toHaveLength(6)
  })

  it('wranglerJs 校验：不可达路径 → MissingWranglerError（消息含 npm install 修复指引）；src 深度解析的仓库根路径真实存在', () => {
    const missing = path.join(outDir, 'no-such-dir', 'wrangler.js')
    expect(() => ensureWranglerJs(missing)).toThrow(MissingWranglerError)
    expect(() => ensureWranglerJs(missing)).toThrow(/npm install/)
    // 与 r2-upload.ts 同深度的解析（test/ 亦为 tools/importer 下一级）：仓库根 wrangler.js 真实在位
    const wranglerJs = fileURLToPath(new URL('../../../node_modules/wrangler/bin/wrangler.js', import.meta.url))
    expect(fs.existsSync(wranglerJs)).toBe(true)
    expect(() => ensureWranglerJs(wranglerJs)).not.toThrow()
  })

  it('spawn 汇点结构复检 isSafePutArgs：合法形态（含/不含 --local、gif/octet mime）通过；旗标伪装/错位/超长/多余参数拒绝', () => {
    const put = (target: string, file: string, mime: string, ...tail: string[]): string[] => [
      'r2',
      'object',
      'put',
      target,
      '--file',
      file,
      '--content-type',
      mime,
      ...tail,
    ]
    const key = `img/${hex('a')}.webp`
    expect(isSafePutArgs(put(`bkt/${key}`, key, 'image/webp'))).toBe(true)
    expect(isSafePutArgs(put('bkt/img/b.gif', 'img/b.gif', 'image/gif', '--local'))).toBe(true)
    expect(isSafePutArgs(put('bkt/other.bin', 'other.bin', 'application/octet-stream'))).toBe(true)
    // 桶名/键旗标伪装（首字符 '-'）拒绝
    expect(isSafePutArgs(put('-flag/img/a.webp', 'img/a.webp', 'image/webp'))).toBe(false)
    expect(isSafePutArgs(put('bkt/--remote', '--remote', 'image/webp'))).toBe(false)
    // 形态错位/越界拒绝
    expect(isSafePutArgs(put('Bkt/img/a.webp', 'img/a.webp', 'image/webp'))).toBe(false)
    expect(isSafePutArgs(put('bkt/img/a.webp', 'img/a.webp', 'text/html'))).toBe(false)
    expect(isSafePutArgs(put('bkt/img/a.webp', 'img/a.webp', 'image/webp', '--remote'))).toBe(false)
    expect(isSafePutArgs(['r2', 'object', 'put'])).toBe(false)
  })
})

/* ============ runImagesStage + --bucket：阶段 B 编排 ============ */

describe('runImagesStage + --bucket（阶段 B 编排）', () => {
  it('上传成功且无其他变更 → 纯 no-op：不写文件、images-manifest 字节不变；upload 切片正确', async () => {
    // 首跑（无 bucket）：产物无变更但因 manifest 不存在而落盘 → 作为字节基准
    const first = await runImagesStage({ productsDir: keyedProducts })
    expect(first.hardErrors).toBe(0)
    const manifestPath = path.join(keyedProducts, 'images-manifest.json')
    const before = fs.readFileSync(manifestPath)
    const beforeStat = fs.statSync(manifestPath)

    const fake = createFakeExec()
    const second = await runImagesStage({
      productsDir: keyedProducts,
      bucket: 'bkt',
      local: true,
      runPut: fake.runPut,
    })
    expect(fake.calls).toHaveLength(6)
    expect(second.stats).toEqual({
      references: 3,
      images: 0,
      compressed: 0,
      passthrough: 0,
      alreadyKeyed: 3,
      errors: 0,
      warnings: 0,
    })
    expect(second.upload).toEqual({ uploaded: 6, failed: 0 })
    expect(second.hardErrors).toBe(0)
    // 上传成功不产生本地文件写：manifest 字节与 mtime 均不变
    expect(second.wrote).toEqual([])
    expect(fs.readFileSync(manifestPath).equals(before)).toBe(true)
    expect(fs.statSync(manifestPath).mtimeMs).toBe(beforeStat.mtimeMs)
  })

  it('上传失败 → issue 并入总清单、hardErrors 计入、images-manifest 落盘记录该 issue；其余对象继续上传', async () => {
    const failing = path.join(outDir, 'failing-products')
    fs.cpSync(keyedProducts, failing, { recursive: true })
    const fake = createFakeExec({ fail: (args) => (args[3] === `bkt/${KEY_D}` ? 1 : undefined) })
    const result = await runImagesStage({ productsDir: failing, bucket: 'bkt', runPut: fake.runPut })
    expect(fake.calls).toHaveLength(6) // 失败不中断其余上传
    expect(result.upload).toEqual({ uploaded: 5, failed: 1 })
    expect(result.hardErrors).toBe(1)
    expect(result.stats.errors).toBe(1)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ severity: 'error', code: 'r2_upload_failed', file: KEY_D })
    // 失败计入 issues → dirty → images-manifest 写盘并记录该 issue
    const manifest = readImagesManifest(failing)
    expect(manifest.issues).toHaveLength(1)
    expect(manifest.issues[0]).toMatchObject({ code: 'r2_upload_failed', file: KEY_D })
    expect(manifest.stats.errors).toBe(1)
  })
})

/* ============ CLI images 子命令（上传用法；不触发真 spawn——无 r2 工件可传） ============ */

describe('CLI images 子命令（--bucket/--local/--concurrency）', () => {
  const spyConsole = (): string[][] => {
    const logs: string[][] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((entry) => String(entry)))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    return logs
  }

  it('用法错误 → 2（--local/--concurrency 无 --bucket、--concurrency 1/99/abc、--bucket 空串）', async () => {
    spyConsole()
    expect(await main(['images', '--products', textProducts, '--local'])).toBe(2)
    expect(await main(['images', '--products', textProducts, '--concurrency', '4'])).toBe(2)
    expect(await main(['images', '--products', textProducts, '--bucket', 'bkt', '--concurrency', '1'])).toBe(2)
    expect(await main(['images', '--products', textProducts, '--bucket', 'bkt', '--concurrency', '99'])).toBe(2)
    expect(await main(['images', '--products', textProducts, '--bucket', 'bkt', '--concurrency', 'abc'])).toBe(2)
    expect(await main(['images', '--products', textProducts, '--bucket', ''])).toBe(2)
    // 桶名白名单（R2 命名规则）：大写/旗标伪装/过短/非法字符 → 2（参数注入防线）
    expect(await main(['images', '--products', textProducts, '--bucket', 'Bkt'])).toBe(2)
    expect(await main(['images', '--products', textProducts, '--bucket', '-flag'])).toBe(2)
    expect(await main(['images', '--products', textProducts, '--bucket', 'bk'])).toBe(2)
    expect(await main(['images', '--products', textProducts, '--bucket', 'bkt_name'])).toBe(2)
    // 边界合法值：2 与 16 均可用（text 产物无 r2/ → 无上传调用 → 退出 0）
    expect(await main(['images', '--products', textProducts, '--bucket', 'bkt', '--concurrency', '2'])).toBe(0)
    expect(await main(['images', '--products', textProducts, '--bucket', 'bkt', '--concurrency', '16'])).toBe(0)
  })

  it('r2/ 不存在 + --bucket → uploaded 0、退出 0；汇总行含 R2 上传与 bucket/local 标注', async () => {
    const logs = spyConsole()
    expect(await main(['images', '--products', textProducts, '--bucket', 'bkt', '--local'])).toBe(0)
    expect(logs.some((call) => call.join(' ').includes('R2 上传：成功 0，失败 0（bucket bkt，local）'))).toBe(true)
    // 无 local → 汇总行不含 local 标注
    expect(await main(['images', '--products', textProducts, '--bucket', 'bkt'])).toBe(0)
    const uploadLines = logs.filter((call) => call.join(' ').includes('R2 上传'))
    expect(uploadLines.some((call) => call.join(' ').includes('（bucket bkt）'))).toBe(true)
  })
})
