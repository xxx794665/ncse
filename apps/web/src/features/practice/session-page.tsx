/**
 * 专项刷题·作答页（T1-08g，/practice/sessions/:id，requiresAuth + internal）
 * - 单题视图 + 顺序作答：顶部返回 /practice + 模块名 + 进度条（mono 计数）+ 会话状态 Tag；
 *   当前题 QuestionCard；底部 上一题/下一题（已答可回看，边界禁用）
 * - 作答流：选项选中 →「提交答案」（未选禁用）→ useMutation 判分 → QuestionCard graded
 *   （correctKey=响应 correctAnswer、analysis=RichContentRenderer 解析、判分后自动展开）；
 *   答对/答错/超时 Tag 放卡片 meta 槽（续做回显题无答案行，meta 槽保证对错可见且无需展开解析）
 * - 判分数据持有：判分响应（correctAnswer/analysis 等 detail 不下发字段）存页面本地 Map
 *   （questionId → {answer, result}），提交成功后 invalidate session(id)——detail 回带 answered，
 *   本地记录只补解析与正确键
 * - 续做回显：answered 非 null 直接 graded；isCorrect true 时 correctKey=answered.answer，
 *   false 时 correctKey=undefined（正确项与解析未随 detail 下发，所选显误选态，不伪造数据——已知边界）
 * - durationMs：每题「首次成为当前题」打激活时间戳（导航往返不重置），提交时取差值钳 [0, 86400000)
 * - 每题倒计时（T1-09）：未判分当前题在进度条行尾显示 mm:ss（复用 activatedAt 同一份打点，
 *   墙钟重算不累计、挂后台不暂停、切回续扣；时限锚 shared 默认蓝图，与服务端 isTimeout 同锚）；
 *   临尾 min(10s, 时限/4) 转 warning，超时转 danger「已超时 +m:ss」+ role="alert" 播报一次
 *   （F1-6：不自动跳题、不阻断提交）；已判分/会话完成/模块无时限时不显示也不跑表
 * - 错题处置（ADR-0010）：判分响应 wrongBook 非 null 且 status==='active' 且答对 → 处置弹窗
 *   （移除 / 归难点本 / 保持）；处置失败弹窗内提示可重试，成功轻提示条
 * - 完成态：status==='finished' 或全部已答 → 顶部完成小结（已答/答对/正确率/超时 + 返回模块选择），
 *   下方题目仍可回看；返回前 invalidate 会话列表（已完成会话不出现）
 * - 错误与边界：非数字 id / 404 → 占位式错误态 + 返回入口；其余加载失败 → 提示条 + 重试（T1-08f 模式）；
 *   401 由 api client 全局回调接管（本页不特判）
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FolderInput,
  ListChecks,
  Percent,
  Timer,
  Trash,
} from 'lucide-react'
import type {
  PracticeQuestionDto,
  PracticeSessionDetail,
  PracticeSessionStatus,
  SubmitPracticeAnswerRequest,
  SubmitPracticeAnswerResponse,
  WrongBookDisposeAction,
} from '@ncse/shared'
import { DEFAULT_BLUEPRINT, deriveQuestionTimeLimit } from '@ncse/shared'
import {
  ApiError,
  disposeWrongBookApi,
  fetchPracticeSessionApi,
  submitPracticeAnswerApi,
} from '../../api'
import {
  Button,
  Card,
  EmptyPlaceholder,
  Modal,
  QuestionCard,
  RichContentRenderer,
  StatChip,
  Tag,
} from '../../components'
import type { TagTone } from '../../components'
import { moduleDisplayName } from './modules'
import { practiceQueryKeys } from './practice-query-keys'
import { useQuestionCountdown } from './use-question-countdown'
import './session.css'

/** durationMs 上界（shared SubmitPracticeAnswerRequest 契约：[0, 86400000) 整数毫秒） */
const MAX_DURATION_MS = 86_400_000
/** 会话详情 staleTime：30s（会话仅经本页作答变更，提交成功即 invalidate 兜底） */
const SESSION_STALE_TIME = 30_000

/** 页面本地判分记录：判分响应 + 提交时的用户选择（响应不回显所选，所选在 invalidate 回流前由本地补） */
interface LocalGrade {
  answer: string
  result: SubmitPracticeAnswerResponse
}

