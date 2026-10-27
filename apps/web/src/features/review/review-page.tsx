/**
 * 错题·需加强·收藏复习页（T1-10b / M3 T3-01f，/review，requiresAuth）
 * - 四视图 Tab（本地 state 切换；role=tablist/tab/tabpanel + 方向键漫游 tabindex 的 ARIA tabs 形态）：
 *   错题本 active / 难点本 hard / 需加强 reinforce（M3/T3-01f）/ 收藏 favorites
 * - 错题本/难点本视图：useQuery 按 status 取列表（staleTime 30s；骨架/错误重试/空态三态照 T1-08f 模式）；
 *   卡片 = 题干预览（服务端截断 80 字或「（图片题）」，CSS 两行截断兜底）+ 模块 Tag
 *   + 答错/重做计数 + 中文 updatedAt + 收藏星标
 * - 需加强视图（M3/T3-01f）：GET /api/reinforce?status=pending（D8 定稿：仅 pending 列表，
 *   全自动队列无任何用户处置动作——汇入由判分联动、出队仅强化练习答对不超时，与错题本的
 *   用户处置状态机本质分工）；卡片 = 模块 Tag + reason 标记（wrong 答错 danger / timeout 超时
 *   warning）+ 题干预览（CSS 两行截断兜底照错题本先例）+ 中文 updatedAt；无移除/收藏按钮
 * - 强化练习入口：需加强视图头部主按钮「强化练习」（列表空/加载中禁用，照重做按钮先例）→ Modal
 *   题数四选一（5/10/20/30 默认 10，radiogroup，提交中禁关闭——Esc/遮罩/取消全拦截，T1-08f 约定）
 *   → reinforce 分支建会话（T3-01e 判别联合）→ 失效会话列表并跳 /practice/sessions/:id；
 *   400（需加强清单暂无待强化题目）在弹窗内 danger 条展示 ApiError.message
 * - 重做入口：错题/难点视图头部主按钮「重做练习」（列表空禁用）→ Modal 选题数（5/10/20/30 默认 10，
 *   提交中禁关闭，T1-08f 约定）→ wrong_redo 分支建会话（T1-10a 判别联合）→ 失效会话列表并跳
 *   /practice/sessions/:id；400（在册 0 条等）在弹窗内 danger 条展示 ApiError.message
 * - 卡片处置（ADR-0010）：active 卡「归难点本/移除」、hard 卡「移除」，确认 Modal 说明语义
 *   （remove=eliminated 软移除保计数、日后再答错自动复活为 active；to_hard=归难点本长期跟进）；
 *   处置中禁关；成功按前缀失效 wrongBook 双状态列表 + success-soft 轻提示，失败弹窗内提示可重试
 * - 收藏视图：卡片 = 预览 + 模块 Tag + 收藏时间 + 「取消收藏」（幂等直执不确认；成功失效
 *   favorites 查询 + 轻提示）；错题/难点卡的星标由 favorites 查询派生 Set 显态，点按切换
 *   add/remove 后失效 favorites（收藏列表未就位时不渲染星标，不显假未收藏态）
 * - 401 由 api client 全局回调接管（本页不特判）
 */

import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  CalendarClock,
  CircleX,
  FolderInput,
  RotateCcw,
  Star,
  StarOff,
  Trash,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  FavoriteSummary,
  ReinforceEntrySummary,
  WrongBookDisposeAction,
  WrongBookEntrySummary,
} from '@ncse/shared'
import {
  ApiError,
  addFavoriteApi,
  createPracticeSessionApi,
  disposeWrongBookApi,
  fetchFavoritesApi,
  fetchReinforceApi,
  fetchWrongBookApi,
  removeFavoriteApi,
} from '../../api'
import { Button, Card, Modal, Tag } from '../../components'
import { moduleDisplayName } from '../practice/modules'
import { practiceQueryKeys } from '../practice/practice-query-keys'
import { reviewQueryKeys } from './review-query-keys'
import './review.css'

/** 四视图标识：active 错题本 / hard 难点本 / reinforce 需加强 / favorites 收藏 */
type ReviewView = 'active' | 'hard' | 'reinforce' | 'favorites'

/** 错题本/难点本标识（列表查询 status，与 wrong_redo source 同取值） */
type BookStatus = 'active' | 'hard'

