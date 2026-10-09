/**
 * 卷名/头信息元数据提取（尽力而为，提取不出置 null，原文保留在 meta/name）。
 * 提取规则（确定性，按序匹配）：
 * - year：frontmatter 年份的 4 位数字 → 卷名中的 'NNNN年' → null；
 * - region：frontmatter 地区非空原值（如 '四川'、'国考'）→ null；
 * - paperType：卷名含 '国家公务员' → '国考'；含 '联考' → '联考'；含 '选调' → '选调'；
 *   含 '公务员录用考试/公务员考试' → '省考'；都不中 → null。
 *   （卷型归一服务于考试蓝图挂靠；未覆盖的卷型由后续任务按需扩规则。）
 */

/** 提取年份（null = 提取不出） */
export function extractYear(meta: Record<string, string>, title: string): number | null {
  const raw = meta['年份']
  if (raw !== undefined) {
    const match = /^(\d{4})/.exec(raw.trim())
    if (match !== null) return Number(match[1])
  }
  const inTitle = /(\d{4})年/.exec(title)
  return inTitle !== null ? Number(inTitle[1]) : null
}

/** 提取地区（frontmatter 地区原值；null = 提取不出） */
export function extractRegion(meta: Record<string, string>): string | null {
  const raw = meta['地区']
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed !== '' ? trimmed : null
}

/** 提取卷型（规则匹配；null = 提取不出） */
export function extractPaperType(title: string): string | null {
  if (title.includes('国家公务员')) return '国考'
  if (title.includes('联考')) return '联考'
  if (title.includes('选调')) return '选调'
  if (/公务员录用考试|公务员考试/.test(title)) return '省考'
  return null
}
