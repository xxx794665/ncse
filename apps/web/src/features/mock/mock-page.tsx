/**
 * 整卷模考·卷选页（T2-01c，/mock，requiresAuth）
 * - 进行中模考：useQuery 拉取 in_progress 会话列表，非空才渲染（空/加载/失败均不占位），「续考」→ /mock/sessions/:id
 * - 模考历史（T2-01e，F2-4 历次成绩与纵向对比）：useQuery 已交卷会话概要（staleTime 60s），
 *   非空才渲染；区头汇总「共 N 次 · 平均正确率 P%」（各次 correct/answered 加权平均派生，
 *   Σanswered=0 除零兜底「—」）+ 历次正确率迷你趋势（纯 div 单色柱状照 stats 趋势先例：
 *   每会话一柱、柱高=正确率比、按交卷时间升序、title 悬停明细、柱多横向滚动）+
 *   历次行（卷名/年份/正确率/答对/用时/交卷时间 + 成绩单入口 → /mock/sessions/:id/report）
 * - 卷目录：useQuery 全量下发（staleTime 5 分钟，低频变化）；筛选（年份/地区/卷型/完整度）纯前端过滤，
 *   选项从卷数据派生；完整卷置顶推荐（D2 前端口径：full 档在前，同档保持后端定序）
 * - 开考确认：Modal 内时长可调（默认 deriveMockTotalMinutes，shared 常量夹区间），提交中禁关闭（Esc/遮罩/取消全拦截），
 *   400/404 错误在弹窗内 danger 条展示；201 成功 invalidate 会话列表后跳作答页
 * - 401 由 api client 全局回调接管（本页不特判）
 */

import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Clock, FileText, Play } from 'lucide-react'
import type { MockHistoryItem, MockSessionSummary, PaperCompleteness, PaperSummary } from '@ncse/shared'
import {
  MOCK_TOTAL_MINUTES_MAX,
  MOCK_TOTAL_MINUTES_MIN,
  deriveMockTotalMinutes,
} from '@ncse/shared'
import {
  ApiError,
  createMockSessionApi,
  fetchMockHistoryApi,
  fetchMockSessionsApi,
  fetchPapersApi,
} from '../../api'
import { Button, Card, EmptyPlaceholder, Input, Modal, Select, Tag } from '../../components'
import type { TagTone } from '../../components'
import { mockQueryKeys } from './mock-query-keys'
import './mock.css'

/** 进行中会话列表 staleTime：30s（照 practice；会话仅经本人操作变更，开考成功 invalidate 兜底） */
const SESSIONS_STALE_TIME = 30_000
/** 卷目录 staleTime：5 分钟（低频变化，仅导入新卷时后端内容才变） */
const PAPERS_STALE_TIME = 5 * 60_000
/** 模考历史 staleTime：60s（定卷后条目只增不改，分钟级新鲜度足够） */
const HISTORY_STALE_TIME = 60_000

/** 历史列表查询缺省回退：模块级常量保证引用稳定（下游 useMemo 依赖不逐渲染漂移） */
const EMPTY_HISTORY: MockHistoryItem[] = []

/** 百分比格式化（zh-CN percent 样式，保留一位小数；stats 页先例） */
const PERCENT_FORMAT = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

/** 正确率显示：answered=0 除零兜底「—」（stats 页统一口径），否则一位小数百分比 */
function formatAccuracy(correct: number, answered: number): string {
  if (answered <= 0) return '—'
  return PERCENT_FORMAT.format(correct / answered)
}

