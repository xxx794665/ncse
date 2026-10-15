import type { RichContent } from '@ncse/shared'

/**
 * 题干预览生成（T1-10a，错题本/难点本列表与收藏列表共用，勿在路由内复制两份）：
 * stem RichContent 的 text 段以空格连接；超过截断长度截断加「…」；
 * 无 text 段（纯图题）返回占位文案。纯函数（供测试直接导入断言规则）。
 */

/** 预览截断长度（保留前缀字符数，截断后追加「…」；列表展示宽度实测选值） */
export const STEM_PREVIEW_MAX_LENGTH = 80

/** 纯图题（stem 无 text 段）的占位预览 */
export const IMAGE_ONLY_PREVIEW = '（图片题）'

/** stem 富片段 → 预览文本：text 段空格连接（图片段不参与预览），空则纯图题占位 */
export function buildStemPreview(stem: RichContent): string {
  const textParts: string[] = []
  for (const segment of stem) {
    if (segment.type === 'text') {
      textParts.push(segment.text)
    }
  }
  const text = textParts.join(' ')
  if (text.length === 0) {
    return IMAGE_ONLY_PREVIEW
  }
  return text.length > STEM_PREVIEW_MAX_LENGTH ? `${text.slice(0, STEM_PREVIEW_MAX_LENGTH)}…` : text
}
