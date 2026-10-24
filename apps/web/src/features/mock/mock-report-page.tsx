/**
 * 整卷模考·成绩单页（T2-01e，/mock/sessions/:id/report，requiresAuth + internal）
 * - 数据：会话详情（session(id) 键，取卷名/总时长/elapsedMs/状态）+ 成绩单（report 键，
 *   定卷后从库重算、内容稳定，staleTime 5 分钟）双查询；交卷时间另经 history 列表反查
 *   （report/detail 均不含 submittedAt；abandoned 会话不入历史，反查不到时不显交卷时间，
 *   顶栏仅以状态 Tag 示「已放弃」）——历史查询不阻塞页面主渲染
 * - 结构（移动优先）：顶栏（返回作答页 +「成绩单」+ 状态 Tag + 交卷时间）→ 卷信息行 →
 *   总览 StatChip 行（答对/总数、正确率、已答/未答、超时、总用时）→ 模块分布卡栅格
 *   （正确率双色比例条 role=progressbar + 答对/超时/平均用时行）→ 逐题对错回顾
 *   （按模块分组小号网格：答对 success-soft / 答错 danger-soft 填充、未答描边、
 *   超时叠 warning 内环角标；纯展示不跳转，title 悬停明细，附四态图例）
 * - 派生口径（照 stats 页先例）：正确率 = correct/answered（answered=0 除零兜底「—」）；
 *   模块平均用时 = totalDurationMs/answered 取整秒（同样兜底）；总用时 = detail.elapsedMs
 *   取整秒显「X 分 Y 秒」；双色比例条以 answered 为满槽（未答题不占槽）
 * - 错误边界：report 400「会话未交卷」→ 占位引导回作答页；任一端 404 → 「模考不存在」占位；
 *   其余失败 → danger 提示条 + 重试（两查询同时重拉）；401 由 api client 全局回调接管
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CircleCheck, ListChecks, Percent, Timer, TimerOff } from 'lucide-react'
import type {
  MockModuleReport,
  MockReportQuestionItem,
  MockSessionStatus,
  XingceModuleCode,
} from '@ncse/shared'
import {
  ApiError,
  fetchMockHistoryApi,
  fetchMockReportApi,
  fetchMockSessionApi,
} from '../../api'
import { Button, Card, EmptyPlaceholder, StatChip, Tag } from '../../components'
import type { TagTone } from '../../components'
import { XINGCE_MODULE_NAMES } from '../practice/modules'
import { mockQueryKeys } from './mock-query-keys'
import './mock-report.css'

/** 会话详情 staleTime：30s（同作答页口径；定卷后 elapsedMs/status 不再变化） */
const DETAIL_STALE_TIME = 30_000
/** 成绩单 staleTime：5 分钟（定卷后从库重算结果稳定，低频回看足够新鲜） */
const REPORT_STALE_TIME = 5 * 60_000
/** 历史列表 staleTime：60s（仅反查交卷时间，不阻塞主渲染） */
const HISTORY_STALE_TIME = 60_000

/** 逐题回顾分组：模块中文名 + 组内题目（保快照序的全局题号下标） */
interface ReviewGroup {
  moduleCode: XingceModuleCode
  items: { index: number; item: MockReportQuestionItem }[]
}

/** 路由参数解析：正整数字符串 → number；否则 null（口径同作答页，与后端「非数字 id 一律 404」同构） */
function parseSessionId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 会话状态 Tag 文案与色调（同作答页口径） */
function statusTag(status: MockSessionStatus): { tone: TagTone; label: string } {
  if (status === 'submitted') return { tone: 'success', label: '已交卷' }
  if (status === 'abandoned') return { tone: 'muted', label: '已放弃' }
  return { tone: 'primary', label: '进行中' }
}

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

