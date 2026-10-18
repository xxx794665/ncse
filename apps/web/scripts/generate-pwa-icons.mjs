#!/usr/bin/env node
/**
 * PWA 图标生成脚本（T1-14，F1-11）：纯 Node 内置模块实现，零新增依赖
 * （任务边界禁止安装 vite-plugin-pwa 以外的依赖，故不引入 sharp/ canvas 等图像库）。
 * 用法：
 *   node apps/web/scripts/generate-pwa-icons.mjs
 * 产物（提交入库，构建不依赖本脚本；改动字形/配色后重跑并提交即可）：
 *   apps/web/public/pwa-192.png / pwa-512.png            —— any 用途（安装列表、快捷方式等）
 *   apps/web/public/pwa-maskable-192.png / pwa-maskable-512.png —— maskable 用途（安卓自适应图标）
 * 设计要点：
 * - 图形：深藏青底（#1E3A8A = tokens.css --color-primary-900，表 A 品牌深色）+ 白色「公」字，
 *   几何笔画（折线 + 圆头圆角），对应设计规范「图标设计从简」的要求。
 * - maskable 安全区：安卓自适应图标可裁为圆形/圆角矩形，安全区为中央 80% 直径圆，
 *   maskable 版字形内边距取 22%（中央 56%），any 版取 14%（字形更大）。
 * - 全幅不透明方形底（无透明区）：苹果 apple-touch-icon 对透明底填黑，安卓各桌面自行套壳，
 *   全幅底是两端的稳妥公共解。
 * - 抗锯齿：4× 超采样二值覆盖 → 盒式滤波降采样（16 级灰度过渡），边缘无锯齿。
 * - PNG 编码：8-bit RGBA、scanline filter 0、zlib deflate（node:zlib），CRC32 自实现。
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(SCRIPT_DIR, '..', 'public')

/** 底色：深藏青（--color-primary-900）；字形：白（--color-text-on-primary） */
const BG_RGB = [0x1e, 0x3a, 0x8a]
const FG_RGB = [0xff, 0xff, 0xff]

/** 超采样倍数（4× → 每像素 4×4=16 子采样，16 级抗锯齿） */
const SS = 4

/**
 * 「公」字笔画集：归一化字形坐标（x/y ∈ [0,1]，y 向下），折线 + 圆头。
 * 四笔：①丿（左上撇）②㇏（右上捺）③厶之撇折 ④厶之点。
 * 数值按通用印刷体骨架人工标定，渲染后人工目检校正。
 */
const STROKES = [
  // 丿：自顶中向左下弯撇（两段折线近似弧线）
  [
    [0.5, 0.05],
    [0.35, 0.16],
    [0.19, 0.32],
  ],
  // ㇏：自顶中偏右向右下捺出
  [
    [0.58, 0.08],
    [0.71, 0.19],
    [0.85, 0.33],
  ],
  // 厶之撇折：自中向下偏左撇，折后向右微上行
  [
    [0.54, 0.42],
    [0.35, 0.7],
    [0.7, 0.65],
  ],
  // 厶之点：右下短点
  [
    [0.6, 0.74],
    [0.74, 0.87],
  ],
]

/** 笔画粗度（占字形盒边长比例）：公为少笔画字，取偏粗以保证小尺寸可辨 */
const STROKE_WIDTH = 0.1

/** 生成清单：any 版字形铺满一些；maskable 版收进安全区 */
const TARGETS = [
  { file: 'pwa-192.png', size: 192, pad: 0.14 },
  { file: 'pwa-512.png', size: 512, pad: 0.14 },
  { file: 'pwa-maskable-192.png', size: 192, pad: 0.22 },
  { file: 'pwa-maskable-512.png', size: 512, pad: 0.22 },
]

/* ===== CRC32（PNG 块校验，自实现避免依赖） ===== */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 组装一个 PNG 块：长度 + 类型 + 数据 + CRC */
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/** RGBA 像素缓冲 → PNG 文件内容（8-bit RGBA、filter 0、deflate） */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // 10/11/12 = compression/filter/interlace 均 0
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter type 0（None）
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * stride + 1,
    )
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 点到线段最短距离（圆头笔画的距离场基础） */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

/**
 * 超采样渲染：SS×SS 子像素二值覆盖（命中笔画=1），盒式滤波降到目标分辨率，
 * 覆盖率在 FG/BG 间线性插值，输出 RGBA。
 * @param {number} size 输出边长（px）
 * @param {number} pad 字形盒内边距（占边长比例）
 */
function renderIcon(size, pad) {
  const hi = size * SS
  // 字形盒（高分辨率坐标系）：pad 内边距内绘制
  const boxOrigin = pad * hi
  const boxSize = (1 - 2 * pad) * hi
  const radius = (STROKE_WIDTH * boxSize) / 2

  // 高分辨率覆盖缓冲（0/1）
  const coverage = new Uint8Array(hi * hi)
  for (const polyline of STROKES) {
    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = boxOrigin + polyline[i][0] * boxSize
      const ay = boxOrigin + polyline[i][1] * boxSize
      const bx = boxOrigin + polyline[i + 1][0] * boxSize
      const by = boxOrigin + polyline[i + 1][1] * boxSize
      // 包围盒裁剪，避免全图扫描
      const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1))
      const maxX = Math.min(hi - 1, Math.ceil(Math.max(ax, bx) + radius + 1))
      const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1))
      const maxY = Math.min(hi - 1, Math.ceil(Math.max(ay, by) + radius + 1))
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (coverage[y * hi + x] === 1) continue
          if (distToSegment(x + 0.5, y + 0.5, ax, ay, bx, by) <= radius) {
            coverage[y * hi + x] = 1
          }
        }
      }
    }
  }

  // 盒式滤波降采样 + 前景/背景插值
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          hits += coverage[(y * SS + sy) * hi + (x * SS + sx)]
        }
      }
      const t = hits / (SS * SS) // 覆盖率 0..1
      const o = (y * size + x) * 4
      rgba[o] = Math.round(BG_RGB[0] + (FG_RGB[0] - BG_RGB[0]) * t)
      rgba[o + 1] = Math.round(BG_RGB[1] + (FG_RGB[1] - BG_RGB[1]) * t)
      rgba[o + 2] = Math.round(BG_RGB[2] + (FG_RGB[2] - BG_RGB[2]) * t)
      rgba[o + 3] = 255 // 全幅不透明
    }
  }
  return rgba
}

mkdirSync(OUT_DIR, { recursive: true })
for (const { file, size, pad } of TARGETS) {
  const rgba = renderIcon(size, pad)
  const png = encodePng(size, size, rgba)
  writeFileSync(join(OUT_DIR, file), png)
  console.log(`[pwa-icons] ${file}：${size}x${size}，${(png.length / 1024).toFixed(1)} KB`)
}
console.log(`[pwa-icons] 完成，输出目录 ${OUT_DIR}`)
