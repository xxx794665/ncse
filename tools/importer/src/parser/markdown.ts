/**
 * 试卷 Markdown 解析器（行级状态机，语法见同目录 grammar.ts）。
 * 职责：一篇 .md → ParsedPaper + 该文件内的问题清单条目；
 * 不做跨文件去重与统计（见 pipeline.ts），不抛异常（问题全部落 ImportIssue）。
 */
import type { ImportIssue, ModuleCode, ParsedGroup, ParsedPaper, ParsedQuestion } from '../types.js'
import { parseRichLines } from './html.js'
import {
  ANALYSIS_HEADER_LINE,
  ANSWER_CHECKMARK,
  ANSWER_LINE,
  ANY_H2_H3_HEADING,
  FRONTMATTER_LINE,
  FRONTMATTER_SCAN_LIMIT,
  H1_LINE,
  MATERIAL_HEADING,
  OPTION_LINE,
  QID_SUB_TAG,
  QUESTION_HEADING_H2,
  QUESTION_HEADING_H3,
  SEPARATOR_LINE,
} from './grammar.js'
import { extractPaperType, extractRegion, extractYear } from './metadata.js'

/** 解析上下文 */
export interface ParseContext {
  /** 相对输入目录的文件路径（POSIX 分隔；问题清单定位用） */
  file: string
  module: ModuleCode
}

/** 单文件解析结果：paper 为 null 表示整卷被跳过（问题已入 issues） */
export interface ParseResult {
  paper: ParsedPaper | null
  issues: ImportIssue[]
}

/** 区块（按标题切分后的中间形态） */
type Section =
  | { kind: 'material'; index: number; body: string[] }
  | { kind: 'question'; level: 2 | 3; no: number; qid: string | null; tag: string; body: string[] }
  | { kind: 'unknown'; heading: string; body: string[] }

/** 选项行的中间形态 */
interface RawOption {
  key: string
  content: string
  marked: boolean
}

/** 题区块体的中间形态 */
interface RawQuestion {
  qid: string | null
  tag: string
  no: number
  stemLines: string[]
  options: RawOption[]
  answer: string | null
  analysisLines: string[]
}

/** 去掉区块体首尾的空行与水平线（区块间分隔符不属于内容） */
function trimSectionBody(body: string[]): string[] {
  let start = 0
  let end = body.length
  while (start < end && (body[start].trim() === '' || SEPARATOR_LINE.test(body[start]))) start++
  while (end > start && (body[end - 1].trim() === '' || SEPARATOR_LINE.test(body[end - 1]))) end--
  return body.slice(start, end)
}

/** 从题目标题后缀提取 qid 与小类标签（无 <sub>qid…</sub> 时返回 null） */
function parseQidTag(suffix: string): { qid: string; tag: string } | null {
  const match = QID_SUB_TAG.exec(suffix)
  if (match === null) return null
  return { qid: match[1], tag: (match[2] ?? '').trim() }
}

/**
 * 解析一篇试卷 Markdown。
 * 文件级容错策略：头信息/H1 缺失降级（warning）；未识别标题的区块丢弃（warning）；
 * 单题结构问题记录后继续其余题（qid 缺失的题因无自然键被丢弃，error）。
 */