/** 平均用时显示：answered=0 兜底「—」；取整秒，不足 1 分钟显「N 秒」，否则「X 分 Y 秒」（stats 页先例） */
function formatAverageDuration(totalDurationMs: number, answered: number): string {
  if (answered <= 0) return '—'
  const totalSeconds = Math.round(totalDurationMs / answered / 1000)
  if (totalSeconds < 60) return `${String(totalSeconds)} 秒`
  return `${String(Math.floor(totalSeconds / 60))} 分 ${String(totalSeconds % 60)} 秒`
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

/** 逐题回顾分组：按 moduleCode 首次出现顺序分组，组内保快照序（全局下标即题号-1；同作答页答题卡分组） */
function groupReportQuestions(questions: MockReportQuestionItem[]): ReviewGroup[] {
  const groups: ReviewGroup[] = []
  const byModule = new Map<XingceModuleCode, ReviewGroup>()
  questions.forEach((item, index) => {
    let group = byModule.get(item.moduleCode)
    if (group === undefined) {
      group = { moduleCode: item.moduleCode, items: [] }
      byModule.set(item.moduleCode, group)
      groups.push(group)
    }
    group.items.push({ index, item })
  })
  return groups
}

/** 加载骨架（§6.8：bg-muted 圆角块 + 呼吸动画；总览徽章/模块卡/回顾卡各给形似占位） */
function ReportSkeleton() {
  return (
    <div className="mock-report-skeleton" role="status" aria-label="正在加载成绩单">
      <div className="mock-report-skeleton__chips" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="mock-report-skeleton__chip" />
        ))}
      </div>
      <div className="mock-report-skeleton__grid" aria-hidden="true">
        {[0, 1].map((index) => (
          <div key={index} className="mock-report-skeleton__card" />
        ))}
      </div>
      <div className="mock-report-skeleton__card mock-report-skeleton__card--tall" aria-hidden="true" />
    </div>
  )
}

/** 模块分布卡：模块名 + 作答计数 + 正确率双色比例条（答对 primary/答错 danger，stats 页先例）+ 派生统计行 */
function ModuleReportCard({ module }: { module: MockModuleReport }) {
  const name = XINGCE_MODULE_NAMES[module.moduleCode]
  const correctPct = module.answered > 0 ? (module.correct / module.answered) * 100 : 0
  return (
    <Card className="mock-report__module">
      <div className="mock-report__module-head">
        <h3 className="mock-report__module-name">{name}</h3>
        <span className="mock-report__module-answered">
          作答{' '}
          <span className="mock-report__num">
            {module.answered}/{module.total}
          </span>{' '}
          题
        </span>
      </div>
      <div
        className="mock-report__module-bar"
        role="progressbar"
        aria-valuenow={module.correct}
        aria-valuemin={0}
        aria-valuemax={module.answered}
        aria-label={`${name}答对占比`}
      >
        <div
          className="mock-report__module-seg mock-report__module-seg--correct"
          style={{ width: `${String(correctPct)}%` }}
        />
        <div
          className="mock-report__module-seg mock-report__module-seg--wrong"
          style={{ width: `${String(100 - correctPct)}%` }}
        />
      </div>
      {module.answered === 0 ? (
        <p className="mock-report__module-stats">本模块未作答</p>
      ) : (
        <p className="mock-report__module-stats">
          答对{' '}
          <span className="mock-report__num">
            {module.correct}/{module.answered}
          </span>
          {' · '}超时 <span className="mock-report__num">{module.timeoutCount}</span>
          {' · '}平均{' '}
          <span className="mock-report__num">
            {formatAverageDuration(module.totalDurationMs, module.answered)}
          </span>
        </p>
      )}
    </Card>
  )
}