/** 待确认的处置：目标条目 + 动作（非 null 即确认弹窗打开） */
interface DisposalTarget {
  entry: WrongBookEntrySummary
  action: WrongBookDisposeAction
}

/** 操作反馈轻提示（success 轻提示 role=status / danger 错误条 role=alert，切视图即清） */
interface Feedback {
  tone: 'success' | 'danger'
  text: string
}

/** 重做/强化弹窗题数选项（与 shared CreatePracticeSessionRequest.count 契约一致，勿单方扩值） */
const COUNT_OPTIONS = [5, 10, 20, 30] as const
/** 默认题数（§1：表单默认值给足） */
const DEFAULT_COUNT = 10
/** 列表 staleTime：30s（条目仅经本人作答/处置/收藏变更；各 mutation 成功均 invalidate 兜底） */
const LIST_STALE_TIME = 30_000

/** Tab 定义（数组顺序即展示顺序，方向键漫游同序循环）：错题家族（错题本/难点本/需加强）在前，收藏殿后 */
const REVIEW_TABS: readonly { view: ReviewView; label: string }[] = [
  { view: 'active', label: '错题本' },
  { view: 'hard', label: '难点本' },
  { view: 'reinforce', label: '需加强' },
  { view: 'favorites', label: '收藏' },
]

/** ISO-8601 时间中文格式化（如「2026年10月13日 14:05」）；不可解析时原样回显（T1-08f 惯例） */
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

/** 操作失败消息：ApiError 透传后端消息（如 400 暂无可重做题目 / 404 该题不在错题本），其余给通用文案 */
function operationErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

/** 列表加载骨架（§6.8：bg-muted 圆角块 + 1.2s 呼吸动画；与实卡共用同一栅格，切换不跳版式） */
function ListSkeleton({ label }: { label: string }) {
  return (
    <div className="review-list" role="status" aria-label={label}>
      {[0, 1, 2].map((index) => (
        <div key={index} className="review-skeleton" aria-hidden="true">
          <div className="review-skeleton__line review-skeleton__line--head" />
          <div className="review-skeleton__line" />
          <div className="review-skeleton__line review-skeleton__line--short" />
        </div>
      ))}
    </div>
  )
}

/** 列表加载失败：danger-soft 提示条 + 重试（T1-08f 模式） */
function ListError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="review-list__error" role="alert">
      <p className="review-list__error-text">
        {operationErrorMessage(error, '列表加载失败，请稍后重试')}
      </p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  )
}

/** 列表空态（§6.8：图标 48px text-tertiary + 一句引导，T1-08f 模式） */
function ListEmpty({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="review-list-empty">
      <Icon className="review-list-empty__icon" aria-hidden="true" />
      <p className="review-list-empty__text">{text}</p>
    </div>
  )
}

interface WrongBookCardProps {
  entry: WrongBookEntrySummary
  /** 收藏星标显态；null = 收藏列表未就位（不渲染星标，不显假未收藏态） */
  favorited: boolean | null
  /** 收藏切换请求进行中（禁用星标防并发） */
  favoriteBusy: boolean
  onToggleFavorite: (questionId: number, favorited: boolean) => void
  onDispose: (entry: WrongBookEntrySummary, action: WrongBookDisposeAction) => void
}

