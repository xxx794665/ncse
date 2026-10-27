/**
 * 统计页（T1-11b / M3 T3-01f，/stats，requiresAuth）
 * - useQuery 拉取 GET /api/stats/summary（staleTime 60s）：overall 全历史聚合 / modules 分模块
 *   （后端已过滤无记录模块、moduleCode 升序，直接渲染不零填）/ daily 近 STATS_TREND_DAYS 天
 *   北京时间日趋势（零填空、升序、今日在末）
 * - useQuery 拉取 GET /api/stats/knowledge（M3/T3-01d，同一 staleTime 60s）：分模块知识点掌握度
 *   一次性拉全量，模块卡展开/收起只是本地 state，不发新请求；mastery/needsReinforce 为服务端
 *   派生值（shared deriveMastery 口径），前端只展示勿重复计算；模块序/点序服务端已排好，保持原序
 * - 正确率与平均用时由前端派生（契约约定）：answered=0 除零兜底全页统一显「—」；
 *   平均用时按量级取整秒，不足 1 分钟显「N 秒」，否则「X 分 Y 秒」
 * - 三区结构：
 *   ① 总览：累计作答 / 总正确率 / 平均每题用时 / 累计超时（StatChip 行，§6.6）
 *   ② 分模块：每模块一卡（中文名经 moduleDisplayName 反查）+ 作答/正确率/平均/超时
 *      + 正确率双色比例条（答对 primary + 答错 danger，轨道 bg-muted，参照既有进度条写法）
 *      + 知识点掌握度下钻（M3/T3-01f）：卡底把手行展开/收起（形态照 §7.4 解析区先例）；
 *      每点一行 = 名称（needsReinforce 附 warning Tag「需加强」）+ mastery 百分比（一位小数）
 *      + mastery 比例条（需加强 warning 填充/否则 primary，轨道 bg-muted）
 *      + 作答/答对/正确率计数行（mono tabular-nums）；下钻区自带 pending 骨架 / error 重试 /
 *      「该模块暂无知识点作答数据」空态三态（局部兜底，不污染整页）
 *   ③ 近 30 天趋势：纯 div 手绘双色叠放柱状图（不引图表库）；柱高 = 当日作答量占窗口峰值比，
 *      零填空天零高度仅占位；容器 role=img 汇总描述 + 逐柱 title 悬停明细；
 *      x 轴首/末与约每 7 天稀疏标注「M/D」
 * - 三态反馈：pending 骨架（§6.8 呼吸动画，prefers-reduced-motion 关停）/ error 提示 + 重试 /
 *   overall.answered=0 空态引导去 /practice；401 由 api client 全局回调接管（本页不特判）
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ChartColumn, ChevronDown, ListChecks, ListTree, Percent, Timer, TimerOff } from 'lucide-react'
import { STATS_TREND_DAYS } from '@ncse/shared'
import type {
  KnowledgeMasteryPoint,
  KnowledgeMasteryResponse,
  PracticeDailyStat,
  PracticeModuleStat,
  PracticeOverallStats,
  XingceModuleCode,
} from '@ncse/shared'
import { ApiError, fetchStatsKnowledgeApi, fetchStatsSummaryApi } from '../../api'
import { Button, Card, StatChip, Tag } from '../../components'
import { moduleDisplayName } from '../practice/modules'
import { statsQueryKeys } from './stats-query-keys'
import './stats.css'

/** 统计查询 staleTime：60s（统计仅随本人作答变化，分钟级新鲜度足够；summary 与 knowledge 共用） */
const SUMMARY_STALE_TIME = 60_000

/** 计数格式化（zh-CN 千分位） */
const COUNT_FORMAT = new Intl.NumberFormat('zh-CN')

/** 百分比格式化（zh-CN percent 样式，保留一位小数） */
const PERCENT_FORMAT = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

/** 正确率显示：answered=0 除零兜底「—」（全页统一口径），否则一位小数百分比 */
function formatAccuracy(correct: number, answered: number): string {
  if (answered <= 0) return '—'
  return PERCENT_FORMAT.format(correct / answered)
}

/** 平均用时显示：answered=0 兜底「—」；取整秒，不足 1 分钟显「N 秒」，否则显「X 分 Y 秒」 */
function formatAverageDuration(totalDurationMs: number, answered: number): string {
  if (answered <= 0) return '—'
  const totalSeconds = Math.round(totalDurationMs / answered / 1000)
  if (totalSeconds < 60) return `${String(totalSeconds)} 秒`
  return `${String(Math.floor(totalSeconds / 60))} 分 ${String(totalSeconds % 60)} 秒`
}

/** 北京时间日 'YYYY-MM-DD' → 「M月D日」（字符串直拆，避免 Date 时区换算串日） */
function formatDayFull(date: string): string {
  const [, month, day] = date.split('-')
  return `${Number(month)}月${Number(day)}日`
}