/** 逐题回顾题钮（纯展示不跳转）：三态填充/描边 + 超时间内环角标，title 悬停明细 */
function ReportQuestionCell({
  index,
  item,
}: {
  index: number
  item: MockReportQuestionItem
}) {
  const state = item.isCorrect === null ? 'unanswered' : item.isCorrect ? 'correct' : 'wrong'
  const stateLabel = state === 'correct' ? '答对' : state === 'wrong' ? '答错' : '未答'
  // 未作答 durationMs 恒 0（契约），悬停明细不带用时
  const seconds = Math.round(item.durationMs / 1000)
  const title =
    state === 'unanswered'
      ? `第 ${String(index + 1)} 题 · 未答`
      : `第 ${String(index + 1)} 题 · ${stateLabel} · 用时 ${String(seconds)} 秒${
          item.isTimeout ? ' · 超时' : ''
        }`
  const classNames = [
    'mock-report__cell',
    `mock-report__cell--${state}`,
    item.isTimeout ? 'mock-report__cell--timeout' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <span className={classNames} title={title} aria-label={title}>
      {index + 1}
    </span>
  )
}

/** 成绩单主体：按会话 id 键控重挂载（路由参数切换时全部页面态重置） */
function MockReportView({ sessionId }: { sessionId: number }) {
  const navigate = useNavigate()
  const detailQuery = useQuery({
    queryKey: mockQueryKeys.session(sessionId),
    queryFn: () => fetchMockSessionApi(sessionId),
    staleTime: DETAIL_STALE_TIME,
  })
  const reportQuery = useQuery({
    queryKey: mockQueryKeys.report(sessionId),
    queryFn: () => fetchMockReportApi(sessionId),
    staleTime: REPORT_STALE_TIME,
  })
  // 交卷时间反查（不阻塞主渲染；abandoned 不入历史，查不到即不显）
  const historyQuery = useQuery({
    queryKey: mockQueryKeys.history,
    queryFn: fetchMockHistoryApi,
    staleTime: HISTORY_STALE_TIME,
  })

  const detail = detailQuery.data
  const report = reportQuery.data
  const submittedAt =
    historyQuery.data?.find((item) => item.id === sessionId)?.submittedAt ?? null

  // 逐题回顾分组（report.questions 引用随数据就绪变化，分组结果 useMemo 钉住）
  const reviewGroups = useMemo(() => groupReportQuestions(report?.questions ?? []), [report])

  const backToSession = () => navigate(`/mock/sessions/${String(sessionId)}`)
  const backToMock = () => navigate('/mock')

  // 404（任一端：会话不存在/非本人，防探测同文案）→ 占位式错误态 + 返回入口
  const notFound =
    (detailQuery.error instanceof ApiError && detailQuery.error.status === 404) ||
    (reportQuery.error instanceof ApiError && reportQuery.error.status === 404)
  if (notFound) {
    return (
      <EmptyPlaceholder
        title="模考不存在"
        description="这个模考会话可能已被删除，或不属于你的账号。"
        actionLabel="返回整卷模考"
        onAction={backToMock}
      />
    )
  }

  // report 400：会话未交卷（成绩单只对已定卷会话有意义）→ 引导回作答页
  if (reportQuery.error instanceof ApiError && reportQuery.error.status === 400) {
    return (
      <EmptyPlaceholder
        title="成绩单未生成"
        description="本场模考尚未交卷——交卷后总分、模块分布与逐题对错会展示在这里。"
        actionLabel="返回作答页"
        onAction={backToSession}
      />
    )
  }

  // 其余失败：提示条 + 重试（两查询同时重拉）
  if (detailQuery.isError || reportQuery.isError) {
    const error = detailQuery.error ?? reportQuery.error
    return (
      <div className="mock-report">
        <div className="mock-report__error" role="alert">
          <p className="mock-report__error-text">
            {error instanceof ApiError ? error.message : '成绩单加载失败，请稍后重试'}
          </p>
          <div className="mock-report__error-actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void detailQuery.refetch()
                void reportQuery.refetch()
              }}
            >
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

  if (detailQuery.isPending || reportQuery.isPending) {
    return (
      <div className="mock-report">
        <ReportSkeleton />
      </div>
    )
  }

  // 以下 detail/report 必已就位（isPending/isError 已提前返回；undefined 守卫仅为类型收窄）
  if (detail === undefined || report === undefined) return null

  const summary = report.summary
  const status = statusTag(detail.status)

  return (
    <div className="mock-report">
      <header className="mock-report__topbar">
        <Link to={`/mock/sessions/${String(sessionId)}`} className="mock-report__back">
          <ArrowLeft aria-hidden="true" />
          <span>作答页</span>
        </Link>
        <h1 className="mock-report__title">成绩单</h1>
        <Tag tone={status.tone}>{status.label}</Tag>
        {submittedAt !== null && (
          <span className="mock-report__time">交卷于 {formatDateTime(submittedAt)}</span>
        )}
      </header>
      <p className="mock-report__paper">
        {detail.paper.name} · 全程 {detail.totalMinutes} 分钟
      </p>

      {/* 总览：五指标 StatChip 行（§6.6）；正确率除零兜底「—」 */}
      <div className="mock-report__summary">
        <StatChip
          icon={CircleCheck}
          tone="success"
          value={`${summary.correct}/${summary.total}`}
          label="答对/总数"
        />
        <StatChip
          icon={Percent}
          tone="primary"
          value={formatAccuracy(summary.correct, summary.answered)}
          label="正确率"
        />
        <StatChip
          icon={ListChecks}
          value={`${summary.answered}/${summary.unanswered}`}
          label="已答/未答"
        />
        <StatChip icon={TimerOff} tone="warning" value={summary.timeoutCount} label="超时" />
        <StatChip
          icon={Timer}
          tone="info"
          value={formatDurationMs(detail.elapsedMs)}
          label="总用时"
        />
      </div>

      <section className="mock-report__section" aria-labelledby="mock-report-modules">
        <div className="mock-report__section-head">
          <h2 id="mock-report-modules" className="mock-report__section-title">
            模块分布
          </h2>
          <p className="mock-report__section-desc">仅列卷内实际出现的模块</p>
        </div>
        <div className="mock-report__modules">
          {report.modules.map((module) => (
            <ModuleReportCard key={module.moduleCode} module={module} />
          ))}
        </div>
      </section>

      <section className="mock-report__section" aria-labelledby="mock-report-review">
        <div className="mock-report__section-head">
          <h2 id="mock-report-review" className="mock-report__section-title">
            逐题回顾
          </h2>
          {/* 四态图例：色块形态与题钮一致（填充/描边/超时间内环） */}
          <p className="mock-report__legend">
            <span className="mock-report__legend-item">
              <span
                className="mock-report__swatch mock-report__swatch--correct"
                aria-hidden="true"
              />
              答对
            </span>
            <span className="mock-report__legend-item">
              <span
                className="mock-report__swatch mock-report__swatch--wrong"
                aria-hidden="true"
              />
              答错
            </span>
            <span className="mock-report__legend-item">
              <span
                className="mock-report__swatch mock-report__swatch--unanswered"
                aria-hidden="true"
              />
              未答
            </span>
            <span className="mock-report__legend-item">
              <span
                className="mock-report__swatch mock-report__swatch--timeout"
                aria-hidden="true"
              />
              超时
            </span>
          </p>
        </div>
        <Card className="mock-report__review">
          {reviewGroups.map((group) => (
            <section key={group.moduleCode} className="mock-report__group">
              <h3 className="mock-report__group-name">
                {XINGCE_MODULE_NAMES[group.moduleCode]}
              </h3>
              <div className="mock-report__grid">
                {group.items.map(({ index, item }) => (
                  <ReportQuestionCell key={item.questionId} index={index} item={item} />
                ))}
              </div>
            </section>
          ))}
        </Card>
      </section>
    </div>
  )
}

export function MockReportPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const sessionId = parseSessionId(id)

  // 非数字/非正整数 id：与后端「一律 404」同语义，前端直接错误态（不发请求）
  if (sessionId === null) {
    return (
      <EmptyPlaceholder
        title="模考不存在"
        description="成绩单链接无效：会话编号缺失或格式不正确。"
        actionLabel="返回整卷模考"
        onAction={() => navigate('/mock')}
      />
    )
  }

  // key 钉会话 id：切换会话时页面态重置
  return <MockReportView key={sessionId} sessionId={sessionId} />
}