/** 错题/难点条目卡：题干预览（两行截断）+ 模块 Tag + 计数 + 最近变化时间 + 星标/处置操作 */
function WrongBookCard({
  entry,
  favorited,
  favoriteBusy,
  onToggleFavorite,
  onDispose,
}: WrongBookCardProps) {
  return (
    <Card className="review-card">
      <div className="review-card__head">
        <Tag tone="primary">{moduleDisplayName(entry.moduleCode)}</Tag>
        {favorited !== null && (
          <button
            type="button"
            className={favorited ? 'review-card__star is-favorited' : 'review-card__star'}
            aria-label={favorited ? '取消收藏本题' : '收藏本题'}
            aria-pressed={favorited}
            disabled={favoriteBusy}
            onClick={() => onToggleFavorite(entry.questionId, favorited)}
          >
            <Star aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="review-card__stem">{entry.stemPreview}</p>
      <p className="review-card__stats">
        答错 <span className="review-card__count">{entry.wrongCount}</span> 次 · 重做{' '}
        <span className="review-card__count">{entry.redoCount}</span> 次
      </p>
      <div className="review-card__foot">
        <span className="review-card__time">
          <CalendarClock aria-hidden="true" />
          {formatDateTime(entry.updatedAt)}
        </span>
        <span className="review-card__actions">
          {entry.status === 'active' && (
            <Button
              variant="ghost"
              size="sm"
              icon={<FolderInput aria-hidden="true" />}
              onClick={() => onDispose(entry, 'to_hard')}
            >
              归难点本
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash aria-hidden="true" />}
            onClick={() => onDispose(entry, 'remove')}
          >
            移除
          </Button>
        </span>
      </div>
    </Card>
  )
}

/**
 * 需加强条目卡（M3/T3-01f）：模块 Tag + reason 标记（wrong 答错 danger / timeout 超时 warning，
 * §2.2 语义色成对）+ 题干预览（两行截断兜底照错题本先例）+ 最近汇入时间。
 * 全自动队列无任何用户处置动作（D8 定稿）：无移除/收藏按钮
 */
function ReinforceCard({ entry }: { entry: ReinforceEntrySummary }) {
  return (
    <Card className="review-card">
      <div className="review-card__head">
        <span className="review-card__tags">
          <Tag tone="primary">{moduleDisplayName(entry.moduleCode)}</Tag>
          {entry.reason === 'wrong' ? (
            <Tag tone="danger">答错</Tag>
          ) : (
            <Tag tone="warning">超时</Tag>
          )}
        </span>
      </div>
      <p className="review-card__stem">{entry.stemPreview}</p>
      <div className="review-card__foot">
        <span className="review-card__time">
          <CalendarClock aria-hidden="true" />
          {formatDateTime(entry.updatedAt)}
        </span>
      </div>
    </Card>
  )
}

interface FavoriteCardProps {
  entry: FavoriteSummary
  /** 本卡取消收藏请求进行中（按钮 loading） */
  removing: boolean
  /** 其他卡的取消请求进行中（防并发禁用） */
  disabled: boolean
  onRemove: (questionId: number) => void
}

/** 收藏条目卡：题干预览 + 模块 Tag + 收藏时间 + 取消收藏（幂等直执，无需确认） */
function FavoriteCard({ entry, removing, disabled, onRemove }: FavoriteCardProps) {
  return (
    <Card className="review-card">
      <div className="review-card__head">
        <Tag tone="primary">{moduleDisplayName(entry.moduleCode)}</Tag>
      </div>
      <p className="review-card__stem">{entry.stemPreview}</p>
      <div className="review-card__foot">
        <span className="review-card__time">
          <Star aria-hidden="true" />
          收藏于 {formatDateTime(entry.favoritedAt)}
        </span>
        <span className="review-card__actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<StarOff aria-hidden="true" />}
            loading={removing}
            disabled={disabled}
            onClick={() => onRemove(entry.questionId)}
          >
            取消收藏
          </Button>
        </span>
      </div>
    </Card>
  )
}

export function ReviewPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [view, setView] = useState<ReviewView>('active')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  // 重做弹窗：source 开弹窗时钉住（弹窗虽遮挡视图切换，显式持有更稳）；题数每次开重置默认 10
  const [redoSource, setRedoSource] = useState<BookStatus | null>(null)
  const [redoCount, setRedoCount] = useState<number>(DEFAULT_COUNT)
  // 强化练习弹窗（M3/T3-01f）：开关 state 与题数（每次开重置默认 10）
  const [reinforceOpen, setReinforceOpen] = useState(false)
  const [reinforceCount, setReinforceCount] = useState<number>(DEFAULT_COUNT)
  // 处置确认弹窗目标
  const [disposal, setDisposal] = useState<DisposalTarget | null>(null)

  // 错题本/难点本列表：仅对应视图激活时启用；status 分键缓存，Tab 来回切换秒开
  const bookStatus: BookStatus = view === 'hard' ? 'hard' : 'active'
  const wrongBookQuery = useQuery({
    queryKey: reviewQueryKeys.wrongBook(bookStatus),
    queryFn: () => fetchWrongBookApi(bookStatus),
    staleTime: LIST_STALE_TIME,
    enabled: view === 'active' || view === 'hard',
  })

  // 需加强清单（M3/T3-01f）：仅 pending（D8 定稿，resolved 后端支持但本期不做 UI）；仅该视图激活时启用
  const reinforceQuery = useQuery({
    queryKey: reviewQueryKeys.reinforce('pending'),
    queryFn: () => fetchReinforceApi('pending'),
    staleTime: LIST_STALE_TIME,
    enabled: view === 'reinforce',
  })

  // 收藏列表：收藏视图数据源 + 错题/难点卡星标显态来源（本页恒启用）
  const favoritesQuery = useQuery({
    queryKey: reviewQueryKeys.favorites,
    queryFn: fetchFavoritesApi,
    staleTime: LIST_STALE_TIME,
  })

  const redoMutation = useMutation({
    mutationFn: createPracticeSessionApi,
    onSuccess: (detail) => {
      // 作答页返回时列表不过期：建会话成功即失效会话列表，再跳作答页（T1-08f 同策略）
      void queryClient.invalidateQueries({ queryKey: practiceQueryKeys.sessions })
      setRedoSource(null)
      navigate(`/practice/sessions/${String(detail.id)}`)
    },
  })

  // 强化练习建会话（M3/T3-01f）：reinforce 分支（判别联合无 moduleCode）；成功后失效会话列表并跳作答页
  const reinforceMutation = useMutation({
    mutationFn: createPracticeSessionApi,
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: practiceQueryKeys.sessions })
      setReinforceOpen(false)
      navigate(`/practice/sessions/${String(detail.id)}`)
    },
  })

  const disposeMutation = useMutation({
    mutationFn: (variables: {
      questionId: number
      action: WrongBookDisposeAction
      /** 处置前所在账本（仅用于成功提示措辞；列表恒为查询指定状态，见 DTO 注释） */
      from: BookStatus
    }) => disposeWrongBookApi(variables.questionId, { action: variables.action }),
    onSuccess: (_result, variables) => {
      setDisposal(null)
      // active → hard 归置跨账本：按前缀失效双状态列表
      void queryClient.invalidateQueries({ queryKey: reviewQueryKeys.wrongBookAll })
      setFeedback({
        tone: 'success',
        text:
          variables.action === 'remove'
            ? `已移出${variables.from === 'hard' ? '难点本' : '错题本'}（计数保留，日后再答错会自动回到错题本）`
            : '已归入难点本，可在「难点本」视图继续跟进',
      })
    },
  })

  // 收藏切换（星标点按与收藏视图「取消收藏」共用）：favorited 为操作前状态，true → 本次取消
  const toggleFavoriteMutation = useMutation({
    mutationFn: (variables: { questionId: number; favorited: boolean }) =>
      variables.favorited
        ? removeFavoriteApi(variables.questionId)
        : addFavoriteApi(variables.questionId),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: reviewQueryKeys.favorites })
      // 收藏视图内取消给轻提示；错题/难点卡星标以图标填充态作即时反馈，不另起提示
      if (variables.favorited && view === 'favorites') {
        setFeedback({ tone: 'success', text: '已取消收藏' })
      }
    },
    onError: (error) => {
      setFeedback({
        tone: 'danger',
        text: operationErrorMessage(error, '收藏操作失败，请稍后重试'),
      })
    },
  })

  /** 切视图：清操作反馈（提示不跨视图残留） */
  const switchView = (next: ReviewView) => {
    setFeedback(null)
    setView(next)
  }

  /** Tab 方向键漫游（ARIA tabs：←/→ 循环切换选中并移动焦点，roving tabindex） */
  const tabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const order = REVIEW_TABS.map((tab) => tab.view)
    const index = order.indexOf(view)
    const next =
      event.key === 'ArrowRight'
        ? order[(index + 1) % order.length]
        : order[(index - 1 + order.length) % order.length]
    switchView(next)
    document.getElementById(`review-tab-${next}`)?.focus()
  }

  const openRedoModal = (source: BookStatus) => {
    setRedoCount(DEFAULT_COUNT)
    redoMutation.reset()
    setRedoSource(source)
  }
  const closeRedoModal = () => {
    // 提交中不允许关闭（Esc/遮罩/取消同走本函数），避免请求悬置后状态错乱（T1-08f 约定）
    if (redoMutation.isPending) return
    setRedoSource(null)
    redoMutation.reset()
  }
  const submitRedo = () => {
    if (redoSource === null || redoMutation.isPending) return
    redoMutation.mutate({ mode: 'wrong_redo', source: redoSource, count: redoCount })
  }

  const openReinforceModal = () => {
    setReinforceCount(DEFAULT_COUNT)
    reinforceMutation.reset()
    setReinforceOpen(true)
  }
  const closeReinforceModal = () => {
    // 提交中不允许关闭（Esc/遮罩/取消同走本函数，同重做弹窗约定）
    if (reinforceMutation.isPending) return
    setReinforceOpen(false)
    reinforceMutation.reset()
  }
  const submitReinforce = () => {
    if (reinforceMutation.isPending) return
    reinforceMutation.mutate({ mode: 'reinforce', count: reinforceCount })
  }

  const openDisposal = (entry: WrongBookEntrySummary, action: WrongBookDisposeAction) => {
    disposeMutation.reset()
    setDisposal({ entry, action })
  }
  const closeDisposal = () => {
    // 处置中不允许关闭（同 redo 弹窗约定）
    if (disposeMutation.isPending) return
    setDisposal(null)
    disposeMutation.reset()
  }
  const confirmDisposal = () => {
    if (disposal === null || disposeMutation.isPending) return
    disposeMutation.mutate({
      questionId: disposal.entry.questionId,
      action: disposal.action,
      from: disposal.entry.status === 'hard' ? 'hard' : 'active',
    })
  }

  const toggleFavorite = (questionId: number, favorited: boolean) => {
    if (toggleFavoriteMutation.isPending) return
    toggleFavoriteMutation.mutate({ questionId, favorited })
  }

  const entries = wrongBookQuery.data ?? []
  const favorites = favoritesQuery.data ?? []
  const reinforceEntries = reinforceQuery.data ?? []
  // 星标显态集合：收藏列表未就位（加载中/失败）为 null，卡片不渲染星标（不显假未收藏态）
  const favoriteIds =
    favoritesQuery.isSuccess ? new Set(favorites.map((favorite) => favorite.questionId)) : null
  // 列表空禁用重做（在册 0 条建会话必 400）；加载中数据未知一并禁用
  const redoDisabled = !wrongBookQuery.isSuccess || entries.length === 0
  // 列表空禁用强化练习（pending 0 条建会话必 400「需加强清单暂无待强化题目」）；加载中一并禁用
  const reinforceDisabled = !reinforceQuery.isSuccess || reinforceEntries.length === 0

  return (
    <div className="review">
      <header className="review-hero">
        <h1 className="review-hero__title">错题本与收藏</h1>
        <p className="review-hero__desc">
          答错的题自动收录进错题本：重做消灭，或归难点本长期跟进；答错或超时的题自动汇入「需加强」，强化练习答对不超时即出队；收藏的题目集中在「收藏」视图。
        </p>
      </header>

      <div className="review-tabs" role="tablist" aria-label="复习视图" onKeyDown={tabsKeyDown}>
        {REVIEW_TABS.map((tab) => (
          <button
            key={tab.view}
            type="button"
            role="tab"
            id={`review-tab-${tab.view}`}
            aria-selected={view === tab.view}
            aria-controls={`review-panel-${tab.view}`}
            tabIndex={view === tab.view ? 0 : -1}
            className={view === tab.view ? 'review-tabs__tab is-active' : 'review-tabs__tab'}
            onClick={() => switchView(tab.view)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {feedback !== null && (
        <p
          className={
            feedback.tone === 'danger' ? 'review-note review-note--danger' : 'review-note'
          }
          role={feedback.tone === 'danger' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      )}

      {view === 'reinforce' ? (
        <section
          className="review-panel"
          role="tabpanel"
          id="review-panel-reinforce"
          aria-labelledby="review-tab-reinforce"
        >
          <div className="review-panel__head">
            <p className="review-panel__desc">
              {reinforceQuery.isSuccess && reinforceEntries.length > 0
                ? `共 ${reinforceEntries.length} 题 · `
                : ''}
              答错或超时的题自动汇入，强化练习答对且不超时即出队
            </p>
            <Button
              icon={<Zap aria-hidden="true" />}
              disabled={reinforceDisabled}
              onClick={openReinforceModal}
            >
              强化练习
            </Button>
          </div>

          {reinforceQuery.isPending && <ListSkeleton label="正在加载需加强清单" />}
          {reinforceQuery.isError && (
            <ListError
              error={reinforceQuery.error}
              onRetry={() => void reinforceQuery.refetch()}
            />
          )}
          {reinforceQuery.isSuccess && reinforceEntries.length === 0 && (
            <ListEmpty
              icon={Zap}
              text="暂无待强化题目——答错或超时（含答对但超时）的题会自动汇入"
            />
          )}
          {reinforceEntries.length > 0 && (
            <div className="review-list">
              {reinforceEntries.map((entry) => (
                <ReinforceCard key={entry.questionId} entry={entry} />
              ))}
            </div>
          )}
        </section>
      ) : view === 'favorites' ? (
        <section
          className="review-panel"
          role="tabpanel"
          id="review-panel-favorites"
          aria-labelledby="review-tab-favorites"
        >
          <div className="review-panel__head">
            <p className="review-panel__desc">
              {favoritesQuery.isSuccess && favorites.length > 0
                ? `共 ${favorites.length} 题 · `
                : ''}
              收藏的题目集中于此，按收藏时间排序
            </p>
          </div>

          {favoritesQuery.isPending && <ListSkeleton label="正在加载收藏列表" />}
          {favoritesQuery.isError && (
            <ListError
              error={favoritesQuery.error}
              onRetry={() => void favoritesQuery.refetch()}
            />
          )}
          {favoritesQuery.isSuccess && favorites.length === 0 && (
            <ListEmpty icon={Star} text="暂无收藏" />
          )}
          {favorites.length > 0 && (
            <div className="review-list">
              {favorites.map((entry) => (
                <FavoriteCard
                  key={entry.questionId}
                  entry={entry}
                  removing={
                    toggleFavoriteMutation.isPending &&
                    toggleFavoriteMutation.variables?.questionId === entry.questionId
                  }
                  disabled={
                    toggleFavoriteMutation.isPending &&
                    toggleFavoriteMutation.variables?.questionId !== entry.questionId
                  }
                  onRemove={(questionId) => toggleFavorite(questionId, true)}
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <section
          className="review-panel"
          role="tabpanel"
          id={`review-panel-${bookStatus}`}
          aria-labelledby={`review-tab-${bookStatus}`}
        >
          <div className="review-panel__head">
            <p className="review-panel__desc">
              {wrongBookQuery.isSuccess && entries.length > 0 ? `共 ${entries.length} 题 · ` : ''}
              {bookStatus === 'active'
                ? '答错的题自动收录于此，按最近变化排序'
                : '归难点本的题在此长期跟进，按最近变化排序'}
            </p>
            <Button
              icon={<RotateCcw aria-hidden="true" />}
              disabled={redoDisabled}
              onClick={() => openRedoModal(bookStatus)}
            >
              重做练习
            </Button>
          </div>

          {wrongBookQuery.isPending && (
            <ListSkeleton
              label={bookStatus === 'active' ? '正在加载错题本' : '正在加载难点本'}
            />
          )}
          {wrongBookQuery.isError && (
            <ListError
              error={wrongBookQuery.error}
              onRetry={() => void wrongBookQuery.refetch()}
            />
          )}
          {wrongBookQuery.isSuccess && entries.length === 0 && (
            <ListEmpty
              icon={bookStatus === 'active' ? CircleX : FolderInput}
              text={
                bookStatus === 'active'
                  ? '暂无错题——专项练习中答错的题会自动收录'
                  : '暂无难点——错题处置选「归难点本」后出现在这里'
              }
            />
          )}
          {entries.length > 0 && (
            <div className="review-list">
              {entries.map((entry) => (
                <WrongBookCard
                  key={entry.questionId}
                  entry={entry}
                  favorited={favoriteIds === null ? null : favoriteIds.has(entry.questionId)}
                  favoriteBusy={toggleFavoriteMutation.isPending}
                  onToggleFavorite={toggleFavorite}
                  onDispose={openDisposal}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* 重做弹窗（wrong_redo 建会话；题数四选一，提交中禁关闭） */}
      <Modal
        open={redoSource !== null}
        onClose={closeRedoModal}
        title={
          redoSource === null
            ? undefined
            : `重做「${redoSource === 'hard' ? '难点本' : '错题本'}」`
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeRedoModal} disabled={redoMutation.isPending}>
              取消
            </Button>
            <Button onClick={submitRedo} loading={redoMutation.isPending}>
              开始重做
            </Button>
          </>
        }
      >
        <div className="review-redo">
          {redoMutation.isError && (
            <p className="review-redo__error" role="alert">
              {operationErrorMessage(redoMutation.error, '创建重做练习失败，请稍后重试')}
            </p>
          )}
          <p className="review-redo__label" id="review-redo-count-label">
            题目数量
          </p>
          <div
            className="review-count"
            role="radiogroup"
            aria-labelledby="review-redo-count-label"
          >
            {COUNT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={redoCount === option}
                className={
                  redoCount === option
                    ? 'review-count__option is-selected'
                    : 'review-count__option'
                }
                disabled={redoMutation.isPending}
                onClick={() => setRedoCount(option)}
              >
                {option} 题
              </button>
            ))}
          </div>
          <p className="review-redo__hint">
            在册题目不足所选数量时，将按实际题量生成练习；题目按最近变化排序抽取。
          </p>
        </div>
      </Modal>

      {/* 强化练习弹窗（M3/T3-01f，reinforce 建会话；题数四选一形态同重做弹窗，提交中禁关闭） */}
      <Modal
        open={reinforceOpen}
        onClose={closeReinforceModal}
        title={reinforceOpen ? '强化练习' : undefined}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeReinforceModal}
              disabled={reinforceMutation.isPending}
            >
              取消
            </Button>
            <Button onClick={submitReinforce} loading={reinforceMutation.isPending}>
              开始强化
            </Button>
          </>
        }
      >
        <div className="review-redo">
          {reinforceMutation.isError && (
            <p className="review-redo__error" role="alert">
              {operationErrorMessage(reinforceMutation.error, '创建强化练习失败，请稍后重试')}
            </p>
          )}
          <p className="review-redo__label" id="review-reinforce-count-label">
            题目数量
          </p>
          <div
            className="review-count"
            role="radiogroup"
            aria-labelledby="review-reinforce-count-label"
          >
            {COUNT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={reinforceCount === option}
                className={
                  reinforceCount === option
                    ? 'review-count__option is-selected'
                    : 'review-count__option'
                }
                disabled={reinforceMutation.isPending}
                onClick={() => setReinforceCount(option)}
              >
                {option} 题
              </button>
            ))}
          </div>
          <p className="review-redo__hint">
            待强化题目不足所选数量时，将按实际题量生成练习；题目按最近汇入排序抽取，答对且不超时即出队。
          </p>
        </div>
      </Modal>

      {/* 处置确认弹窗（ADR-0010 语义说明；处置中禁关闭，失败留在弹窗内可重试） */}
      <Modal
        open={disposal !== null}
        onClose={closeDisposal}
        title={
          disposal === null
            ? undefined
            : disposal.action === 'to_hard'
              ? '归入难点本'
              : disposal.entry.status === 'hard'
                ? '移出难点本'
                : '移出错题本'
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeDisposal} disabled={disposeMutation.isPending}>
              取消
            </Button>
            <Button onClick={confirmDisposal} loading={disposeMutation.isPending}>
              {disposal?.action === 'to_hard' ? '归入难点本' : '确认移除'}
            </Button>
          </>
        }
      >
        {disposal !== null && (
          <div className="review-dispose">
            {disposeMutation.isError && (
              <p className="review-dispose__error" role="alert">
                {operationErrorMessage(disposeMutation.error, '处置失败，请稍后重试')}
              </p>
            )}
            <p className="review-dispose__stem">{disposal.entry.stemPreview}</p>
            <p className="review-dispose__text">
              {disposal.action === 'to_hard'
                ? '本题将从错题本移入难点本长期跟进；答错与重做计数保留，可随时在难点本中重做或移除。'
                : disposal.entry.status === 'hard'
                  ? '本题将从难点本移除：答错计数保留，日后再答错会自动回到错题本。'
                  : '本题将标记为已消灭（软移除）：答错计数保留，日后再答错会自动回到错题本。'}
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}
