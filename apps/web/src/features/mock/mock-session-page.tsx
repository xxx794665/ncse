/**
 * 整卷模考·作答页（T2-01d，/mock/sessions/:id，requiresAuth + internal）
 * - 顶栏：返回 /mock + 卷名（单行省略）+ 状态 Tag（进行中/已交卷/已放弃）+ 整卷总倒计时徽章
 *   （role="timer"、mono tabular-nums、m:ss；剩余 <5 分钟转 warning、归零转 danger；
 *   D5：整卷一表计时，无每题时限告警）
 * - 计时（D6 累计口径）：use-mock-timer 前端权威累计（基线 + 分段打点，隐藏暂停/可见续走），
 *   校准/60s 周期/暂停/交卷前四节奏上报（服务端 max 防回退幂等）；归零一次性触发强制收卷
 * - 答题卡：按模块分组（保快照序）数字钮跳题（未答描边/已答填充/当前高亮描边）；
 *   PC（≥1024px）右侧 sticky 侧栏常驻，移动端折叠为「答题卡」按钮开 Modal（移动 Sheet 形态照组件库）
 * - 作答：单题视图顺序作答（阅读流收窄 --layout-max-reading）；QuestionCard mode="mock"
 *   （D4：作答中无判分反馈、无答案解析——点选即提交即静默记录，选中态保留可改，upsert 幂等）；
 *   提交失败 danger 条提示（选项保持选中态，点击选项即重试）；点选串行化（同题在飞期间拦截连击，
 *   防乱序落库与显示不一致）
 * - 每题停留用时：当前题在场分段打点，切题/隐藏/提交时结算累进该题累计（Map<questionId, ms>），
 *   续考回显以服务端 answered.durationMs 为累计基线；提交携带累计绝对值钳 [0, MOCK_MAX_DURATION_MS)
 * - 续考恢复（D6）：进入取详情 → 计时基线 elapsedMs、answered 回显选中态与停留基线、
 *   当前题定位首道未答题（全答完定位末题）
 * - 交卷：确认 Modal（已答 N/M、未答提示、确认中禁关闭）→ 末次计时上报 → submit → 成功停计时，
 *   完成态用响应 MockSessionReport.summary 给摘要；倒计时归零自动交卷不经确认（时间到即定卷）
 * - 已交卷/已放弃回看：不启动计时，题面只读（选项无操作），顶部完成态 + 引导
 *   （「查看成绩单」跳 T2-01e 成绩单页 /mock/sessions/:id/report）
 * - 错误与边界：非数字 id / 404 → 占位式错误态 + 返回入口；其余加载失败 → 提示条 + 重试；
 *   401 由 api client 全局回调接管（本页不特判）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  LayoutGrid,
  ListChecks,
  Percent,
  Send,
  Timer,
} from 'lucide-react'
import type {
  MockQuestionDto,
  MockSessionDetail,
  MockSessionReport,
  MockSessionStatus,
  SubmitMockAnswerRequest,
  XingceModuleCode,
} from '@ncse/shared'
import { MOCK_MAX_DURATION_MS } from '@ncse/shared'
import {
  ApiError,
  fetchMockSessionApi,
  submitMockAnswerApi,
  submitMockSessionApi,
  updateMockTimerApi,
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
import { XINGCE_MODULE_NAMES } from '../practice/modules'
import { mockQueryKeys } from './mock-query-keys'
import { useMockTimer } from './use-mock-timer'
import './mock-session.css'

/** 会话详情 staleTime：30s（作答变更仅经本页发生，提交成功即 invalidate 兜底） */
const SESSION_STALE_TIME = 30_000
/** 倒计时 warning 阈值：剩余 <5 分钟（整卷口径，D5 无每题告警） */
const TIMER_WARN_MS = 5 * 60_000

/** 题目列表缺省回退：模块级常量保证引用稳定（下游 useMemo 依赖不逐渲染漂移） */
const EMPTY_QUESTIONS: MockQuestionDto[] = []

