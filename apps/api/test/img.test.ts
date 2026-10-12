import { beforeEach, describe, expect, it } from 'vitest'
import { env, exports } from 'cloudflare:workers'
import type { RichContent, RichSegment } from '@ncse/shared'
import { examTypes, users } from '../src/db/schema'
import {
  bearerGet,
  bearerPost,
  errorField,
  numberField,
  ORIGIN,
  questionList,
  registerForToken,
  requestJson,
} from './api-helpers'
import { db, fakeImageKey, insertContentFixture, type ContentFixture } from './practice-fixtures'

/**
 * 题目图片公开端点集成测试（T1-08d）：经 worker 入口走真实 fetch（含路由挂载、
 * onError 错误信封），R2 为 workerd 内的本地模拟实例。图片响应为二进制——
 * 直插对象经 env.IMAGES.put（与被测路由同一 R2 绑定），断言不经 requestJson。
 * 内容夹具复用 practice-fixtures（political 第 1 题图片段键即 fakeImageKey(0)）；
 * R2 对象跨用例保留无害（键内容寻址、同键同字节幂等覆盖），无需清理。
 */

/** 真实 worker 入口（src/index.ts 组合根；测试不直接调内部路由） */
const worker = exports.default

/** webp 键：与内容夹具 political 第 1 题同键（直接命中与端到端闭环共用） */
const webpKey = fakeImageKey(0)
/** gif 键（测试虚构 64hex） */
const gifKey = `img/${'ab'.repeat(32)}.gif`
/** 合法形态但从未 put 的键（404 用例） */
const missingKey = `img/${'cd'.repeat(32)}.webp`

/** 测试虚构字节（'RIFF…WEBP'/'GIF89a' 头部片段）：端点只透传字节，不校验图片真伪 */
const webpBytes = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50)
const gifBytes = Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00)

/** 读二进制响应体为普通数组（小字节数组可直接 toEqual 比对） */
async function bodyBytes(response: Response): Promise<number[]> {
  return Array.from(new Uint8Array(await response.arrayBuffer()))
}

let content: ContentFixture

beforeEach(async () => {
  // 清库与内容夹具重建（与 practice 域测试同构）；R2 不清理（见文件头注释）
  await db.delete(users)
  await db.delete(examTypes)
  content = await insertContentFixture()
})

describe('GET /api/img/<键>（命中）', () => {
  it('webp 键 200：Content-Type image/webp、永久缓存头、body 字节与 put 一致', async () => {
    await env.IMAGES.put(webpKey, webpBytes)

    const response = await worker.fetch(new Request(`${ORIGIN}/api/img/${webpKey}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/webp')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(await bodyBytes(response)).toEqual(Array.from(webpBytes))
  })

  it('gif 键 200：Content-Type image/gif（键白名单两扩展名穷举的另一支）', async () => {
    await env.IMAGES.put(gifKey, gifBytes)

    const response = await worker.fetch(new Request(`${ORIGIN}/api/img/${gifKey}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/gif')
    expect(await bodyBytes(response)).toEqual(Array.from(gifBytes))
  })

  it('put 时带错误 httpMetadata contentType：仍按扩展名给正确 Content-Type（不依赖上传元数据）', async () => {
    const key = `img/${'ef'.repeat(32)}.webp`
    await env.IMAGES.put(key, webpBytes, { httpMetadata: { contentType: 'application/octet-stream' } })

    const response = await worker.fetch(new Request(`${ORIGIN}/api/img/${key}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/webp')
  })

  it('键形态合法但对象不存在：404 not_found 错误信封', async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/api/img/${missingKey}`))

    expect(response.status).toBe(404)
    const body = (await response.json()) as Record<string, unknown>
    const error = errorField(body)
    expect(error.code).toBe('not_found')
    expect(error.message).toBe('图片不存在')
  })
})

describe('GET /api/img/<非法键>（白名单与穿越拒绝）', () => {
  it.each([
    { case: '短 hex', key: 'img/abc.webp' },
    { case: '非 hex 字符', key: `img/${'g'.repeat(64)}.webp` },
    { case: '错误扩展名', key: `img/${'01'.repeat(32)}.png` },
    { case: '源相对路径历史形态', key: 'attachments/figure.png' },
    { case: '穿越 ..%2f', key: '..%2f' },
    { case: '穿越 %2e%2e/x', key: '%2e%2e/x' },
    { case: '穿越 img/../../x', key: 'img/../../x' },
  ])('非法键形态（$case）：404 + not_found', async ({ key }) => {
    // 穿越形态或不匹配通配路由（URL 层归一化后脱离 /api/img）或被键白名单拒绝，恒 404
    const response = await worker.fetch(new Request(`${ORIGIN}/api/img/${key}`))

    expect(response.status).toBe(404)
    const body = (await response.json()) as Record<string, unknown>
    expect(errorField(body).code).toBe('not_found')
  })
})

describe('GET /api/img（公开访问与方法限制）', () => {
  it('无 Authorization 头 200（公开端点，带 token 与不带均可访问）', async () => {
    await env.IMAGES.put(webpKey, webpBytes)
    const token = await registerForToken('alice')

    const anonymous = await worker.fetch(new Request(`${ORIGIN}/api/img/${webpKey}`))
    expect(anonymous.status).toBe(200)
    expect(await bodyBytes(anonymous)).toEqual(Array.from(webpBytes))

    const withToken = await worker.fetch(new Request(`${ORIGIN}/api/img/${webpKey}`, bearerGet(token)))
    expect(withToken.status).toBe(200)
    expect(await bodyBytes(withToken)).toEqual(Array.from(webpBytes))
  })

  it('POST /api/img/<合法键>：404 not_found（未注册方法走组合根 notFound 信封）', async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/api/img/${webpKey}`, { method: 'POST' }))

    expect(response.status).toBe(404)
    const body = (await response.json()) as Record<string, unknown>
    expect(errorField(body).code).toBe('not_found')
  })
})

describe('端到端闭环（practice 投影 URL ↔ img 端点键解析）', () => {
  it('会话详情图片段投影 path 直接可达：200 且字节与 put 一致（双 img 段路径真实）', async () => {
    await env.IMAGES.put(webpKey, webpBytes)
    const token = await registerForToken('alice')

    // count=30 > 模块 12 题：会话收全量 political 题目，第 1 题必在内（随机抽题不受影响）
    const created = await requestJson('/api/practice/sessions', bearerPost(token, { module: 'political_theory', count: 30 }))
    expect(created.status).toBe(201)
    expect(numberField(created.body, 'total')).toBe(12)

    const detail = await requestJson(`/api/practice/sessions/${numberField(created.body, 'id')}`, bearerGet(token))
    expect(detail.status).toBe(200)

    const keyed = questionList(detail.body).find((question) => numberField(question, 'id') === content.politicalQuestionIds[0])
    if (keyed === undefined) {
      throw new Error('political 第 1 题不在会话内')
    }
    const stem = keyed.stem as RichContent
    const imageSegment = stem[1] as Extract<RichSegment, { type: 'image' }>
    // 投影 URL = origin + /api/img/ + 裸键（键以 img/ 开头 → 双 img 段），前端 <img> 直渲染
    expect(imageSegment.path).toBe(`${ORIGIN}/api/img/${webpKey}`)

    const response = await worker.fetch(new Request(imageSegment.path))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/webp')
    expect(await bodyBytes(response)).toEqual(Array.from(webpBytes))
  })
})