/** 北京时间日 'YYYY-MM-DD' → 轴标注「M/D」 */
function formatDayShort(date: string): string {
  const [, month, day] = date.split('-')
  return `${Number(month)}/${Number(day)}`
}

/** 加载骨架（§6.8：bg-muted 圆角块 + 呼吸动画；三区各给形似的占位块） */
function StatsSkeleton() {
  return (
    <div role="status" aria-label="正在加载统计">
      <div className="stats-skeleton-chips" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="stats-skeleton stats-skeleton--chip" />
        ))}
      </div>
      <div className="stats-skeleton-modules" aria-hidden="true">
        {[0, 1].map((index) => (
          <div key={index} className="stats-skeleton stats-skeleton--card" />
        ))}
      </div>
      <div className="stats-skeleton stats-skeleton--chart" aria-hidden="true" />
    </div>
  )
}

/** 总览区：四指标 StatChip 行（§6.6；数值经统一派生格式化） */
function OverviewSection({ overall }: { overall: PracticeOverallStats }) {
  return (
    <section className="stats-section" aria-labelledby="stats-overview-title">
      <div className="stats-section__head">
        <h2 id="stats-overview-title" className="stats-section__title">
          总览
        </h2>
        <p className="stats-section__desc">全历史累计</p>
      </div>
      <div className="stats-overview">
        <StatChip
          icon={ListChecks}
          value={COUNT_FORMAT.format(overall.answered)}
          label="累计作答"
        />
        <StatChip
          icon={Percent}
          tone="primary"
          value={formatAccuracy(overall.correct, overall.answered)}
          label="总正确率"
        />
        <StatChip
          icon={Timer}
          tone="info"
          value={formatAverageDuration(overall.totalDurationMs, overall.answered)}
          label="平均每题用时"
        />
        <StatChip
          icon={TimerOff}
          tone="warning"
          value={COUNT_FORMAT.format(overall.timeoutCount)}
          label="累计超时"
        />
      </div>
    </section>
  )
}

/**
 * 知识点掌握度查询切片（M3/T3-01f）：模块卡下钻区只依赖三态 + 数据 + 重试，
 * 以窄接口传参（不绑死 React Query 具体类型）；响应一次性拉全量，展开不发新请求
 */
interface KnowledgeQuerySlice {
  isPending: boolean
  isError: boolean
  error: Error | null
  data: KnowledgeMasteryResponse | undefined
  refetch: () => Promise<unknown>
}

/**
 * 单知识点掌握度行（M3/T3-01f）：名称（needsReinforce 附 warning Tag「需加强」）
 * + mastery 一位小数百分比 + mastery 比例条（需加强 warning 填充、否则 primary，轨道 bg-muted，
 * 形态照 stats-module__bar 双色比例条先例）+ 作答/答对/正确率计数行（mono tabular-nums）。
 * mastery/needsReinforce 为服务端派生值，原样展示；点序保持服务端下发序
 */