/** 单题展示视图：判分态三来源合并后的渲染输入（本地判分记录 > detail 续做回显 > 未答选择态） */
interface QuestionView {
  graded: boolean
  selectedKey: string | null
  correctKey: string | undefined
  /** null = 未作答（无对错语义） */
  isCorrect: boolean | null
  isTimeout: boolean
  analysis: ReactNode | undefined
}

/** 路由参数解析：正整数字符串 → number；否则 null（与后端「非数字 id 一律 404」同构，前端直接错误态） */
function parseSessionId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 首个未答题下标（续做落点）；全部已答时回落 0 */
function firstUnansweredIndex(detail: PracticeSessionDetail): number {
  const index = detail.questions.findIndex((question) => question.answered === null)
  return index === -1 ? 0 : index
}

/** 会话状态 Tag 文案与色调 */
function statusTag(status: PracticeSessionStatus): { tone: TagTone; label: string } {
  if (status === 'finished') return { tone: 'success', label: '已完成' }
  if (status === 'abandoned') return { tone: 'muted', label: '已放弃' }
  return { tone: 'primary', label: '进行中' }
}

/** m:ss 单调计数（秒零填充，分钟不封顶上溢；倒计时剩余与超时累计共用） */
function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** 合并单题视图（优先级见 QuestionView 注释） */
function buildQuestionView(
  question: PracticeQuestionDto,
  grade: LocalGrade | undefined,
  selection: string | undefined,
): QuestionView {
  if (grade !== undefined) {
    return {
      graded: true,
      selectedKey: grade.answer,
      correctKey: grade.result.correctAnswer,
      isCorrect: grade.result.isCorrect,
      isTimeout: grade.result.isTimeout,
      analysis: <RichContentRenderer content={grade.result.analysis} variant="analysis" />,
    }
  }
  const answered = question.answered
  if (answered !== null) {
    return {
      graded: true,
      selectedKey: answered.answer,
      // 续做回显边界：答对时正确键即所选；答错时正确答案与解析未随 detail 下发，
      // correctKey 置 undefined（所选显误选态、其余默认态），不伪造数据
      correctKey: answered.isCorrect ? answered.answer : undefined,
      isCorrect: answered.isCorrect,
      isTimeout: answered.isTimeout,
      analysis: undefined,
    }
  }
  return {
    graded: false,
    selectedKey: selection ?? null,
    correctKey: undefined,
    isCorrect: null,
    isTimeout: false,
    analysis: undefined,
  }
}

/** 提交时取本题用时：激活时间戳起计的差值取整，钳 [0, 86400000)（激活缺失兜底 0） */
function measureDurationMs(activatedAt: ReadonlyMap<number, number>, questionId: number): number {
  const startedAt = activatedAt.get(questionId)
  if (startedAt === undefined) return 0
  const elapsed = Math.round(Date.now() - startedAt)
  return Math.min(Math.max(elapsed, 0), MAX_DURATION_MS - 1)
}

/** 判分失败消息：ApiError 透传后端消息（如 400 answer 非选项键），其余给通用文案 */
function submitErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '提交失败，请检查网络后重试'
}

/** 处置失败消息：同上策略 */
function disposeErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '处置失败，请稍后重试'
}

/** 作答区加载骨架（§6.8：bg-muted 圆角块 + 呼吸动画；条高取所代表行的字号 token，选项块高 44px 为 §7.1 定值） */
function SessionSkeleton() {
  return (
    <div className="session-skeleton" role="status" aria-label="正在加载练习会话">
      <div className="session-skeleton__line session-skeleton__line--bar" aria-hidden="true" />
      <div className="session-skeleton__card" aria-hidden="true">
        <div className="session-skeleton__line session-skeleton__line--stem" />
        <div className="session-skeleton__line" />
        <div className="session-skeleton__option" />
        <div className="session-skeleton__option" />
        <div className="session-skeleton__option" />
        <div className="session-skeleton__option" />
      </div>
    </div>
  )
}

/** 完成小结（会话 finished 或全部已答）：本地判分记录 + detail 回显汇总，返回前失效会话列表 */
function SessionSummary({
  total,
  answeredCount,
  correctCount,
  timeoutCount,
  onBack,
}: {
  total: number
  answeredCount: number
  correctCount: number
  timeoutCount: number
  onBack: () => void
}) {
  const accuracy = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0
  return (
    <Card className="session-summary">
      <h2 className="session-summary__title">本次练习完成</h2>
      <div className="session-summary__stats">
        <StatChip icon={ListChecks} value={`${answeredCount}/${total}`} label="已答" />
        <StatChip icon={CircleCheck} tone="success" value={correctCount} label="答对" />
        <StatChip icon={Percent} tone="primary" value={`${accuracy}%`} label="正确率" />
        <StatChip icon={Timer} tone="warning" value={timeoutCount} label="超时" />
      </div>
      <div className="session-summary__actions">
        <Button onClick={onBack}>返回模块选择</Button>
      </div>
    </Card>
  )
}

