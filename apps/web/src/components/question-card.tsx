/**
 * QuestionCard 题目卡片（docs/design/设计规范.md §6.5、§7.1、§7.3、§7.4）
 * 头部：题号 + 元信息（aux/text-tertiary）+ 收藏/标记图标按钮；
 * 中部：题干（§3.3 一级 17px/1.7 medium）+ 可选图片插槽（§7.3）+ 选项纵向列表（§7.1 五态）；
 * 底部：答案与解析区（§7.4，默认折叠、判分后自动展开、模考模式整体隐藏）
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { BookOpen, ChevronDown, Flag, Star } from 'lucide-react'
import { Card } from './card'
import { Tag } from './tag'
import './question-card.css'

export interface QuestionOption {
  /** 选项字母（A–D…），同时作为徽标与 key */
  key: string
  content: ReactNode
}

export interface QuestionOptionAnalysis {
  key: string
  content: ReactNode
}

export interface QuestionKnowledgeTag {
  key: string
  label: string
}

export type QuestionCardMode = 'practice' | 'mock'

export interface QuestionCardProps {
  /** 题号（从 1 起） */
  index: number
  /** 元信息（qid/年份/难度等），aux 字号 text-tertiary */
  meta?: ReactNode
  /** 题干（§3.3 一级阅读层） */
  stem: ReactNode
  options: QuestionOption[]
  /** 当前选中项 */
  selectedKey?: string | null
  /** 判分后传入正确答案字母 */
  correctKey?: string
  /** 是否已判分：判分后选项禁点、解析自动展开（§7.1） */
  graded?: boolean
  onSelect?: (key: string) => void
  /** 收藏态与切换（§5：收藏=Star） */
  favorite?: boolean
  onFavoriteToggle?: () => void
  /** 标记态与切换（Flag 图标按钮） */
  flagged?: boolean
  onFlagToggle?: () => void
  /** 图片插槽（§7.3）：块级居中、max-h 480px、radius-md + border-subtle */
  imageSlot?: ReactNode
  /** 解析正文（§3.2：16px/1.75） */
  analysis?: ReactNode
  /** 逐项辨析（§7.4③，字母徽标引导） */
  optionAnalysis?: QuestionOptionAnalysis[]
  /** 知识点标签行（§7.4④，ghost 徽章） */
  knowledgeTags?: QuestionKnowledgeTag[]
  onKnowledgeTagClick?: (key: string) => void
  /** mock=模考模式：交卷前解析区整体隐藏（§7.4） */
  mode?: QuestionCardMode
  /** 解析区初始展开（默认 false；graded 后强制展开） */
  analysisDefaultOpen?: boolean
}

/** 选项态判定（§7.1）：默认 / 选中 / 判分·正确 / 判分·误选 / 判分·未选的正确项 */
function optionState(
  key: string,
  selectedKey: string | null | undefined,
  correctKey: string | undefined,
  graded: boolean,
): 'default' | 'selected' | 'correct' | 'wrong' | 'missed' {
  if (!graded) return key === selectedKey ? 'selected' : 'default'
  if (key === correctKey) return key === selectedKey ? 'correct' : 'missed'
  if (key === selectedKey) return 'wrong'
  return 'default'
}