export function parsePaper(source: string, ctx: ParseContext): ParseResult {
  const issues: ImportIssue[] = []
  const src = source.startsWith('\uFEFF') ? source.slice(1) : source
  const lines = src.split(/\r?\n/)

  // ---- 头信息（YAML 围栏）----
  const meta: Record<string, string> = {}
  let cursor = 0
  if (SEPARATOR_LINE.test(lines[0] ?? '')) {
    let fenceEnd = -1
    const scanLimit = Math.min(lines.length, FRONTMATTER_SCAN_LIMIT)
    for (let i = 1; i < scanLimit; i++) {
      if (SEPARATOR_LINE.test(lines[i])) {
        fenceEnd = i
        break
      }
    }
    if (fenceEnd > 0) {
      for (const line of lines.slice(1, fenceEnd)) {
        const match = FRONTMATTER_LINE.exec(line)
        if (match !== null) meta[match[1]] = match[2] ?? match[3] ?? ''
      }
      cursor = fenceEnd + 1
    } else {
      issues.push(issue('warning', 'frontmatter_unclosed', ctx.file, null, '头信息围栏未闭合，按无头信息处理'))
    }
  }

  // ---- H1 卷名 ----
  let name: string | null = null
  while (cursor < lines.length) {
    const h1 = H1_LINE.exec(lines[cursor])
    if (h1 !== null) {
      name = h1[1]
      cursor++
      break
    }
    // 头信息与 H1 之间只应出现空行/摘要引用行；其余行忽略（H1 前的内容不是题目）
    cursor++
  }
  if (name === null) {
    name = meta['试卷'] ?? ''
    issues.push(issue('warning', 'missing_h1', ctx.file, null, '缺少 H1 卷名，回退头信息「试卷」字段'))
  }

  // ---- 区块切分 ----
  const sections: Section[] = []
  let current: Section | null = null
  for (let i = cursor; i < lines.length; i++) {
    const line = lines[i]
    const material = MATERIAL_HEADING.exec(line)
    if (material !== null) {
      current = { kind: 'material', index: Number(material[1]), body: [] }
      sections.push(current)
      continue
    }
    const q3 = QUESTION_HEADING_H3.exec(line)
    if (q3 !== null) {
      const tag = parseQidTag(q3[2])
      current = {
        kind: 'question',
        level: 3,
        no: Number(q3[1]),
        qid: tag?.qid ?? null,
        tag: tag?.tag ?? '',
        body: [],
      }
      sections.push(current)
      continue
    }
    const q2 = QUESTION_HEADING_H2.exec(line)
    if (q2 !== null) {
      const tag = parseQidTag(q2[2])
      current = {
        kind: 'question',
        level: 2,
        no: Number(q2[1]),
        qid: tag?.qid ?? null,
        tag: tag?.tag ?? '',
        body: [],
      }
      sections.push(current)
      continue
    }
    if (ANY_H2_H3_HEADING.test(line)) {
      // 未识别的二级/三级标题：作为区块边界，内容丢弃并告警（不污染题干/解析）
      current = { kind: 'unknown', heading: line.replace(/^#+\s*/, ''), body: [] }
      sections.push(current)
      issues.push(issue('warning', 'unknown_heading', ctx.file, null, `未识别的标题区块「${current.heading}」，其内容已丢弃`))
      continue
    }
    if (current !== null) current.body.push(line)
  }

  // ---- 组装题/题组 ----
  const paperMeta = {
    year: extractYear(meta, name),
    region: extractRegion(meta),
    paperType: extractPaperType(name),
  }
  const items: Array<ParsedQuestion | ParsedGroup> = []
  let currentGroup: ParsedGroup | null = null
  let questionSections = 0

  for (const section of sections) {
    if (section.kind === 'unknown') continue
    const body = trimSectionBody(section.body)

    if (section.kind === 'material') {
      currentGroup = {
        index: section.index,
        material: parseRichLines(body),
        questionQids: [],
        year: paperMeta.year,
        region: paperMeta.region,
        paperType: paperMeta.paperType,
      }
      if (currentGroup.material.length === 0) {
        issues.push(
          issue('warning', 'empty_material', ctx.file, null, `材料 ${section.index} 内容为空`),
        )
      }
      items.push(currentGroup)
      continue
    }

    questionSections++
    const raw = parseQuestionBody(section, body)
    const question = buildQuestion(raw, ctx, issues)
    if (question === null) continue

    if (section.level === 3) {
      if (currentGroup !== null) {
        question.groupIndex = currentGroup.index
        currentGroup.questionQids.push(question.qid)
      } else {
        issues.push(
          issue('error', 'orphan_question', ctx.file, question.qid, '三级标题小题未跟随任何材料，按独立题处理'),
        )
      }
    } else {
      currentGroup = null
    }
    items.push(question)
  }

  // ---- 题数一致性（头信息题数 vs 实际题区块数；仅告警不判失败） ----
  const declared = meta['题数']
  if (declared !== undefined) {
    const declaredCount = Number(declared)
    if (Number.isInteger(declaredCount) && declaredCount !== questionSections) {
      issues.push(
        issue(
          'warning',
          'count_mismatch',
          ctx.file,
          null,
          `头信息题数 ${declaredCount} 与实际题区块数 ${questionSections} 不一致`,
        ),
      )
    }
  }

  if (items.length === 0) {
    issues.push(issue('error', 'empty_paper', ctx.file, null, '未解析出任何题目/题组，整卷跳过'))
    return { paper: null, issues }
  }

  return {
    paper: {
      file: ctx.file,
      name,
      year: paperMeta.year,
      region: paperMeta.region,
      paperType: paperMeta.paperType,
      module: ctx.module,
      meta,
      items,
    },
    issues,
  }
}

/** 题区块体 → 中间形态（题干行/选项/答案/解析行的状态机切分） */
function parseQuestionBody(
  section: Extract<Section, { kind: 'question' }>,
  body: string[],
): RawQuestion {
  const raw: RawQuestion = {
    qid: section.qid,
    tag: section.tag,
    no: section.no,
    stemLines: [],
    options: [],
    answer: null,
    analysisLines: [],
  }
  let stage: 'stem' | 'options' | 'answered' = 'stem'

  for (const line of body) {
    if (line.trim() === '') continue
    const option = OPTION_LINE.exec(line)
    if (option !== null) {
      raw.options.push(parseOptionLine(option[1], option[2]))
      stage = 'options'
      continue
    }
    const answer = ANSWER_LINE.exec(line)
    if (answer !== null) {
      raw.answer = answer[1].trim()
      stage = 'answered'
      continue
    }
    if (ANALYSIS_HEADER_LINE.test(line)) {
      // 解析头仅作定位标记（前后空行），内容归属由阶段状态机决定
      continue
    }
    if (stage === 'stem') {
      raw.stemLines.push(line)
    } else {
      // 选项之后、答案行前后的正文一律归入解析（防御：解析头缺失时不丢字）
      raw.analysisLines.push(line)
    }
  }
  return raw
}

/** 选项行内容 → 剥离行尾 ✅ 标记 */
function parseOptionLine(key: string, rawContent: string): RawOption {
  const checkmark = ANSWER_CHECKMARK.exec(rawContent)
  if (checkmark === null) return { key, content: rawContent, marked: false }
  return { key, content: rawContent.slice(0, checkmark.index), marked: true }
}

/** 中间形态 → ParsedQuestion（含逐题校验；返回 null = 题被丢弃） */
function buildQuestion(
  raw: RawQuestion,
  ctx: ParseContext,
  issues: ImportIssue[],
): ParsedQuestion | null {
  const where = `第 ${raw.no} 题`

  if (raw.qid === null) {
    issues.push(
      issue('error', 'missing_qid', ctx.file, null, `${where}缺少 qid 标记（<sub>qid …</sub>），无自然键，该题丢弃`),
    )
    return null
  }

  const optionKeys = raw.options.map((option) => option.key)
  const duplicateKeys = optionKeys.filter((key, index) => optionKeys.indexOf(key) !== index)
  if (duplicateKeys.length > 0) {
    issues.push(
      issue('error', 'duplicate_option', ctx.file, raw.qid, `${where}选项键重复：${[...new Set(duplicateKeys)].join('、')}`),
    )
  }
  if (raw.options.length === 0) {
    issues.push(issue('error', 'no_options', ctx.file, raw.qid, `${where}无选项`))
  }

  const answer = raw.answer ?? ''
  if (answer === '') {
    issues.push(issue('error', 'missing_answer', ctx.file, raw.qid, `${where}缺少答案行`))
  } else {
    const validKeys = new Set(optionKeys)
    const invalidLetters = [...answer].filter((letter) => !validKeys.has(letter))
    if (invalidLetters.length > 0) {
      issues.push(
        issue(
          'error',
          'answer_not_in_options',
          ctx.file,
          raw.qid,
          `${where}答案「${answer}」含选项键之外的字符（${invalidLetters.join('、')}）`,
        ),
      )
    }
    // 选项行尾 ✅ 标记与答案行互校（标记缺失不算不一致；标记存在但集合不同才告警）
    const markedKeys = raw.options.filter((option) => option.marked).map((option) => option.key)
    if (markedKeys.length > 0) {
      const answerSet = new Set([...answer])
      const markedSet = new Set(markedKeys)
      const same =
        answerSet.size === markedSet.size && [...answerSet].every((letter) => markedSet.has(letter))
      if (!same) {
        issues.push(
          issue(
            'warning',
            'checkmark_mismatch',
            ctx.file,
            raw.qid,
            `${where}✅ 标记（${markedKeys.join('')}）与答案（${answer}）不一致`,
          ),
        )
      }
    }
  }

  const stem = parseRichLines(raw.stemLines)
  if (stem.length === 0) {
    issues.push(issue('warning', 'empty_stem', ctx.file, raw.qid, `${where}题干为空`))
  }

  return {
    qid: raw.qid,
    kind: 'single_choice',
    stem,
    options: raw.options.map((option) => ({ key: option.key, content: parseRichLines([option.content]) })),
    answer,
    analysis: parseRichLines(raw.analysisLines),
    // 图片视觉提取文本：T1-06 填充，文本导入恒为空串
    visionText: '',
    groupIndex: null,
  }
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