/** 交卷触发来源：手动确认 / 倒计时归零强制收卷 */
type SubmitReason = 'manual' | 'expired'

/** 答题卡分组：模块中文名 + 组内题目（保快照序的全局下标） */
interface SheetGroup {
  moduleCode: XingceModuleCode
  items: { index: number; question: MockQuestionDto }[]
}

/** 路由参数解析：正整数字符串 → number；否则 null（与后端「非数字 id 一律 404」同构，前端直接错误态） */
function parseSessionId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 首个未答题下标（续考落点）；全部已答时定位末题 */
function firstUnansweredIndex(detail: MockSessionDetail): number {
  const index = detail.questions.findIndex((question) => question.answered === null)
  return index === -1 ? Math.max(0, detail.questions.length - 1) : index
}

/** 会话状态 Tag 文案与色调 */
function statusTag(status: MockSessionStatus): { tone: TagTone; label: string } {
  if (status === 'submitted') return { tone: 'success', label: '已交卷' }
  if (status === 'abandoned') return { tone: 'muted', label: '已放弃' }
  return { tone: 'primary', label: '进行中' }
}

/** m:ss 单调计数（秒零填充，分钟不封顶上溢；同 practice 作答页口径） */
function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** 每题停留用时钳制（shared 契约：[0, MOCK_MAX_DURATION_MS) 整数毫秒） */
function clampDurationMs(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 0), MOCK_MAX_DURATION_MS - 1)
}

/** 停留段折入该题累计（钳制后写入；负段防御性归零） */
function accumulateDwell(durations: Map<number, number>, questionId: number, deltaMs: number): void {
  const accumulated = (durations.get(questionId) ?? 0) + Math.max(0, deltaMs)
  durations.set(questionId, clampDurationMs(accumulated))
}

/** 续考回显种子：服务端 answered 回显选中态（本地选择 Map 的初值） */
function seedSelections(detail: MockSessionDetail): Map<number, string> {
  const seeds = new Map<number, string>()
  for (const question of detail.questions) {
    if (question.answered !== null) seeds.set(question.id, question.answered.answer)
  }
  return seeds
}

/** 答题卡分组：按 moduleCode 首次出现顺序分组，组内保快照序（全局下标即题号-1） */
function groupByModule(questions: MockQuestionDto[]): SheetGroup[] {
  const groups: SheetGroup[] = []
  const byModule = new Map<XingceModuleCode, SheetGroup>()
  questions.forEach((question, index) => {
    let group = byModule.get(question.moduleCode)
    if (group === undefined) {
      group = { moduleCode: question.moduleCode, items: [] }
      byModule.set(question.moduleCode, group)
      groups.push(group)
    }
    group.items.push({ index, question })
  })
  return groups
}

/** 作答失败消息：ApiError 透传后端消息（400 已交卷/入参非法等），其余给通用文案 */
function answerErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '提交失败，请检查网络后重试'
}

/** 交卷失败消息：同上策略 */
function submitErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '交卷失败，请检查网络后重试'
}

/** 作答区加载骨架（§6.8：bg-muted 圆角块 + 呼吸动画；选项块高 44px 为 §7.1 定值） */
function SessionSkeleton() {
  return (
    <div className="mock-session-skeleton" role="status" aria-label="正在加载模考会话">
      <div className="mock-session-skeleton__line mock-session-skeleton__line--bar" aria-hidden="true" />
      <div className="mock-session-skeleton__card" aria-hidden="true">
        <div className="mock-session-skeleton__line mock-session-skeleton__line--stem" />
        <div className="mock-session-skeleton__line" />
        <div className="mock-session-skeleton__option" />
        <div className="mock-session-skeleton__option" />
        <div className="mock-session-skeleton__option" />
        <div className="mock-session-skeleton__option" />
      </div>
    </div>
  )
}

