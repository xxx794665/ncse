/**
 * 内联 HTML → 富片段（RichSegment[]）。
 * 语法见 grammar.ts：行内只出现 <p>/<img>/<u>/<br> 与少量实体；
 * 本解析器为手写行级实现（不引入 Markdown AST 依赖）。
 */
import type { RichContent, RichSegment } from '@ncse/shared'
import { ANY_TAG, EDGE_WHITESPACE, IMG_ALT_ATTR, IMG_SRC_ATTR, PARAGRAPH_TAG } from './grammar.js'

/** HTML 实体表（抽样观测 &lt; &gt；其余按 HTML 规范防御性支持） */
const ENTITY_MAP: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
}

/**
 * 解码 HTML 实体。&amp; 必须最后解码：'&amp;lt;' 应得 '&lt;' 字面量而非 '<'。
 */
function decodeEntities(text: string): string {
  const firstPass = text.replace(
    /&(?:lt|gt|quot|apos|nbsp);/g,
    (entity) => ENTITY_MAP[entity.slice(1, -1)] ?? entity,
  )
  return firstPass.replace(/&amp;/g, '&')
}

/** 修剪段边缘空白（含全角空格与 NBSP；段内空白保留） */
function trimEdges(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && EDGE_WHITESPACE.test(text.charAt(start))) start++
  while (end > start && EDGE_WHITESPACE.test(text.charAt(end - 1))) end--
  return text.slice(start, end)
}

/**
 * 解析一行为富片段序列。
 * - <p>/<br>（开或闭）为文本段边界：先冲刷缓冲中的文本段；
 * - <img …> 冲刷文本段后产出图片段（path 保留源相对路径原样，alt 可选）；
 * - 其他标签（<u></u> 等）剥壳保留内容；
 * - 实体解码后、边缘修剪后为空的文本段直接丢弃。
 * 一行无任何标签时退化为「整行一个文本段」。
 */
export function parseRichLine(line: string): RichSegment[] {
  const segments: RichSegment[] = []
  let buffer = ''
  let cursor = 0

  const flush = (): void => {
    const text = trimEdges(decodeEntities(buffer))
    if (text !== '') segments.push({ type: 'text', text })
    buffer = ''
  }

  ANY_TAG.lastIndex = 0
  let match = ANY_TAG.exec(line)
  while (match !== null) {
    const tag = match[0]
    buffer += line.slice(cursor, match.index)
    cursor = match.index + tag.length
    if (/^<img\b/i.test(tag)) {
      flush()
      const src = IMG_SRC_ATTR.exec(tag)
      if (src !== null) {
        const path = src[1] ?? src[2] ?? ''
        const alt = IMG_ALT_ATTR.exec(tag)
        const image: RichSegment =
          alt !== null ? { type: 'image', path, alt: alt[1] ?? alt[2] ?? '' } : { type: 'image', path }
        segments.push(image)
      }
      // 无 src 的 <img>（抽样不存在）：跳过该标签不产出片段
    } else if (PARAGRAPH_TAG.test(tag)) {
      flush()
    }
    // 其他标签：剥壳，内容已在 buffer 中继续累积
    match = ANY_TAG.exec(line)
  }
  buffer += line.slice(cursor)
  flush()
  return segments
}

/** 多行内容 → 富片段（每行独立解析后顺序拼接；空行自然产出空段被丢弃） */
export function parseRichLines(lines: readonly string[]): RichContent {
  return lines.flatMap((line) => parseRichLine(line))
}
