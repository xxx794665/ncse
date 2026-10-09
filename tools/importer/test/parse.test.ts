/**
 * 解析器单测（T1-04）：对合成夹具（虚构题目，语法按真实样本归纳的 grammar.ts 构造）
 * 验证 题干/选项/答案/解析/qid、题组、图片引用、实体解码、多选答案、元数据提取。
 * 不访问网络、不依赖真实题库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModuleCode, ParsedGroup, ParsedPaper, ParsedQuestion } from '../src/types.js'
import { parsePaper } from '../src/parser/markdown.js'

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))

function parseFixture(rel: string, module: ModuleCode): ParsedPaper {
  const source = fs.readFileSync(path.join(fixturesDir, rel), 'utf8')
  const { paper, issues } = parsePaper(source, { file: rel, module })
  expect(issues).toEqual([])
  if (paper === null) throw new Error(`夹具应解析出试卷：${rel}`)
  return paper
}

function questionsOf(paper: ParsedPaper): ParsedQuestion[] {
  return paper.items.filter((item): item is ParsedQuestion => 'qid' in item)
}

function groupsOf(paper: ParsedPaper): ParsedGroup[] {
  return paper.items.filter((item): item is ParsedGroup => !('qid' in item))
}

const QUESTION_BY_INDEX = (paper: ParsedPaper, index: number): ParsedQuestion => {
  const question = questionsOf(paper)[index]
  expect(question).toBeDefined()
  return question
}

describe('普通题解析（政治理论模块样本格式）', () => {
  const paper = parseFixture('clean-input/01-政治理论/2024年某省公务员录用考试《行测》题（虚构甲卷）.md', 'political_theory')

  it('卷名/模块/头信息保留', () => {
    expect(paper.name).toBe('2024年某省公务员录用考试《行测》题（虚构甲卷）')
    expect(paper.module).toBe('political_theory')
    expect(paper.meta['题数']).toBe('2')
    expect(paper.meta['地区']).toBe('虚构省')
  })

  it('题干/选项/答案/解析/qid 逐字段', () => {
    expect(questionsOf(paper)).toHaveLength(2)
    const q1 = QUESTION_BY_INDEX(paper, 0)
    expect(q1.qid).toBe('900101')
    expect(q1.kind).toBe('single_choice')
    expect(q1.groupIndex).toBeNull()
    expect(q1.visionText).toBe('')
    expect(q1.stem).toEqual([{ type: 'text', text: '虚构学派认为，世界的本原是（　　）。' }])
    expect(q1.options.map((option) => option.key)).toEqual(['A', 'B', 'C', 'D'])
    expect(q1.options[0].content).toEqual([{ type: 'text', text: '虚构物质' }])
    expect(q1.answer).toBe('A')
    expect(q1.analysis).toHaveLength(3)
    expect(q1.analysis[0]).toEqual({
      type: 'text',
      text: '虚构学派的经典文献《虚构篇》开篇指出：世界的本原是虚构物质，其余皆为虚构物质的派生形态。',
    })
    expect(q1.analysis[2]).toEqual({ type: 'text', text: '【文段出处】《虚构篇》开篇。' })
  })

  it('行尾 ✅ 正确项标记被剥离且不进入选项内容', () => {
    const q1 = QUESTION_BY_INDEX(paper, 0)
    for (const option of q1.options) {
      expect(JSON.stringify(option.content)).not.toContain('✅')
    }
    const q2 = QUESTION_BY_INDEX(paper, 1)
    expect(q2.answer).toBe('B')
    expect(q2.options[1].content).toEqual([{ type: 'text', text: '观察归纳' }])
  })
})

describe('多行题干与篇章内容（言语模块）', () => {
  const paper = parseFixture('clean-input/03-言语理解与表达/2024年某省联考《行测》题（虚构丙卷）.md', 'verbal')

  it('多行题干 → 每行一个文本段', () => {
    const q1 = QUESTION_BY_INDEX(paper, 0)
    expect(q1.stem).toHaveLength(2)
    expect(q1.stem[0]).toEqual({
      type: 'text',
      text: '虚构作家的叙事风格一向克制，他习惯把浓烈的情感藏在平淡语句之下，让读者在字里行间自行　　　　。',
    })
    expect(q1.stem[1]).toEqual({ type: 'text', text: '填入画横线部分最恰当的一项是：' })
  })

  it('解析多行文本与【文段出处】尾行', () => {
    const q1 = QUESTION_BY_INDEX(paper, 0)
    expect(q1.analysis).toHaveLength(4)
    expect(q1.analysis.at(-1)).toEqual({ type: 'text', text: '【文段出处】《虚构文学评论》第三期。' })
  })
})

describe('资料分析材料题组（材料 → 小题群）', () => {
  const paper = parseFixture('clean-input/06-资料分析/2024年某省公务员录用考试《行测》题（虚构己卷）.md', 'data_analysis')

  it('题组结构：material/questionQids/groupIndex', () => {
    const groups = groupsOf(paper)
    expect(groups).toHaveLength(2)
    expect(groups[0].index).toBe(1)
    expect(groups[0].questionQids).toEqual(['900601', '900602'])
    expect(groups[1].index).toBe(2)
    expect(groups[1].questionQids).toEqual(['900603'])
    // items 平铺混排且保持源顺序：材料1、题1、题2、材料2、题3
    expect(paper.items.map((item) => ('qid' in item ? item.qid : `group:${item.index}`))).toEqual([
      'group:1',
      '900601',
      '900602',
      'group:2',
      '900603',
    ])
    expect(QUESTION_BY_INDEX(paper, 0).groupIndex).toBe(1)
    expect(QUESTION_BY_INDEX(paper, 1).groupIndex).toBe(1)
    expect(QUESTION_BY_INDEX(paper, 2).groupIndex).toBe(2)
  })

  it('题组级元数据继承自试卷', () => {
    const group = groupsOf(paper)[0]
    expect(group.year).toBe(2024)
    expect(group.region).toBe('虚构省')
    expect(group.paperType).toBe('省考')
  })

  it('纯图片材料（表格图 + <br>）→ 单一图片段', () => {
    expect(groupsOf(paper)[0].material).toEqual([
      { type: 'image', path: '../90-图片/题目图/fake-table-01.png' },
    ])
  })

  it('文字材料：NBSP/空格缩进被修剪，段落为独立文本段', () => {
    const material = groupsOf(paper)[1].material
    expect(material).toHaveLength(2)
    expect(material[0]).toEqual({
      type: 'text',
      text: '虚构省2024年上半年快递业务量完成8.2亿件，同比增长12%；业务收入完成136.0亿元，同比增长9.5%。',
    })
  })

  it('选项整体为 <p><img/></p> 且 ✅ 在 </p> 之后 → 正确剥离并产出图片段', () => {
    const q2 = QUESTION_BY_INDEX(paper, 1)
    expect(q2.answer).toBe('B')
    expect(q2.options[1].content).toEqual([
      { type: 'image', path: '../90-图片/公式图/formula-fake-12.png' },
    ])
  })
})

describe('图片引用 → RichSegment（题干/解析）', () => {
  const paper = parseFixture('clean-input/05-判断推理/2024年某省公务员录用考试《行测》题（虚构戊卷）.md', 'judgement')

  it('题干 <p>+<img> → 文本段与图片段（源相对路径原样保留）', () => {
    const q = QUESTION_BY_INDEX(paper, 0)
    expect(q.stem).toEqual([
      { type: 'text', text: '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：' },
      { type: 'image', path: '../90-图片/题目图/fake-fig-01.png' },
    ])
  })

  it('解析中的公式图与段落结构', () => {
    const q = QUESTION_BY_INDEX(paper, 0)
    expect(q.analysis).toEqual([
      {
        type: 'text',
        text: '虚构图形序列按顺时针方向每次旋转90°，且阴影块数量依次为1、2、3，故？处应为旋转90°且阴影块数量为4的图形。',
      },
      { type: 'image', path: '../90-图片/题目图/fake-fig-02.png' },
      { type: 'text', text: '故正确答案为B。' },
    ])
  })

  it('图片题 visionText 为空串（T1-06 才填充）', () => {
    expect(QUESTION_BY_INDEX(paper, 0).visionText).toBe('')
  })
})

describe('HTML 实体解码与混排行内内容', () => {
  const paper = parseFixture('clean-input/04-数量关系/2024年某省公务员录用考试《行测》题（虚构丁卷）.md', 'quantitative')

  it('&lt; 解码为 <，行内公式图拆分为 文本/图片/文本 段', () => {
    const q = QUESTION_BY_INDEX(paper, 0)
    expect(q.analysis).toHaveLength(5)
    expect(q.analysis[0]).toEqual({
      type: 'text',
      text: '相邻两项之差依次为4、6、8、10，下一个差为12，故第6项=30+12=42。',
    })
    expect(q.analysis[1]).toEqual({ type: 'text', text: '当 x < 42 时，x 不满足题意；检验' })
    expect(q.analysis[2]).toEqual({ type: 'image', path: '../90-图片/公式图/formula-fake-01.png' })
    expect(q.analysis[3]).toEqual({ type: 'text', text: '亦得42。' })
    expect(q.analysis[4]).toEqual({ type: 'text', text: '故正确答案为B。' })
  })
})

describe('多选答案（沪式不定项，常识判断题组）', () => {
  const paper = parseFixture('clean-input/02-常识判断/2024年某市公务员录用考试《行测》题（虚构乙卷）.md', 'common_sense')

  it('多键连写答案与多个 ✅ 标记保持一致', () => {
    const q1 = QUESTION_BY_INDEX(paper, 0)
    expect(q1.answer).toBe('ABC')
    expect(q1.groupIndex).toBe(1)
    expect(groupsOf(paper)[0].questionQids).toEqual(['900201', '900202'])
  })
})

describe('卷名元数据提取（含提取不出的 null 用例）', () => {
  it('联考卷：year/region/paper_type', () => {
    const paper = parseFixture('clean-input/03-言语理解与表达/2024年某省联考《行测》题（虚构丙卷）.md', 'verbal')
    expect(paper.year).toBe(2024)
    expect(paper.region).toBe('虚构省')
    expect(paper.paperType).toBe('联考')
  })

  it('省考卷（公务员录用考试）', () => {
    const paper = parseFixture('clean-input/01-政治理论/2024年某省公务员录用考试《行测》题（虚构甲卷）.md', 'political_theory')
    expect(paper.paperType).toBe('省考')
  })

  it('缺年份/地区且卷名无关键词 → 全部 null', () => {
    const paper = parseFixture('clean-input/06-资料分析/虚构内部测试卷.md', 'data_analysis')
    expect(paper.year).toBeNull()
    expect(paper.region).toBeNull()
    expect(paper.paperType).toBeNull()
    // 题目本体仍完整解析（元数据降级不影响内容）
    expect(questionsOf(paper)).toHaveLength(1)
    expect(QUESTION_BY_INDEX(paper, 0).qid).toBe('900604')
  })
})