function KnowledgePointRow({ point }: { point: KnowledgeMasteryPoint }) {
  const masteryPct = Math.round(point.mastery * 100)
  return (
    <li className="stats-point">
      <div className="stats-point__head">
        <span className="stats-point__name">
          {point.name}
          {point.needsReinforce && <Tag tone="warning">需加强</Tag>}
        </span>
        <span
          className={
            point.needsReinforce
              ? 'stats-point__mastery stats-point__mastery--warn'
              : 'stats-point__mastery'
          }
        >
          {PERCENT_FORMAT.format(point.mastery)}
        </span>
      </div>
      <div
        className="stats-point__bar"
        role="progressbar"
        aria-valuenow={masteryPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${point.name}掌握度`}
      >
        <div
          className={
            point.needsReinforce
              ? 'stats-point__fill stats-point__fill--warn'
              : 'stats-point__fill'
          }
          style={{ width: `${String(masteryPct)}%` }}
        />
      </div>
      <p className="stats-point__stats">
        作答 <span className="stats-point__num">{COUNT_FORMAT.format(point.totalCount)}</span>
        {' · '}答对 <span className="stats-point__num">{COUNT_FORMAT.format(point.correctCount)}</span>
        {' · '}正确率 <span className="stats-point__num">{PERCENT_FORMAT.format(point.accuracy)}</span>
      </p>
    </li>
  )
}

/**
 * 模块卡知识点掌握度下钻区（M3/T3-01f）：局部三态（pending 骨架 / error 提示 + 重试 /
 * 该模块无数据空态「该模块暂无知识点作答数据」），不污染整页；
 * 响应中无该模块（或整个响应为空）与 points 空数组同走空态
 */
function KnowledgeDrilldown({
  moduleCode,
  query,
}: {
  moduleCode: XingceModuleCode
  query: KnowledgeQuerySlice
}) {
  if (query.isPending) {
    return (
      <div className="stats-knowledge__skeleton" role="status" aria-label="正在加载知识点掌握度">
        {[0, 1, 2].map((index) => (
          <div key={index} className="stats-skeleton stats-skeleton--point" aria-hidden="true" />
        ))}
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="stats-knowledge__error" role="alert">
        <p className="stats-knowledge__error-text">
          {query.error instanceof ApiError
            ? query.error.message
            : '知识点掌握度加载失败，请稍后重试'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
          重试
        </Button>
      </div>
    )
  }
  const moduleData = query.data?.find((item) => item.module === moduleCode)
  if (moduleData === undefined || moduleData.points.length === 0) {
    return <p className="stats-knowledge__empty">该模块暂无知识点作答数据</p>
  }
  return (
    <ul className="stats-knowledge__list">
      {moduleData.points.map((point) => (
        <KnowledgePointRow key={point.knowledgePointId} point={point} />
      ))}
    </ul>
  )
}

/**
 * 分模块卡：模块名 + 作答数 + 正确率双色比例条 + 正确率/平均用时/超时计数
 * + 知识点掌握度下钻（M3/T3-01f，卡底把手行展开/收起，把手形态照 §7.4 解析区先例）
 */
function ModuleStatCard({
  stat,
  knowledgeQuery,
}: {
  stat: PracticeModuleStat
  knowledgeQuery: KnowledgeQuerySlice
}) {
  const [open, setOpen] = useState(false)
  const name = moduleDisplayName(stat.moduleCode)
  const correctPct = stat.answered > 0 ? (stat.correct / stat.answered) * 100 : 0
  const drillId = `stats-knowledge-${stat.moduleCode}`
  return (
    <Card className="stats-module">
      <div className="stats-module__head">
        <h3 className="stats-module__name">{name}</h3>
        <span className="stats-module__answered">
          作答 <span className="stats-module__num">{COUNT_FORMAT.format(stat.answered)}</span> 题
        </span>
      </div>
      <div
        className="stats-module__bar"
        role="progressbar"
        aria-valuenow={stat.correct}
        aria-valuemin={0}
        aria-valuemax={stat.answered}
        aria-label={`${name}答对占比`}
      >
        <div
          className="stats-module__seg stats-module__seg--correct"
          style={{ width: `${String(correctPct)}%` }}
        />
        <div
          className="stats-module__seg stats-module__seg--wrong"
          style={{ width: `${String(100 - correctPct)}%` }}
        />
      </div>
      <p className="stats-module__stats">
        正确率{' '}
        <span className="stats-module__num">{formatAccuracy(stat.correct, stat.answered)}</span>
        {' · '}平均{' '}
        <span className="stats-module__num">
          {formatAverageDuration(stat.totalDurationMs, stat.answered)}
        </span>
        {' · '}超时{' '}
        <span className="stats-module__num">{COUNT_FORMAT.format(stat.timeoutCount)}</span>
      </p>
      <div className="stats-module__drill">
        <button
          type="button"
          className="stats-module__drill-toggle"
          aria-expanded={open}
          aria-controls={drillId}
          onClick={() => setOpen((value) => !value)}
        >
          <ListTree aria-hidden="true" />
          <span>知识点掌握度</span>
          <ChevronDown
            className={
              open ? 'stats-module__drill-chevron is-open' : 'stats-module__drill-chevron'
            }
            aria-hidden="true"
          />
        </button>
        {open && (
          <div className="stats-knowledge" id={drillId}>
            <KnowledgeDrilldown moduleCode={stat.moduleCode} query={knowledgeQuery} />
          </div>
        )}
      </div>
    </Card>
  )
}

/** 趋势区：近 30 天双色叠放柱状图（纯 div；答对 primary 在下、答错 danger 在上） */
function TrendSection({ daily }: { daily: PracticeDailyStat[] }) {
  const totalAnswered = daily.reduce((sum, day) => sum + day.answered, 0)
  const totalCorrect = daily.reduce((sum, day) => sum + day.correct, 0)
  const maxAnswered = daily.reduce((max, day) => Math.max(max, day.answered), 0)
  const lastIndex = daily.length - 1
  /** 轴标注稀疏化：首/末恒显，其余约每 7 天一个（与末位至少隔 3 天防相邻标签重叠） */
  const showTick = (index: number): boolean =>
    index === 0 || index === lastIndex || (index % 7 === 0 && lastIndex - index >= 3)
  const summary =
    maxAnswered > 0
      ? `近 ${String(STATS_TREND_DAYS)} 天作答趋势柱状图：窗口内累计作答 ${String(totalAnswered)} 题、` +
        `答对 ${String(totalCorrect)} 题，单日最高 ${String(maxAnswered)} 题`
      : `近 ${String(STATS_TREND_DAYS)} 天作答趋势柱状图：窗口内暂无作答记录`

  return (
    <section className="stats-section" aria-labelledby="stats-trend-title">
      <div className="stats-section__head">
        <h2 id="stats-trend-title" className="stats-section__title">
          近 {STATS_TREND_DAYS} 天趋势
        </h2>
        <p className="stats-trend__legend">
          <span className="stats-trend__dot stats-trend__dot--correct" aria-hidden="true" />
          答对
          <span className="stats-trend__dot stats-trend__dot--wrong" aria-hidden="true" />
          答错
        </p>
      </div>
      <Card className="stats-trend">
        <div className="stats-trend__chart" role="img" aria-label={summary}>
          {daily.map((day) => {
            if (day.answered === 0) {
              // 零填空天：零高度仅占位列，不渲染柱体（无悬停目标）
              return <div key={day.date} className="stats-trend__col" />
            }
            const heightPct = (day.answered / maxAnswered) * 100
            const correctPct = (day.correct / day.answered) * 100
            const tip =
              `${formatDayFull(day.date)}：作答 ${String(day.answered)} · ` +
              `答对 ${String(day.correct)} · 正确率 ${formatAccuracy(day.correct, day.answered)}`
            return (
              <div key={day.date} className="stats-trend__col">
                <div className="stats-trend__bar" style={{ height: `${String(heightPct)}%` }} title={tip}>
                  <div
                    className="stats-trend__seg stats-trend__seg--wrong"
                    style={{ height: `${String(100 - correctPct)}%` }}
                  />
                  <div
                    className="stats-trend__seg stats-trend__seg--correct"
                    style={{ height: `${String(correctPct)}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
        <div className="stats-trend__axis" aria-hidden="true">
          {daily.map((day, index) => (
            <span key={day.date} className="stats-trend__tick">
              {showTick(index) ? formatDayShort(day.date) : ''}
            </span>
          ))}
        </div>
      </Card>
    </section>
  )
}

export function StatsPage() {
  const navigate = useNavigate()
  const summaryQuery = useQuery({
    queryKey: statsQueryKeys.summary,
    queryFn: fetchStatsSummaryApi,
    staleTime: SUMMARY_STALE_TIME,
  })
  // 知识点掌握度（M3/T3-01f）：与汇总同模式一次性拉全量（staleTime 60s），
  // 模块卡展开/收起仅本地 state，不发新请求；失败仅在下钻区内局部兜底
  const knowledgeQuery = useQuery({
    queryKey: statsQueryKeys.knowledge,
    queryFn: fetchStatsKnowledgeApi,
    staleTime: SUMMARY_STALE_TIME,
  })

  return (
    <div className="stats">
      <header className="stats-hero">
        <h1 className="stats-hero__title">统计</h1>
        <p className="stats-hero__desc">
          练习正确率、用时与模块分布一览（模块卡可展开查看知识点掌握度）；趋势按北京时间日聚合。
        </p>
      </header>

      {summaryQuery.isPending && <StatsSkeleton />}
      {summaryQuery.isError && (
        <div className="stats-error" role="alert">
          <p className="stats-error__text">
            {summaryQuery.error instanceof ApiError
              ? summaryQuery.error.message
              : '统计加载失败，请稍后重试'}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void summaryQuery.refetch()}>
            重试
          </Button>
        </div>
      )}
      {summaryQuery.isSuccess && summaryQuery.data.overall.answered === 0 && (
        <div className="stats-empty">
          <ChartColumn className="stats-empty__icon" aria-hidden="true" />
          <p className="stats-empty__text">
            还没有练习记录——完成任意练习后，正确率、用时与趋势会统计在这里。
          </p>
          <Button variant="secondary" onClick={() => void navigate('/practice')}>
            去专项刷题
          </Button>
        </div>
      )}
      {summaryQuery.isSuccess && summaryQuery.data.overall.answered > 0 && (
        <>
          <OverviewSection overall={summaryQuery.data.overall} />
          <section className="stats-section" aria-labelledby="stats-modules-title">
            <div className="stats-section__head">
              <h2 id="stats-modules-title" className="stats-section__title">
                分模块
              </h2>
              <p className="stats-section__desc">仅统计有作答记录的模块</p>
            </div>
            <div className="stats-modules">
              {summaryQuery.data.modules.map((stat) => (
                <ModuleStatCard key={stat.moduleCode} stat={stat} knowledgeQuery={knowledgeQuery} />
              ))}
            </div>
          </section>
          <TrendSection daily={summaryQuery.data.daily} />
        </>
      )}
    </div>
  )
}
