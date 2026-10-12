import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { IMAGE_KEY_PATTERN } from '@ncse/shared'
import type { AppEnv } from '../types'

/**
 * 题目图片公开代理域路由（T1-08d，挂载于 /api/img，见 src/routes/api.ts）：
 * - GET /api/img/<裸键>：R2 内容寻址对象（ADR-0007）的公开读取，DB 恒存裸键、
 *   practice 域投影的访问 URL 即本端点（键以 img/ 开头 → URL 呈双 img 段）。
 * - 不挂 requireAuth（T1-08 拆片共识⑤）：`<img>` 标签不带 Authorization 头；
 *   公网不可枚举——内容寻址 64hex 键即能力凭证，枚举空间 2^256 不可行。
 * - 其余方法未注册 → 组合根 notFound 404 信封（本文件只注册 GET）。
 */

/** 键形态不符的统一文案（含不存在：对 `<img>` 仅表现为加载失败走 alt，不区分原因防探测） */
const IMAGE_NOT_FOUND_MESSAGE = '图片不存在'

/**
 * 按扩展名推导 Content-Type（webp/gif，从键白名单穷举）。
 * 不依赖对象上传时的 httpMetadata：导入管线 put 未带 metadata 也正确。
 */
function contentTypeForKey(key: string): 'image/webp' | 'image/gif' {
  return key.endsWith('.webp') ? 'image/webp' : 'image/gif'
}

export const imgRoute = new Hono<AppEnv>()

// 根路径通配：承接含斜杠的键路径（img/<hex>.<ext>，URL 形态 /api/img/img/<hex>.<ext>）
imgRoute.get('/*', async (c) => {
  // 键解析取未解码路径的 /api/img/ 后缀（挂载于 /api/img 之下；不自行 decodeURIComponent）。
  // 白名单只容 [0-9a-f/] 与点：保留字符百分号编码（如 ..%2f）保留字面 %、
  // 非保留编码（如 %2e）即便被路径层解码也只解出点号——两类均拼不出白名单外的 R2 键，
  // 穿越与任意键访问天然被 404 拒绝。
  const key = c.req.path.slice('/api/img/'.length)
  if (!IMAGE_KEY_PATTERN.test(key)) {
    throw new HTTPException(404, { message: IMAGE_NOT_FOUND_MESSAGE })
  }

  const object = await c.env.IMAGES.get(key)
  if (object === null) {
    throw new HTTPException(404, { message: IMAGE_NOT_FOUND_MESSAGE })
  }

  // 内容寻址键内容永不变化（同键必同字节）：浏览器/CDN 可永久缓存，无需 ETag/Last-Modified。
  return c.newResponse(object.body, 200, {
    'Content-Type': contentTypeForKey(key),
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
})