/** 总用时显示：毫秒取整秒，不足 1 分钟显「N 秒」，否则「X 分 Y 秒」 */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${String(totalSeconds)} 秒`
  return `${String(Math.floor(totalSeconds / 60))} 分 ${String(totalSeconds % 60)} 秒`
}

/** ISO-8601 时间中文格式化（如「2026年10月13日 14:05」）；不可解析时原样回显（T1-08f/T1-10b 惯例） */
function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/** 筛选「全部」哨兵值 */
const FILTER_ALL = 'all'
/** region/paperType 为 null 的「未标定」分组哨兵（真实取值为地名/卷型文本，不会冲突） */
const FILTER_UNSET = '__unset__'

/** 完整度筛选的缺省值：完整（D2 置顶推荐口径——进来先看到可考全卷） */
const DEFAULT_COMPLETENESS: PaperCompleteness | typeof FILTER_ALL = 'full'

/** 完整度 Tag 语义：full→success / partial→warning / fragment→muted（§2.2 soft 成对） */
const COMPLETENESS_META: Record<PaperCompleteness, { tone: TagTone; label: string }> = {
  full: { tone: 'success', label: '完整' },
  partial: { tone: 'warning', label: '部分' },
  fragment: { tone: 'muted', label: '残卷' },
}

/** 完整度置顶排序权重（full 档在前） */
const COMPLETENESS_ORDER: Record<PaperCompleteness, number> = {
  full: 0,
  partial: 1,
  fragment: 2,
}

/** 卷目录查询缺省回退：模块级常量保证引用稳定（下游 useMemo 依赖不逐渲染漂移） */
const EMPTY_PAPERS: PaperSummary[] = []

/** 文本维度（region/paperType）筛选项派生结果 */
interface TextFilterOptions {
  /** 去重后的非空取值（中文排序） */
  values: string[]
  /** 是否存在 null 取值（存在则追加「未标定」选项） */
  hasUnset: boolean
}

/** 从卷目录派生文本维度筛选项：去重 + localeCompare 中文排序，null 归「未标定」 */
function deriveTextOptions(values: (string | null)[]): TextFilterOptions {
  const seen = new Set<string>()
  let hasUnset = false
  for (const value of values) {
    if (value === null) hasUnset = true
    else seen.add(value)
  }
  return { values: [...seen].sort((a, b) => a.localeCompare(b, 'zh-CN')), hasUnset }
}

/** 开考失败消息：ApiError 透传后端消息（400 时长越界 / 404 试卷不存在等），其余给通用文案 */
function createErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '创建模考失败，请稍后重试'
}

/** 进行中模考会话卡片：卷名 + 进行中 Tag + 作答进度条 + 开考锁定时长 + 续考入口 */
function MockSessionCard({ session }: { session: MockSessionSummary }) {
  const navigate = useNavigate()
  const percent =
    session.total > 0 ? Math.round((session.answeredCount / session.total) * 100) : 0
  const resume = () => navigate(`/mock/sessions/${String(session.id)}`)

  return (
    <Card className="mock-session">
      <div className="mock-session__head">
        <h3 className="mock-session__name">{session.paperName}</h3>
        <Tag tone="primary">进行中</Tag>
      </div>
      <div className="mock-session__progress">
        <div
          className="mock-session__progress-track"
          role="progressbar"
          aria-valuenow={session.answeredCount}
          aria-valuemin={0}
          aria-valuemax={session.total}
          aria-label={`${session.paperName}作答进度`}
        >
          <div className="mock-session__progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="mock-session__progress-text">
          已答 {session.answeredCount}/{session.total}
        </span>
      </div>
      <div className="mock-session__meta">
        <span className="mock-session__duration">
          <Clock aria-hidden="true" />
          {session.totalMinutes} 分钟
        </span>
        <Button size="sm" icon={<Play aria-hidden="true" />} onClick={resume}>
          续考
        </Button>
      </div>
    </Card>
  )
}

/** 历次正确率迷你趋势（纯 div 单色柱状，stats 趋势先例）：每会话一柱、柱高=正确率比、按交卷时间升序；全未答会话零高度仅占位列 */
function MockHistoryTrend({ items, averageAccuracy }: { items: MockHistoryItem[]; averageAccuracy: string }) {
  const summary = `历次模考正确率趋势柱状图：共 ${String(items.length)} 次，平均正确率 ${averageAccuracy}`
  return (
    <Card className="mock-history__trend">
      <div className="mock-history__trend-scroll">
        <div className="mock-history__trend-chart" role="img" aria-label={summary}>
          {items.map((item) => {
            const { correct, answered } = item.summary
            // 未答会话（answered=0）：零高度仅占位列，不渲染柱体（无正确率可表达，stats 零填空天先例）
            if (answered === 0) {
              return <div key={item.id} className="mock-history__trend-col" />
            }
            const heightPct = (correct / answered) * 100
            const tip = `${item.paperName}（${formatDateTime(item.submittedAt)}）：正确率 ${formatAccuracy(
              correct,
              answered,
            )} · 答对 ${String(correct)}/${String(answered)}`
            return (
              <div key={item.id} className="mock-history__trend-col">
                <div
                  className="mock-history__trend-bar"
                  style={{ height: `${String(heightPct)}%` }}
                  title={tip}
                />
              </div>
            )
          })}
        </div>
      </div>
    </Card>
  )
}

/** 历史行：卷名（单行省略）+ 年份 Tag + 正确率/答对/用时/交卷时间 + 成绩单入口（跳 report 页） */
function MockHistoryRow({ item }: { item: MockHistoryItem }) {
  const navigate = useNavigate()
  const { summary } = item
  return (
    <Card className="mock-history__item">
      <div className="mock-history__main">
        <div className="mock-history__head">
          <h3 className="mock-history__name">{item.paperName}</h3>
          {item.paperYear !== null && (
            <Tag tone="muted" className="mock-history__year">
              {item.paperYear} 年
            </Tag>
          )}
        </div>
        <p className="mock-history__meta">
          正确率{' '}
          <span className="mock-history__num">
            {formatAccuracy(summary.correct, summary.answered)}
          </span>
          {' · '}答对{' '}
          <span className="mock-history__num">
            {summary.correct}/{summary.total}
          </span>
          {' · '}用时 <span className="mock-history__num">{formatDurationMs(item.elapsedMs)}</span>
          {' · '}交卷于 {formatDateTime(item.submittedAt)}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="mock-history__action"
        onClick={() => navigate(`/mock/sessions/${String(item.id)}/report`)}
      >
        成绩单
      </Button>
    </Card>
  )
}

/** 模考历史区（F2-4 一期口径）：汇总行 + 迷你趋势 + 历次行；模块级纵向对比等深度留后续 */
function MockHistorySection({ items }: { items: MockHistoryItem[] }) {
  // 加权平均正确率：Σcorrect/Σanswered（各次按已答数加权，stats 派生口径；Σanswered=0 兜底「—」）
  let totalCorrect = 0
  let totalAnswered = 0
  for (const item of items) {
    totalCorrect += item.summary.correct
    totalAnswered += item.summary.answered
  }
  const averageAccuracy = formatAccuracy(totalCorrect, totalAnswered)
  // 趋势按交卷时间升序（早 → 晚；history 端点为倒序，副本反转不改原数组）
  const trendItems = useMemo(() => [...items].reverse(), [items])

  return (
    <section className="mock-section" aria-labelledby="mock-history-title">
      <div className="mock-section__head">
        <h2 id="mock-history-title" className="mock-section__title">
          模考历史
        </h2>
        <p className="mock-section__desc">
          共 {items.length} 次 · 平均正确率 {averageAccuracy}
        </p>
      </div>
      <MockHistoryTrend items={trendItems} averageAccuracy={averageAccuracy} />
      <div className="mock-history__list">
        {items.map((item) => (
          <MockHistoryRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  )
}

/** 试卷卡片：卷名（两行截断）+ 年份/地区/卷型 Tag 行（缺省不渲染）+ 完整度 Tag 与题数，点击/Enter/Space 开确认弹窗 */
function PaperCard({
  paper,
  onOpen,
}: {
  paper: PaperSummary
  onOpen: (paper: PaperSummary) => void
}) {
  const meta = COMPLETENESS_META[paper.completeness]
  const hasInfoTags =
    paper.year !== null || paper.region !== null || paper.paperType !== null
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen(paper)
    }
  }

  return (
    <Card
      interactive
      className="mock-paper"
      onClick={() => onOpen(paper)}
      role="button"
      tabIndex={0}
      onKeyDown={keyDown}
    >
      <div className="mock-paper__head">
        <FileText className="mock-paper__icon" aria-hidden="true" />
        <h3 className="mock-paper__name">{paper.name}</h3>
      </div>
      {hasInfoTags && (
        <div className="mock-paper__tags">
          {paper.year !== null && <Tag tone="muted">{paper.year} 年</Tag>}
          {paper.region !== null && <Tag tone="muted">{paper.region}</Tag>}
          {paper.paperType !== null && <Tag tone="muted">{paper.paperType}</Tag>}
        </div>
      )}
      <div className="mock-paper__foot">
        <Tag tone={meta.tone}>
          {meta.label} · {paper.questionCount} 题
        </Tag>
        <span className="mock-paper__count">共 {paper.questionCount} 题</span>
      </div>
    </Card>
  )
}

/** 卷目录加载骨架（§6.8：bg-muted 圆角块 + 呼吸动画；与实卡共用同一栅格，切换不跳版式） */
function PapersSkeleton() {
  return (
    <div className="mock-papers" role="status" aria-label="正在加载试卷目录">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index} className="mock-skeleton" aria-hidden="true">
          <div className="mock-skeleton__line mock-skeleton__line--title" />
          <div className="mock-skeleton__line" />
          <div className="mock-skeleton__line mock-skeleton__line--short" />
        </div>
      ))}
    </div>
  )
}

export function MockPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const sessionsQuery = useQuery({
    queryKey: mockQueryKeys.sessions,
    queryFn: fetchMockSessionsApi,
    staleTime: SESSIONS_STALE_TIME,
  })
  const papersQuery = useQuery({
    queryKey: mockQueryKeys.papers,
    queryFn: fetchPapersApi,
    staleTime: PAPERS_STALE_TIME,
  })
  const historyQuery = useQuery({
    queryKey: mockQueryKeys.history,
    queryFn: fetchMockHistoryApi,
    staleTime: HISTORY_STALE_TIME,
  })

  // 四维筛选：年份/地区/卷型/完整度（完整度默认「完整」，D2 置顶推荐口径）
  const [yearFilter, setYearFilter] = useState<string>(FILTER_ALL)
  const [regionFilter, setRegionFilter] = useState<string>(FILTER_ALL)
  const [typeFilter, setTypeFilter] = useState<string>(FILTER_ALL)
  const [completenessFilter, setCompletenessFilter] = useState<PaperCompleteness | typeof FILTER_ALL>(
    DEFAULT_COMPLETENESS,
  )

  // 待开考的试卷（非 null 即弹窗打开）；时长文本每次开弹窗时按题数推导重置
  const [targetPaper, setTargetPaper] = useState<PaperSummary | null>(null)
  const [minutesText, setMinutesText] = useState<string>('')

  const createMutation = useMutation({
    mutationFn: createMockSessionApi,
    onSuccess: (detail) => {
      // 作答页返回时列表不过期：开考成功即失效会话列表，再跳作答页
      void queryClient.invalidateQueries({ queryKey: mockQueryKeys.sessions })
      setTargetPaper(null)
      navigate(`/mock/sessions/${String(detail.id)}`)
    },
  })

  const papers = papersQuery.data ?? EMPTY_PAPERS

  // 筛选项从卷目录派生（随数据就绪自然填充）
  const yearOptions = useMemo(() => {
    const years = new Set<number>()
    for (const paper of papers) {
      if (paper.year !== null) years.add(paper.year)
    }
    return [...years].sort((a, b) => b - a)
  }, [papers])
  const regionOptions = useMemo(
    () => deriveTextOptions(papers.map((paper) => paper.region)),
    [papers],
  )
  const typeOptions = useMemo(
    () => deriveTextOptions(papers.map((paper) => paper.paperType)),
    [papers],
  )

  // 纯前端过滤 + 完整卷稳定重排置顶（Array.sort 稳定：同档保持后端定序）
  const visiblePapers = useMemo(() => {
    const matches = papers.filter((paper) => {
      if (yearFilter !== FILTER_ALL && String(paper.year) !== yearFilter) return false
      if (regionFilter !== FILTER_ALL) {
        if (regionFilter === FILTER_UNSET ? paper.region !== null : paper.region !== regionFilter) {
          return false
        }
      }
      if (typeFilter !== FILTER_ALL) {
        if (typeFilter === FILTER_UNSET ? paper.paperType !== null : paper.paperType !== typeFilter) {
          return false
        }
      }
      if (completenessFilter !== FILTER_ALL && paper.completeness !== completenessFilter) {
        return false
      }
      return true
    })
    return matches.sort(
      (a, b) => COMPLETENESS_ORDER[a.completeness] - COMPLETENESS_ORDER[b.completeness],
    )
  }, [papers, yearFilter, regionFilter, typeFilter, completenessFilter])

  const isDefaultFilters =
    yearFilter === FILTER_ALL &&
    regionFilter === FILTER_ALL &&
    typeFilter === FILTER_ALL &&
    completenessFilter === DEFAULT_COMPLETENESS
  const resetFilters = () => {
    setYearFilter(FILTER_ALL)
    setRegionFilter(FILTER_ALL)
    setTypeFilter(FILTER_ALL)
    setCompletenessFilter(DEFAULT_COMPLETENESS)
  }

  const openCreateModal = (paper: PaperSummary) => {
    setMinutesText(String(deriveMockTotalMinutes(paper.questionCount)))
    createMutation.reset()
    setTargetPaper(paper)
  }
  const closeCreateModal = () => {
    // 提交中不允许关闭（Esc/遮罩/取消同走本函数），避免请求悬置后状态错乱
    if (createMutation.isPending) return
    setTargetPaper(null)
    createMutation.reset()
  }

  // 时长校验：整数且落在 shared 区间内（与服务端 400 口径一致，前端先行拦截）
  const parsedMinutes = Number(minutesText)
  const minutesValid =
    Number.isInteger(parsedMinutes) &&
    parsedMinutes >= MOCK_TOTAL_MINUTES_MIN &&
    parsedMinutes <= MOCK_TOTAL_MINUTES_MAX
  const submitCreate = () => {
    if (targetPaper === null || createMutation.isPending || !minutesValid) return
    createMutation.mutate({ paperId: targetPaper.id, totalMinutes: parsedMinutes })
  }

  // 进行中模考区：非空才渲染（空/加载中/失败均不占位，卷目录为主区）
  const sessions = sessionsQuery.data ?? []
  // 模考历史区：同口径非空才渲染（空/加载中/失败均不占位）
  const history = historyQuery.data ?? EMPTY_HISTORY

  return (
    <div className="mock">
      <header className="mock-hero">
        <h1 className="mock-hero__title">整卷模考</h1>
        <p className="mock-hero__desc">
          按真题整卷与真实时长计时模考：选卷、定时、开考，交卷统一判分出成绩单。
        </p>
      </header>

      {sessions.length > 0 && (
        <section className="mock-section" aria-labelledby="mock-sessions-title">
          <div className="mock-section__head">
            <h2 id="mock-sessions-title" className="mock-section__title">
              进行中的模考
            </h2>
          </div>
          <div className="mock-sessions">
            {sessions.map((session) => (
              <MockSessionCard key={session.id} session={session} />
            ))}
          </div>
        </section>
      )}

      {history.length > 0 && <MockHistorySection items={history} />}

      <section className="mock-section" aria-labelledby="mock-papers-title">
        <div className="mock-section__head">
          <h2 id="mock-papers-title" className="mock-section__title">
            选择试卷开考
          </h2>
        </div>

        <div className="mock-filters" role="group" aria-label="试卷筛选">
          <Select
            label="年份"
            value={yearFilter}
            disabled={papersQuery.isPending}
            onChange={(event) => setYearFilter(event.target.value)}
          >
            <option value={FILTER_ALL}>全部</option>
            {yearOptions.map((year) => (
              <option key={year} value={String(year)}>
                {year} 年
              </option>
            ))}
          </Select>
          <Select
            label="地区"
            value={regionFilter}
            disabled={papersQuery.isPending}
            onChange={(event) => setRegionFilter(event.target.value)}
          >
            <option value={FILTER_ALL}>全部</option>
            {regionOptions.values.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
            {regionOptions.hasUnset && <option value={FILTER_UNSET}>未标定</option>}
          </Select>
          <Select
            label="卷型"
            value={typeFilter}
            disabled={papersQuery.isPending}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value={FILTER_ALL}>全部</option>
            {typeOptions.values.map((paperType) => (
              <option key={paperType} value={paperType}>
                {paperType}
              </option>
            ))}
            {typeOptions.hasUnset && <option value={FILTER_UNSET}>未标定</option>}
          </Select>
          <Select
            label="完整度"
            value={completenessFilter}
            disabled={papersQuery.isPending}
            onChange={(event) =>
              setCompletenessFilter(event.target.value as PaperCompleteness | typeof FILTER_ALL)
            }
          >
            <option value={FILTER_ALL}>全部</option>
            <option value="full">完整</option>
            <option value="partial">部分</option>
            <option value="fragment">残卷</option>
          </Select>
        </div>

        {papersQuery.isPending && <PapersSkeleton />}
        {papersQuery.isError && (
          <div className="mock-papers__error" role="alert">
            <p className="mock-papers__error-text">
              {papersQuery.error instanceof ApiError
                ? papersQuery.error.message
                : '试卷目录加载失败，请稍后重试'}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void papersQuery.refetch()}
            >
              重试
            </Button>
          </div>
        )}
        {papersQuery.isSuccess && visiblePapers.length === 0 && (
          <EmptyPlaceholder
            title="没有符合筛选的试卷"
            description={
              isDefaultFilters
                ? '试卷目录暂无数据，请稍后再来。'
                : '试试放宽年份、地区、卷型或完整度条件。'
            }
            actionLabel="清空筛选"
            onAction={isDefaultFilters ? undefined : resetFilters}
          />
        )}
        {papersQuery.isSuccess && visiblePapers.length > 0 && (
          <div className="mock-papers">
            {visiblePapers.map((paper) => (
              <PaperCard key={paper.id} paper={paper} onOpen={openCreateModal} />
            ))}
          </div>
        )}
      </section>

      <Modal
        open={targetPaper !== null}
        onClose={closeCreateModal}
        title="确认开考"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeCreateModal}
              disabled={createMutation.isPending}
            >
              取消
            </Button>
            <Button
              onClick={submitCreate}
              loading={createMutation.isPending}
              disabled={!minutesValid}
            >
              开考
            </Button>
          </>
        }
      >
        {targetPaper !== null && (
          <div className="mock-create">
            {createMutation.isError && (
              <p className="mock-create__error" role="alert">
                {createErrorMessage(createMutation.error)}
              </p>
            )}
            <dl className="mock-create__meta">
              <div className="mock-create__meta-row">
                <dt>卷名</dt>
                <dd>{targetPaper.name}</dd>
              </div>
              <div className="mock-create__meta-row">
                <dt>年份</dt>
                <dd>{targetPaper.year === null ? '未标定' : `${targetPaper.year} 年`}</dd>
              </div>
              <div className="mock-create__meta-row">
                <dt>地区</dt>
                <dd>{targetPaper.region ?? '未标定'}</dd>
              </div>
              <div className="mock-create__meta-row">
                <dt>卷型</dt>
                <dd>{targetPaper.paperType ?? '未标定'}</dd>
              </div>
              <div className="mock-create__meta-row">
                <dt>题数</dt>
                <dd className="mock-create__meta-num">{targetPaper.questionCount} 题</dd>
              </div>
              <div className="mock-create__meta-row">
                <dt>完整度</dt>
                <dd>
                  <Tag tone={COMPLETENESS_META[targetPaper.completeness].tone}>
                    {COMPLETENESS_META[targetPaper.completeness].label} ·{' '}
                    {targetPaper.questionCount} 题
                  </Tag>
                </dd>
              </div>
            </dl>
            <div>
              <Input
                type="number"
                label="考试时长（分钟）"
                min={MOCK_TOTAL_MINUTES_MIN}
                max={MOCK_TOTAL_MINUTES_MAX}
                step={1}
                value={minutesText}
                disabled={createMutation.isPending}
                onChange={(event) => setMinutesText(event.target.value)}
                error={
                  minutesValid
                    ? undefined
                    : `请输入 ${MOCK_TOTAL_MINUTES_MIN}–${MOCK_TOTAL_MINUTES_MAX} 的整数`
                }
              />
              <p className="mock-create__hint">
                默认 1 题/分钟向上取整到 5 分钟，可调 {MOCK_TOTAL_MINUTES_MIN}–
                {MOCK_TOTAL_MINUTES_MAX}
              </p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