export function QuestionCard({
  index,
  meta,
  stem,
  options,
  selectedKey = null,
  correctKey,
  graded = false,
  onSelect,
  favorite = false,
  onFavoriteToggle,
  flagged = false,
  onFlagToggle,
  imageSlot,
  analysis,
  optionAnalysis,
  knowledgeTags,
  onKnowledgeTagClick,
  mode = 'practice',
  analysisDefaultOpen = false,
}: QuestionCardProps) {
  const [analysisOpen, setAnalysisOpen] = useState(analysisDefaultOpen)
  // graded 哨兵：初始恒为 false，保证「挂载即已判分」同样触发自动展开（与原 effect 等价）
  const [prevGraded, setPrevGraded] = useState(false)

  // 判分后解析区自动展开（§7.1）：随 graded 跳变在渲染期调整状态（react.dev 对 setState-in-effect 的推荐替代）
  if (graded !== prevGraded) {
    setPrevGraded(graded)
    if (graded) setAnalysisOpen(true)
  }

  const hasAnalysis = Boolean(analysis || optionAnalysis?.length || knowledgeTags?.length)
  const showAnalysis = mode !== 'mock' && hasAnalysis
  const answered = selectedKey !== null && selectedKey !== undefined
  const answeredCorrect = answered && selectedKey === correctKey

  return (
    <Card className="ncse-question-card">
      <div className="ncse-question-card__head">
        <span className="ncse-question-card__index">第 {index} 题</span>
        {meta && <span className="ncse-question-card__meta">{meta}</span>}
        <span className="ncse-question-card__actions">
          {onFavoriteToggle && (
            <button
              type="button"
              className={`ncse-question-card__icon-btn${favorite ? ' is-favorite' : ''}`}
              onClick={onFavoriteToggle}
              aria-label={favorite ? '取消收藏' : '收藏'}
              aria-pressed={favorite}
            >
              <Star aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
            </button>
          )}
          {onFlagToggle && (
            <button
              type="button"
              className={`ncse-question-card__icon-btn${flagged ? ' is-flagged' : ''}`}
              onClick={onFlagToggle}
              aria-label={flagged ? '取消标记' : '标记'}
              aria-pressed={flagged}
            >
              <Flag aria-hidden="true" fill={flagged ? 'currentColor' : 'none'} />
            </button>
          )}
        </span>
      </div>

      <div className="ncse-question-card__stem">{stem}</div>

      {imageSlot && <div className="ncse-question-card__image">{imageSlot}</div>}

      <div className="ncse-question-card__options" role={graded ? undefined : 'radiogroup'}>
        {options.map((option) => {
          const state = optionState(option.key, selectedKey, correctKey, graded)
          return (
            <button
              key={option.key}
              type="button"
              className={`ncse-option ncse-option--${state}`}
              disabled={graded}
              onClick={() => onSelect?.(option.key)}
            >
              <span className="ncse-option__badge" aria-hidden="true">
                {option.key}
              </span>
              <span className="ncse-option__content">{option.content}</span>
            </button>
          )
        })}
      </div>

      {showAnalysis && (
        <section className="ncse-question-card__analysis">
          <button
            type="button"
            className="ncse-question-card__analysis-toggle"
            aria-expanded={analysisOpen}
            onClick={() => setAnalysisOpen((open) => !open)}
          >
            <BookOpen aria-hidden="true" />
            <span>答案与解析</span>
            <ChevronDown
              className={`ncse-question-card__analysis-chevron${analysisOpen ? ' is-open' : ''}`}
              aria-hidden="true"
            />
          </button>

          {analysisOpen && (
            <div className="ncse-question-card__analysis-body">
              {graded && correctKey && (
                <p className="ncse-question-card__answer-row">
                  <span className="ncse-question-card__answer-label">
                    正确答案：{correctKey}
                  </span>
                  {answered ? (
                    answeredCorrect ? (
                      <Tag tone="success">答对</Tag>
                    ) : (
                      <Tag tone="danger">答错</Tag>
                    )
                  ) : (
                    <Tag tone="muted">未作答</Tag>
                  )}
                </p>
              )}

              {analysis && <div className="ncse-question-card__analysis-text">{analysis}</div>}

              {optionAnalysis && optionAnalysis.length > 0 && (
                <ul className="ncse-question-card__option-analysis">
                  {optionAnalysis.map((item) => (
                    <li key={item.key}>
                      <span className="ncse-option__badge ncse-option__badge--plain" aria-hidden="true">
                        {item.key}
                      </span>
                      <span>{item.content}</span>
                    </li>
                  ))}
                </ul>
              )}

              {knowledgeTags && knowledgeTags.length > 0 && (
                <div className="ncse-question-card__knowledge">
                  {knowledgeTags.map((tag) => (
                    <Tag key={tag.key} onClick={() => onKnowledgeTagClick?.(tag.key)}>
                      {tag.label}
                    </Tag>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </Card>
  )
}