/** 作答页主体：按会话 id 键控重挂载（路由参数切换时全部页面态重置） */
function SessionView({ sessionId }: { sessionId: number }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const detailQuery = useQuery({
    queryKey: practiceQueryKeys.session(sessionId),
    queryFn: () => fetchPracticeSessionApi(sessionId),
    staleTime: SESSION_STALE_TIME,
  })

  // 当前题下标（null = 待首到定位）；选项选择仅挂未答题；本地判分记录（解析/正确键唯一来源）
  const [currentIndex, setCurrentIndex] = useState<number | null>(null)
  const [selections, setSelections] = useState<ReadonlyMap<number, string>>(new Map())
  const [grades, setGrades] = useState<ReadonlyMap<number, LocalGrade>>(new Map())
  // 待处置的错题 questionId（非 null 即处置弹窗打开）；处置成功后的轻提示文案
  const [disposalQuestionId, setDisposalQuestionId] = useState<number | null>(null)
  const [disposalNote, setDisposalNote] = useState<string | null>(null)
  // 每题「首次成为当前题」的激活时间戳（导航往返不重置）
  const activatedAtRef = useRef(new Map<number, number>())

  const detail = detailQuery.data

  // 数据首到定位首个未答题（渲染期调整状态，哨兵模式同 QuestionCard 的 graded 自动展开）
  const [located, setLocated] = useState(false)
  if (detail !== undefined && !located) {
    setLocated(true)
    setCurrentIndex(firstUnansweredIndex(detail))
  }

  const questions = detail?.questions ?? []
  const currentQuestion = currentIndex === null ? undefined : questions[currentIndex]

  // 进度与完成态：本地判分记录 + detail 回显合并计数（提交后 invalidate 回流前 progress 即时正确）；
  // 提前到早退分支前计算——倒计时 hook 的 running 门需要 finished
  const answeredCount = questions.filter(
    (question) => grades.has(question.id) || question.answered !== null,
  ).length
  const correctCount = questions.filter((question) => {
    const grade = grades.get(question.id)
    return (grade?.result.isCorrect ?? question.answered?.isCorrect) === true
  }).length
  const timeoutCount = questions.filter((question) => {
    const grade = grades.get(question.id)
    return (grade?.result.isTimeout ?? question.answered?.isTimeout) === true
  }).length
  const finished =
    detail !== undefined &&
    (detail.status === 'finished' || (detail.total > 0 && answeredCount >= detail.total))

  // 当前题首次激活打点（提交计时起点；effect 幂等，Map.has 守卫导航往返不重置）
  useEffect(() => {
    if (currentQuestion === undefined) return
    if (!activatedAtRef.current.has(currentQuestion.id)) {
      activatedAtRef.current.set(currentQuestion.id, Date.now())
    }
  }, [currentQuestion])

  // 每题倒计时（T1-09）：时限锚 shared 默认蓝图（与服务端 isTimeout 同一推导，前端不写字面量卷型码）；
  // moduleCode 为 null 或模块不在蓝图 → undefined，倒计时整块不渲染、不跑定时器
  const questionTimeLimitSeconds =
    detail === undefined || detail.moduleCode === null
      ? undefined
      : deriveQuestionTimeLimit(DEFAULT_BLUEPRINT, detail.moduleCode)
  // 判分态两来源与 buildQuestionView 同口径：本地判分记录 或 detail 续做回显
  const currentGraded =
    currentQuestion !== undefined &&
    (currentQuestion.answered !== null || grades.has(currentQuestion.id))
  const remainingMs = useQuestionCountdown({
    questionId: currentQuestion?.id ?? null,
    limitSeconds: questionTimeLimitSeconds,
    running: !finished && !currentGraded,
    activatedAt: activatedAtRef,
  })

  // 超时一次播报（渲染期守卫式写入，同 located 哨兵模式）：每题首次观察到超时定稿文案，
  // 视觉隐藏 role="alert" 区内容变更即播；已播题（含切回）不重复，倒计时本身不挂 aria-live
  const [timeoutAnnouncedIds, setTimeoutAnnouncedIds] = useState<ReadonlySet<number>>(new Set())
  const [timeoutAlertText, setTimeoutAlertText] = useState<string | null>(null)
  if (
    remainingMs !== null &&
    remainingMs <= 0 &&
    currentQuestion !== undefined &&
    currentIndex !== null &&
    !timeoutAnnouncedIds.has(currentQuestion.id)
  ) {
    const announcedQuestionId = currentQuestion.id
    setTimeoutAnnouncedIds((prev) => new Set(prev).add(announcedQuestionId))
    setTimeoutAlertText(
      `第 ${currentIndex + 1} 题已超出建议用时，仍可继续作答并提交，本次用时会如实记录。`,
    )
  }

  const disposeMutation = useMutation({
    mutationFn: (variables: { questionId: number; action: WrongBookDisposeAction }) =>
      disposeWrongBookApi(variables.questionId, { action: variables.action }),
    onSuccess: (_result, variables) => {
      setDisposalQuestionId(null)
      setDisposalNote(
        variables.action === 'remove'
          ? '已移出错题本（计数保留，日后再答错会自动回到错题本）'
          : '已归入难点本，可在错题本中继续跟进',
      )
    },
  })

  const submitMutation = useMutation({
    mutationFn: (payload: SubmitPracticeAnswerRequest) =>
      submitPracticeAnswerApi(sessionId, payload),
    onSuccess: (result, variables) => {
      setGrades((prev) => new Map(prev).set(result.questionId, { answer: variables.answer, result }))
      // detail 回流后该题 answered 就位；本地记录补正确键与解析
      void queryClient.invalidateQueries({ queryKey: practiceQueryKeys.session(sessionId) })
      // 答对在册 active 题每次提示处置（ADR-0010；答错恒 active 不提示）
      if (result.isCorrect && result.wrongBook?.status === 'active') {
        disposeMutation.reset()
        setDisposalQuestionId(result.questionId)
      }
    },
  })

  /** 切题公共入口：清空处置提示与上一次提交错误（错误不跨题残留） */
  const goTo = (index: number) => {
    setDisposalNote(null)
    submitMutation.reset()
    setCurrentIndex(index)
  }

  /** 返回模块选择：先失效会话列表（已完成会话返回后不出现）再跳转 */
  const backToPractice = () => {
    void queryClient.invalidateQueries({ queryKey: practiceQueryKeys.sessions })
    navigate('/practice')
  }

  if (detailQuery.isPending) {
    return (
      <div className="session">
        <SessionSkeleton />
      </div>
    )
  }

  if (detailQuery.isError) {
    const error = detailQuery.error
    // 404（不存在/非本人/已删除）：占位式错误态 + 返回入口；其余：提示条 + 重试（T1-08f 模式）
    if (error instanceof ApiError && error.status === 404) {
      return (
        <EmptyPlaceholder
          title="练习不存在"
          description="这个练习会话可能已被删除，或不属于你的账号。"
          actionLabel="返回专项刷题"
          onAction={backToPractice}
        />
      )
    }
    return (
      <div className="session">
        <div className="session-error" role="alert">
          <p className="session-error__text">
            {error instanceof ApiError ? error.message : '会话加载失败，请稍后重试'}
          </p>
          <div className="session-error__actions">
            <Button variant="secondary" size="sm" onClick={() => void detailQuery.refetch()}>
              重试
            </Button>
            <Button variant="ghost" size="sm" onClick={backToPractice}>
              返回专项刷题
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // 以下 detail 必已就位（isPending/isError 已提前返回；undefined 守卫仅为类型收窄）
  if (detail === undefined || currentQuestion === undefined || currentIndex === null) return null
  const sessionDetail = detail

  const currentView = buildQuestionView(
    currentQuestion,
    grades.get(currentQuestion.id),
    selections.get(currentQuestion.id),
  )

  const progressPercent =
    sessionDetail.total > 0 ? Math.round((answeredCount / sessionDetail.total) * 100) : 0
  const status = statusTag(sessionDetail.status)
  const moduleName = moduleDisplayName(sessionDetail.moduleCode)

  // 倒计时展示态：临尾阈值 = min(10s, 时限/4)（取更小者）；≤0 为超时态（服务端 isTimeout 为
  // durationMs 严格大于时限，等于不算——显示侧按任务口径 ≤0 即转超时，两者最多差一个 tick）
  const countdownWarnThresholdMs =
    questionTimeLimitSeconds === undefined
      ? 0
      : Math.min(10_000, (questionTimeLimitSeconds * 1000) / 4)
  const countdownTone: TagTone =
    remainingMs === null || remainingMs > countdownWarnThresholdMs
      ? 'muted'
      : remainingMs > 0
        ? 'warning'
        : 'danger'
  // 剩余向上取整（10.x 秒显 0:10，归零转超时）；超时累计向下取整（+0:00 起步继续往上走）
  const countdownText =
    remainingMs === null
      ? ''
      : remainingMs > 0
        ? formatClock(Math.ceil(remainingMs / 1000))
        : `已超时 +${formatClock(Math.floor(-remainingMs / 1000))}`

  const busy = submitMutation.isPending
  const canGoPrev = currentIndex > 0 && !busy
  const canGoNext = currentIndex < questions.length - 1 && !busy
  const canSubmit = !currentView.graded && currentView.selectedKey !== null && !busy

  const selectOption = (key: string) => {
    if (currentView.graded || busy) return
    // 改选即清上一次提交错误（错误不跨选择残留）
    submitMutation.reset()
    setSelections((prev) => new Map(prev).set(currentQuestion.id, key))
  }

  const submitAnswer = () => {
    if (!canSubmit || currentView.selectedKey === null) return
    submitMutation.mutate({
      questionId: currentQuestion.id,
      answer: currentView.selectedKey,
      durationMs: measureDurationMs(activatedAtRef.current, currentQuestion.id),
    })
  }

  const closeDisposal = () => {
    // 处置请求进行中不允许关闭（同 T1-08f 建会话弹窗约定），避免请求悬置后状态错乱
    if (disposeMutation.isPending) return
    setDisposalQuestionId(null)
    disposeMutation.reset()
  }
  const disposePendingAction = disposeMutation.isPending
    ? disposeMutation.variables?.action
    : undefined
  const dispose = (action: WrongBookDisposeAction) => {
    if (disposalQuestionId === null || disposeMutation.isPending) return
    disposeMutation.mutate({ questionId: disposalQuestionId, action })
  }

  // 判分反馈标记放卡片 meta 槽：续做回显题无答案行（correctKey 缺省），meta 槽保证对错/超时无需展开解析即可见
  const questionMeta = currentView.graded ? (
    <span className="session-question-meta">
      {currentView.isCorrect === true && <Tag tone="success">答对</Tag>}
      {currentView.isCorrect === false && <Tag tone="danger">答错</Tag>}
      {currentView.isTimeout && (
        <Tag tone="warning" icon={Timer}>
          超时
        </Tag>
      )}
    </span>
  ) : undefined

  return (
    <div className="session">
      <header className="session-topbar">
        <Link to="/practice" className="session-topbar__back" onClick={() => {
          // 返回后列表反映最新进度：与「返回模块选择」同策略失效会话列表
          void queryClient.invalidateQueries({ queryKey: practiceQueryKeys.sessions })
        }}>
          <ArrowLeft aria-hidden="true" />
          <span>专项刷题</span>
        </Link>
        <h1 className="session-topbar__module">{moduleName}</h1>
        <Tag tone={status.tone}>{status.label}</Tag>
      </header>

      <div className="session-progress">
        <div
          className="session-progress__track"
          role="progressbar"
          aria-valuenow={answeredCount}
          aria-valuemin={0}
          aria-valuemax={sessionDetail.total}
          aria-label={`${moduleName}作答进度`}
        >
          <div className="session-progress__fill" style={{ width: `${progressPercent}%` }} />
        </div>
        <span className="session-progress__text">
          已答 {answeredCount}/{sessionDetail.total}
        </span>
        {/* 每题倒计时（T1-09）：仅未判分且有时限的当前题渲染；role="timer" 自带 live=off，逐秒变化不播报 */}
        {remainingMs !== null && (
          <Tag
            tone={countdownTone}
            icon={Timer}
            className="session-timer"
            role="timer"
            aria-label={remainingMs > 0 ? '本题剩余时间' : '本题超时时长'}
          >
            <span className="session-timer__value">{countdownText}</span>
          </Tag>
        )}
      </div>

      {/* 超时一次播报：视觉隐藏 assertive 区，每题首次超时写入一次（不逐秒重复、切回不重播） */}
      <p className="session-sr-only" role="alert">
        {timeoutAlertText ?? ''}
      </p>

      {/* 超时可见提示（F1-6：告警但不打断作答——不跳题、提交照常，用时如实上报由服务端判超时） */}
      {remainingMs !== null && remainingMs <= 0 && (
        <p className="session-timeout-note">
          <Timer aria-hidden="true" />
          <span>
            本题已超出建议用时（每题 {formatClock(questionTimeLimitSeconds ?? 0)}），
            可继续作答并提交，本次用时会如实记录。
          </span>
        </p>
      )}

      {finished && (
        <SessionSummary
          total={sessionDetail.total}
          answeredCount={answeredCount}
          correctCount={correctCount}
          timeoutCount={timeoutCount}
          onBack={backToPractice}
        />
      )}

      {disposalNote !== null && (
        <p className="session-note" role="status">
          {disposalNote}
        </p>
      )}

      <QuestionCard
        index={currentIndex + 1}
        meta={questionMeta}
        stem={<RichContentRenderer content={currentQuestion.stem} variant="stem" />}
        options={currentQuestion.options.map((option) => ({
          key: option.key,
          content: <RichContentRenderer content={option.content} variant="option" />,
        }))}
        selectedKey={currentView.selectedKey}
        correctKey={currentView.correctKey}
        graded={currentView.graded}
        onSelect={selectOption}
        analysis={currentView.analysis}
      />

      {!currentView.graded && (
        <div className="session-submit">
          {submitMutation.isError && (
            <p className="session-submit__error" role="alert">
              {submitErrorMessage(submitMutation.error)}
            </p>
          )}
          <Button
            size="lg"
            className="session-submit__button"
            disabled={!canSubmit}
            loading={submitMutation.isPending}
            onClick={submitAnswer}
          >
            提交答案
          </Button>
        </div>
      )}

      <nav className="session-actions" aria-label="题目导航">
        <Button
          variant="secondary"
          icon={<ChevronLeft aria-hidden="true" />}
          disabled={!canGoPrev}
          onClick={() => goTo(currentIndex - 1)}
        >
          上一题
        </Button>
        <Button
          variant="secondary"
          icon={<ChevronRight aria-hidden="true" />}
          className="session-actions__next"
          disabled={!canGoNext}
          onClick={() => goTo(currentIndex + 1)}
        >
          下一题
        </Button>
      </nav>

      <Modal
        open={disposalQuestionId !== null}
        onClose={closeDisposal}
        title="答对了，处置错题本条目"
        footer={
          <>
            <Button variant="ghost" onClick={closeDisposal} disabled={disposeMutation.isPending}>
              保持
            </Button>
            <Button
              variant="secondary"
              icon={<FolderInput aria-hidden="true" />}
              loading={disposePendingAction === 'to_hard'}
              disabled={disposeMutation.isPending}
              onClick={() => dispose('to_hard')}
            >
              归入难点本
            </Button>
            <Button
              icon={<Trash aria-hidden="true" />}
              loading={disposePendingAction === 'remove'}
              disabled={disposeMutation.isPending}
              onClick={() => dispose('remove')}
            >
              移出错题本
            </Button>
          </>
        }
      >
        <div className="session-dispose">
          {disposeMutation.isError && (
            <p className="session-dispose__error" role="alert">
              {disposeErrorMessage(disposeMutation.error)}
            </p>
          )}
          <p className="session-dispose__text">
            本题在你的错题本中，本次作答正确。你可以趁势处置这条错题记录：
          </p>
          <ul className="session-dispose__list">
            <li>移出错题本：标记为已消灭（答错计数保留，日后再答错会自动回到错题本）</li>
            <li>归入难点本：转入难点本长期跟进</li>
            <li>保持：不做处置，本题仍留在错题本</li>
          </ul>
        </div>
      </Modal>
    </div>
  )
}

export function PracticeSessionPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const sessionId = parseSessionId(id)

  // 非数字/非正整数 id：与后端「一律 404」同语义，前端直接错误态（不发请求）
  if (sessionId === null) {
    return (
      <EmptyPlaceholder
        title="练习不存在"
        description="练习链接无效：会话编号缺失或格式不正确。"
        actionLabel="返回专项刷题"
        onAction={() => navigate('/practice')}
      />
    )
  }

  // key 钉会话 id：切换会话时整页状态（下标/选择/判分记录/计时）重置
  return <SessionView key={sessionId} sessionId={sessionId} />
}