/** 答题卡（PC 侧栏与移动弹层共用）：按模块分组的数字钮网格，点击跳题 */
function AnswerSheet({
  groups,
  currentIndex,
  isAnswered,
  onJump,
}: {
  groups: SheetGroup[]
  currentIndex: number
  isAnswered: (question: MockQuestionDto) => boolean
  onJump: (index: number) => void
}) {
  return (
    <div className="mock-sheet">
      {groups.map((group) => (
        <section key={group.moduleCode} className="mock-sheet__group">
          <h3 className="mock-sheet__module">{XINGCE_MODULE_NAMES[group.moduleCode]}</h3>
          <div className="mock-sheet__grid">
            {group.items.map(({ index, question }) => {
              const answered = isAnswered(question)
              const current = index === currentIndex
              const classNames = [
                'mock-sheet__cell',
                answered ? 'is-answered' : '',
                current ? 'is-current' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <button
                  key={question.id}
                  type="button"
                  className={classNames}
                  title={`第 ${index + 1} 题`}
                  aria-label={`第 ${index + 1} 题（${answered ? '已答' : '未答'}${current ? '，当前题' : ''}）`}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => onJump(index)}
                >
                  {index + 1}
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

/** 交卷完成态：手动/强制收卷（有成绩单摘要）与回看（仅进度计数）共用 */
function CompletedPanel({
  detail,
  report,
  reason,
  onBack,
  onViewReport,
}: {
  detail: MockSessionDetail
  /** null = 回看进入（交卷响应不随详情下发，仅进度计数可见） */
  report: MockSessionReport | null
  /** null = 回看进入 */
  reason: SubmitReason | null
  onBack: () => void
  /** 查看成绩单（T2-01e 成绩单页 /mock/sessions/:id/report；abandoned 会话亦可取成绩单） */
  onViewReport: () => void
}) {
  const summary = report?.summary ?? null
  const answered = summary?.answered ?? detail.answeredCount
  const total = summary?.total ?? detail.total
  const accuracy =
    summary !== null && summary.answered > 0
      ? Math.round((summary.correct / summary.answered) * 100)
      : null
  // 放弃态与交卷态分派文案（回看进入时 reason 为 null，按详情状态区分）
  const abandoned = detail.status === 'abandoned'
  return (
    <Card className="mock-session-complete">
      <div className="mock-session-complete__head">
        <CircleCheck className="mock-session-complete__icon" aria-hidden="true" />
        <h2 className="mock-session-complete__title">{abandoned ? '模考已放弃' : '已交卷'}</h2>
      </div>
      <p className="mock-session-complete__desc">
        {abandoned
          ? '本场模考已被放弃。题面与作答可回看。'
          : reason === 'expired'
            ? '考试时间到，已自动收卷。题面与作答可回看，不可再修改。'
            : reason === 'manual'
              ? '交卷成功，成绩单已生成。题面与作答可回看，不可再修改。'
              : '本场模考已交卷。题面与作答可回看。'}
      </p>
      <div className="mock-session-complete__stats">
        <StatChip icon={ListChecks} value={`${answered}/${total}`} label="已答" />
        {summary !== null && (
          <StatChip icon={CircleCheck} tone="success" value={summary.correct} label="答对" />
        )}
        {accuracy !== null && (
          <StatChip icon={Percent} tone="primary" value={`${accuracy}%`} label="正确率" />
        )}
      </div>
      <div className="mock-session-complete__actions">
        <Button onClick={onBack}>返回整卷模考</Button>
        <Button variant="secondary" onClick={onViewReport}>
          查看成绩单
        </Button>
      </div>
    </Card>
  )
}

/** 作答页主体：按会话 id 键控重挂载（路由参数切换时全部页面态重置） */
function MockSessionView({ sessionId }: { sessionId: number }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const detailQuery = useQuery({
    queryKey: mockQueryKeys.session(sessionId),
    queryFn: () => fetchMockSessionApi(sessionId),
    staleTime: SESSION_STALE_TIME,
  })

  // 当前题下标（null = 待首到定位）；选项选中镜像（续考回显为种子，点选即更新）；
  // 本地已落库题集合（服务端确认过的提交，答题卡「已答」与进度计数口径）
  const [currentIndex, setCurrentIndex] = useState<number | null>(null)
  const [selections, setSelections] = useState<ReadonlyMap<number, string>>(new Map())
  const [submittedIds, setSubmittedIds] = useState<ReadonlySet<number>>(new Set())
  // 答题卡弹层（移动）与交卷确认弹窗开关
  const [sheetOpen, setSheetOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // 交卷成绩单（非 null 即交卷成功态）；触发来源（手动/强制，完成态文案分派）
  const [report, setReport] = useState<MockSessionReport | null>(null)
  const [submitReason, setSubmitReason] = useState<SubmitReason | null>(null)

  // 每题停留用时累计（绝对值口径，与服务端 MAX 防回退匹配）；当前停留段（null = 页面隐藏暂停）
  const durationsRef = useRef(new Map<number, number>())
  const dwellRef = useRef<{ questionId: number; since: number } | null>(null)
  // 当前题 id 最新引用（可见性回调读取——回调注册一次，不随切题重注册）
  const currentQuestionIdRef = useRef<number | null>(null)
  // 交卷一次性守卫（手动确认与归零强收互斥；onSettled 释放以允许失败后重试）
  const submitGuardRef = useRef(false)

  const detail = detailQuery.data

  // 数据首到：定位首个未答题 + 回显选中态种子（渲染期调整状态，哨兵模式同 practice 作答页 located）
  const [located, setLocated] = useState(false)
  if (detail !== undefined && !located) {
    setLocated(true)
    setCurrentIndex(firstUnansweredIndex(detail))
    setSelections(seedSelections(detail))
  }

  const questions = detail?.questions ?? EMPTY_QUESTIONS
  const currentQuestion = currentIndex === null ? undefined : questions[currentIndex]
  const currentQuestionId = currentQuestion?.id ?? null

  // 答题卡分组（模块分组保快照序）；questions 引用随 detail 变化，tick 重渲染不重算
  const groups = useMemo(() => groupByModule(questions), [questions])

  // 计时中 = 详情在考且本地未交卷（交卷成功即停表，不等 invalidate 回流）
  const inProgress = detail !== undefined && detail.status === 'in_progress' && report === null

  // 进度计数口径：服务端回显 + 本地已落库提交（提交失败不计——答题卡与交卷确认只反映已保存答案）
  const answeredCount = questions.filter(
    (question) => question.answered !== null || submittedIds.has(question.id),
  ).length

  // 续考回显：服务端停留用时作为该题累计基线并入（只补未累计过的题——
  // 本地累计可能已领先服务端回显（改答案前的停留段），不回灌倒退）
  useEffect(() => {
    if (detail === undefined) return
    for (const question of detail.questions) {
      if (question.answered !== null && !durationsRef.current.has(question.id)) {
        durationsRef.current.set(question.id, clampDurationMs(question.answered.durationMs))
      }
    }
  }, [detail])

  // 当前题切换：结算上一题停留段折入累计，为当前题开新段（往返切题重复进入重复累计）
  useEffect(() => {
    if (!inProgress || currentQuestionId === null) return
    const now = Date.now()
    const dwell = dwellRef.current
    if (dwell !== null && dwell.questionId !== currentQuestionId) {
      accumulateDwell(durationsRef.current, dwell.questionId, now - dwell.since)
    }
    dwellRef.current = { questionId: currentQuestionId, since: now }
  }, [inProgress, currentQuestionId])

  // 当前题 id 最新引用同步（可见性回调用）
  useEffect(() => {
    currentQuestionIdRef.current = currentQuestionId
  }, [currentQuestionId])

  // 页面隐藏暂停停留段（停留 = 在场口径，与整卷计时 D6 一致）；重新可见为当前题续段
  useEffect(() => {
    if (!inProgress) return
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        const dwell = dwellRef.current
        if (dwell !== null) {
          accumulateDwell(durationsRef.current, dwell.questionId, Date.now() - dwell.since)
          dwellRef.current = null
        }
      } else if (dwellRef.current === null) {
        const questionId = currentQuestionIdRef.current
        if (questionId !== null) {
          dwellRef.current = { questionId, since: Date.now() }
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [inProgress])

  /** 提交时结算本题当前停留段并返回累计绝对值（结算后重开段：继续停留继续累计，改答案再提交带最新值） */
  const measureQuestionDuration = (questionId: number): number => {
    const dwell = dwellRef.current
    if (dwell !== null && dwell.questionId === questionId) {
      const now = Date.now()
      accumulateDwell(durationsRef.current, questionId, now - dwell.since)
      dwellRef.current = { questionId, since: now }
    }
    return clampDurationMs(durationsRef.current.get(questionId) ?? 0)
  }

  // 计时上报（D6：上报失败容忍——中断下次按服务端基线续；服务端 max 防回退幂等）
  const handleTimerReport = useCallback(
    (elapsedMs: number, { keepalive }: { keepalive: boolean }) => {
      void updateMockTimerApi(sessionId, elapsedMs, { keepalive }).catch(() => undefined)
    },
    [sessionId],
  )

  const submitMutation = useMutation({
    mutationFn: () => submitMockSessionApi(sessionId),
    onSuccess: (result) => {
      setReport(result)
      setConfirmOpen(false)
      // 强制收卷时答题卡弹层可能正开着，一并收起
      setSheetOpen(false)
      // 列表（进行中消失）与详情（status 翻 submitted）都失效；历史区即时反映最新成绩单
      void queryClient.invalidateQueries({ queryKey: mockQueryKeys.sessions })
      void queryClient.invalidateQueries({ queryKey: mockQueryKeys.session(sessionId) })
      void queryClient.invalidateQueries({ queryKey: mockQueryKeys.history })
    },
  })
  const { mutate: runSubmit } = submitMutation

  // 强制收卷前向引用：timer hook 的 onExpire 需先于 finalizeSubmit 存在（getElapsedMs 由 hook 返回），
  // 用 ref 打破声明环；effect 同步最新实现（归零只能在 tick 起跑后发生，初始空实现不可达）
  const finalizeSubmitRef = useRef<(reason: SubmitReason) => void>(() => {})
  const handleExpire = useCallback(() => {
    finalizeSubmitRef.current('expired')
  }, [])

  const timer = useMockTimer({
    baselineMs: detail?.elapsedMs,
    totalMinutes: detail?.totalMinutes,
    running: inProgress,
    onReport: handleTimerReport,
    onExpire: handleExpire,
  })
  const { remainingMs: timerRemainingMs, getElapsedMs } = timer

  // 交卷公共入口：守卫一次性 → 末次计时上报（节奏④，尽力而为不阻断）→ submit mutation
  const finalizeSubmit = useCallback(
    (reason: SubmitReason) => {
      if (submitGuardRef.current) return
      submitGuardRef.current = true
      setSubmitReason(reason)
      const submit = () => {
        runSubmit(undefined, {
          onSettled: () => {
            submitGuardRef.current = false
          },
        })
      }
      const elapsedMs = getElapsedMs()
      if (elapsedMs === null) {
        submit()
        return
      }
      // 末次计时上报完成（或失败容忍——服务端已有此前周期上报的 max 值）后再交卷，避免已交卷 400 丢末段
      updateMockTimerApi(sessionId, elapsedMs)
        .catch(() => undefined)
        .then(submit)
    },
    [sessionId, getElapsedMs, runSubmit],
  )

  useEffect(() => {
    finalizeSubmitRef.current = finalizeSubmit
  }, [finalizeSubmit])

  const answerMutation = useMutation({
    mutationFn: (payload: SubmitMockAnswerRequest) => submitMockAnswerApi(sessionId, payload),
    onSuccess: (result) => {
      setSubmittedIds((prev) => {
        if (prev.has(result.questionId)) return prev
        const next = new Set(prev)
        next.add(result.questionId)
        return next
      })
      // detail 回流后 answered 回显就位；本地 submittedIds 补回流前的进度口径
      void queryClient.invalidateQueries({ queryKey: mockQueryKeys.session(sessionId) })
    },
  })

  /** 切题公共入口：清空上一次作答错误（错误不跨题残留） */
  const goTo = (index: number) => {
    answerMutation.reset()
    setCurrentIndex(index)
  }

  /** 答题卡跳题（弹层场景收起） */
  const jumpTo = (index: number) => {
    goTo(index)
    setSheetOpen(false)
  }

  /** 返回卷选页：先失效会话列表（已交卷会话返回后不出现）再跳转 */
  const backToMock = () => {
    void queryClient.invalidateQueries({ queryKey: mockQueryKeys.sessions })
    navigate('/mock')
  }

  const openConfirm = () => {
    // 开弹窗前清掉上一次交卷错误（错误不跨次残留）
    submitMutation.reset()
    setConfirmOpen(true)
  }
  const closeConfirm = () => {
    // 交卷请求进行中不允许关闭（Esc/遮罩/取消同走本函数），避免请求悬置后状态错乱
    if (submitMutation.isPending) return
    setConfirmOpen(false)
    submitMutation.reset()
  }

  if (detailQuery.isPending) {
    return (
      <div className="mock-session">
        <SessionSkeleton />
      </div>
    )
  }

  if (detailQuery.isError) {
    const error = detailQuery.error
    // 404（不存在/非本人）：占位式错误态 + 返回入口；其余：提示条 + 重试（practice 作答页模式）
    if (error instanceof ApiError && error.status === 404) {
      return (
        <EmptyPlaceholder
          title="模考不存在"
          description="这个模考会话可能已被删除，或不属于你的账号。"
          actionLabel="返回整卷模考"
          onAction={backToMock}
        />
      )
    }
    return (
      <div className="mock-session">
        <div className="mock-session-error" role="alert">
          <p className="mock-session-error__text">
            {error instanceof ApiError ? error.message : '会话加载失败，请稍后重试'}
          </p>
          <div className="mock-session-error__actions">
            <Button variant="secondary" size="sm" onClick={() => void detailQuery.refetch()}>
              重试
            </Button>
            <Button variant="ghost" size="sm" onClick={backToMock}>
              返回整卷模考
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // 以下 detail 必已就位（isPending/isError 已提前返回；undefined 守卫仅为类型收窄）
  if (detail === undefined || currentQuestion === undefined || currentIndex === null) return null
  const sessionDetail = detail

  const status = statusTag(sessionDetail.status)
  const isAnswered = (question: MockQuestionDto) =>
    question.answered !== null || submittedIds.has(question.id)

  // 倒计时显示：计时中读 hook 实时值，未启动/已交卷按详情静态折算
  const remainingMs =
    timerRemainingMs ?? sessionDetail.totalMinutes * 60_000 - sessionDetail.elapsedMs
  const timerTone: TagTone = !inProgress
    ? 'muted'
    : remainingMs <= 0
      ? 'danger'
      : remainingMs < TIMER_WARN_MS
        ? 'warning'
        : 'muted'
  // 剩余向上取整（59.x 秒显 1:00），归零封底 0:00
  const timerText = formatClock(Math.max(0, Math.ceil(remainingMs / 1000)))

  const progressPercent =
    sessionDetail.total > 0 ? Math.round((answeredCount / sessionDetail.total) * 100) : 0

  const busy = answerMutation.isPending
  const canGoPrev = currentIndex > 0
  const canGoNext = currentIndex < questions.length - 1

  /** 点选即提交（考试机打口径，少一次点击；改选再提交即改答案，upsert 幂等） */
  const selectOption = (key: string) => {
    // 在飞提交期间拦截连击：防同题乱序落库（后发先至会覆盖用户最终所见选择）
    if (!inProgress || busy) return
    answerMutation.reset()
    const questionId = currentQuestion.id
    // 本地选中态先行（提交失败也保留，danger 条提示后点击选项即重试）
    setSelections((prev) => new Map(prev).set(questionId, key))
    answerMutation.mutate({
      questionId,
      answer: key,
      durationMs: measureQuestionDuration(questionId),
    })
  }

  return (
    <div className="mock-session">
      <header className="mock-session__topbar">
        <Link
          to="/mock"
          className="mock-session__back"
          onClick={() => {
            // 返回后列表反映最新进度：失效会话列表
            void queryClient.invalidateQueries({ queryKey: mockQueryKeys.sessions })
          }}
        >
          <ArrowLeft aria-hidden="true" />
          <span>整卷模考</span>
        </Link>
        <h1 className="mock-session__title">{sessionDetail.paper.name}</h1>
        <Tag tone={status.tone}>{status.label}</Tag>
        {/* 整卷总倒计时（D5 无每题告警）；role="timer" 自带 live=off，逐秒变化不播报 */}
        <Tag
          tone={timerTone}
          icon={Timer}
          className="mock-session__timer"
          role="timer"
          aria-label="距交卷剩余时间"
        >
          <span className="mock-session__timer-value">{timerText}</span>
        </Tag>
      </header>

      {!inProgress && (
        <CompletedPanel
          detail={sessionDetail}
          report={report}
          reason={submitReason}
          onBack={backToMock}
          onViewReport={() => navigate(`/mock/sessions/${String(sessionId)}/report`)}
        />
      )}

      <div className="mock-session__layout">
        <div className="mock-session__main">
          <div className="mock-session__progress">
            <div
              className="mock-session__progress-track"
              role="progressbar"
              aria-valuenow={answeredCount}
              aria-valuemin={0}
              aria-valuemax={sessionDetail.total}
              aria-label={`${sessionDetail.paper.name}作答进度`}
            >
              <div
                className="mock-session__progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="mock-session__progress-text">
              已答 {answeredCount}/{sessionDetail.total}
            </span>
            {/* 移动端答题卡入口（PC 侧栏常驻，此钮 ≥1024px 隐藏） */}
            <Button
              variant="secondary"
              size="sm"
              className="mock-session__sheet-open"
              icon={<LayoutGrid aria-hidden="true" />}
              onClick={() => setSheetOpen(true)}
            >
              答题卡 {answeredCount}/{sessionDetail.total}
            </Button>
          </div>

          {answerMutation.isError && (
            <p className="mock-session__answer-error" role="alert">
              {answerErrorMessage(answerMutation.error)}（本次选择已保留，可点击选项重试）
            </p>
          )}

          {/* 已交卷回看：题面只读（无 onSelect，选项空操作；CSS 去掉悬停/指针暗示） */}
          <div className={inProgress ? undefined : 'mock-session__readonly'}>
            <QuestionCard
              index={currentIndex + 1}
              mode="mock"
              meta={<Tag tone="muted">{XINGCE_MODULE_NAMES[currentQuestion.moduleCode]}</Tag>}
              stem={<RichContentRenderer content={currentQuestion.stem} variant="stem" />}
              options={currentQuestion.options.map((option) => ({
                key: option.key,
                content: <RichContentRenderer content={option.content} variant="option" />,
              }))}
              selectedKey={selections.get(currentQuestion.id) ?? null}
              graded={false}
              onSelect={inProgress ? selectOption : undefined}
            />
          </div>

          <nav className="mock-session__nav" aria-label="题目导航">
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
              className="mock-session__nav-next"
              disabled={!canGoNext}
              onClick={() => goTo(currentIndex + 1)}
            >
              下一题
            </Button>
          </nav>

          {inProgress && (
            <div className="mock-session__submitbar">
              {/* 强制收卷失败等弹窗外错误：提示条 + 手动「交卷」重试入口 */}
              {submitMutation.isError && (
                <p className="mock-session__submit-error" role="alert">
                  {submitReason === 'expired' ? '考试时间到，自动收卷失败：' : ''}
                  {submitErrorMessage(submitMutation.error)}
                </p>
              )}
              <Button
                size="lg"
                className="mock-session__submit-btn"
                icon={<Send aria-hidden="true" />}
                loading={submitMutation.isPending}
                onClick={openConfirm}
              >
                交卷
              </Button>
            </div>
          )}
        </div>

        {/* PC 答题卡侧栏（<1024px 隐藏，移动端走弹层） */}
        <aside className="mock-session__aside">
          <Card
            className="mock-session__sheet"
            title="答题卡"
            extra={
              <span className="mock-session__sheet-count">
                {answeredCount}/{sessionDetail.total}
              </span>
            }
          >
            <AnswerSheet
              groups={groups}
              currentIndex={currentIndex}
              isAnswered={isAnswered}
              onJump={goTo}
            />
            {inProgress && (
              <Button
                className="mock-session__sheet-submit"
                icon={<Send aria-hidden="true" />}
                loading={submitMutation.isPending}
                onClick={openConfirm}
              >
                交卷
              </Button>
            )}
          </Card>
        </aside>
      </div>

      {/* 移动端答题卡弹层（Modal 移动 Sheet 形态照组件库）；footer 与侧栏对齐：
          计中仅进行中提供交卷（回看态弹层只作跳题索引） */}
      <Modal
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={`答题卡（已答 ${answeredCount}/${sessionDetail.total}）`}
        footer={
          inProgress ? (
            <>
              <span className="mock-session__sheet-count">
                未答 {sessionDetail.total - answeredCount} 题
              </span>
              <Button
                icon={<Send aria-hidden="true" />}
                loading={submitMutation.isPending}
                onClick={() => {
                  setSheetOpen(false)
                  openConfirm()
                }}
              >
                交卷
              </Button>
            </>
          ) : undefined
        }
      >
        <AnswerSheet
          groups={groups}
          currentIndex={currentIndex}
          isAnswered={isAnswered}
          onJump={jumpTo}
        />
      </Modal>

      {/* 交卷确认：已答/未答计数 + 不可修改提示；确认中禁关闭（Esc/遮罩/取消同拦截） */}
      <Modal
        open={confirmOpen}
        onClose={closeConfirm}
        title="确认交卷"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeConfirm}
              disabled={submitMutation.isPending}
            >
              继续作答
            </Button>
            <Button
              icon={<Send aria-hidden="true" />}
              loading={submitMutation.isPending}
              onClick={() => finalizeSubmit('manual')}
            >
              确认交卷
            </Button>
          </>
        }
      >
        <div className="mock-session-confirm">
          {submitMutation.isError && (
            <p className="mock-session-confirm__error" role="alert">
              {submitErrorMessage(submitMutation.error)}
            </p>
          )}
          <p className="mock-session-confirm__text">
            已答 {answeredCount}/{sessionDetail.total}，未答{' '}
            {Math.max(0, sessionDetail.total - answeredCount)} 题。
          </p>
          <p className="mock-session-confirm__text">交卷后不可修改答案，将按当前作答统一判分。</p>
        </div>
      </Modal>
    </div>
  )
}

export function MockSessionPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const sessionId = parseSessionId(id)

  // 非数字/非正整数 id：与后端「一律 404」同语义，前端直接错误态（不发请求）
  if (sessionId === null) {
    return (
      <EmptyPlaceholder
        title="模考不存在"
        description="模考链接无效：会话编号缺失或格式不正确。"
        actionLabel="返回整卷模考"
        onAction={() => navigate('/mock')}
      />
    )
  }

  // key 钉会话 id：切换会话时整页状态（下标/选择/停留累计/计时）重置
  return <MockSessionView key={sessionId} sessionId={sessionId} />
}
