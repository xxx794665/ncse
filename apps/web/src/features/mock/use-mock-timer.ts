/**
 * 整卷模考总倒计时 hook（T2-01d；D5 整卷一表计时、D6 累计口径）
 * - 口径（D6）：已用 = baseMs（服务端 elapsedMs 基线 + 已结算活跃段折叠值）
 *   + （当前活跃段 ? Date.now() - segStart : 0）；剩余 = totalMinutes × 60000 − 已用。
 *   前端权威累计、服务端 max 防回退：中断/切设备不烧时间（隐藏即暂停），续考按服务端基线恢复
 * - 分段打点：不依赖墙钟跨段——页面可见时打 segStart，隐藏时把该段折入 baseMs 并清零，
 *   重新可见再打下一段起点；每段独立，挂后台期间零累计
 * - 可见性联动选 visibilitychange 而非 blur+focus：blur 在页面仍可见时也会触发
 *   （切开发者工具/浏览器 UI 获焦/同屏切窗口），会误暂停累计；visibilitychange 恰好对应
 *   「页面不再可见」（切标签/最小化/锁屏/应用切后台），语义与「停留才计时」一致；
 *   卸载兜底用 pagehide（beforeunload 在移动端不可靠），keepalive 尽力上报
 * - 上报节奏：①进入会话拿到详情基线即校准上报一次；②计时中每 60s 周期上报
 *   （防长时间断电丢累计）；③暂停（隐藏/pagehide）即上报；④交卷前由页面调
 *   getElapsedMs() 取当前累计做末次上报。上报值恒为累计绝对值，幂等
 * - 归零（剩余 ≤ 0）一次性触发 onExpire（强制收卷，expiredRef 守卫不重复）；
 *   会话非 in_progress（running=false）不启动计时
 * - tick 间隔 250ms（同 practice 每题倒计时惯例）；Date.now() 只在 effect/事件回调读取（render 纯度）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { MOCK_MAX_DURATION_MS } from '@ncse/shared'

/** tick 间隔（ms）：250–500ms 档取 250，每秒数字翻转最多滞后一拍 */
const TICK_MS = 250
/** 周期上报间隔（ms）：60s，断电/崩溃最多丢一分钟累计 */
const REPORT_INTERVAL_MS = 60_000

/** 计时累计钳制：shared 契约区间 [0, MOCK_MAX_DURATION_MS) 整数毫秒 */
function clampElapsedMs(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 0), MOCK_MAX_DURATION_MS - 1)
}

export interface UseMockTimerOptions {
  /** 服务端计时基线（详情 elapsedMs，进入会话时取一次；undefined = 详情未就位，不启动） */
  baselineMs: number | undefined
  /** 开考锁定的整卷时长（分钟）；undefined = 详情未就位 */
  totalMinutes: number | undefined
  /** 是否计时中：仅 in_progress 且本地未交卷；已交卷/回看态 false → 不启动 */
  running: boolean
  /** 上报回调（当前累计绝对值）；keepalive=true 为页面卸载场景的尽力上报 */
  onReport: (elapsedMs: number, options: { keepalive: boolean }) => void
  /** 归零回调（强制收卷）；hook 内一次性守卫，不重复触发 */
  onExpire: () => void
}

export interface UseMockTimerResult {
  /** 剩余毫秒（≤ 0 = 已归零）；未启动（基线未就位/不计时）为 null，由页面按详情值兜底显示 */
  remainingMs: number | null
  /** 读取当前累计绝对值（交卷前末次上报用；未启动返回 null） */
  getElapsedMs: () => number | null
}

export function useMockTimer({
  baselineMs,
  totalMinutes,
  running,
  onReport,
  onExpire,
}: UseMockTimerOptions): UseMockTimerResult {
  // 累计基线（服务端基线 + 已折叠的活跃段）；null = 未初始化
  const baseRef = useRef<number | null>(null)
  // 当前活跃段起点时间戳；null = 暂停（页面隐藏/未初始化）
  const segStartRef = useRef<number | null>(null)
  // 归零一次性守卫（防重复强制收卷）
  const expiredRef = useRef(false)
  // 上次上报的墙钟时刻（周期上报节流）
  const lastReportAtRef = useRef(0)
  const [remainingMs, setRemainingMs] = useState<number | null>(null)

  /**
   * 初始化 + 校准上报（节奏①）：基线首到即折叠为本地基线并（可见时）打点当前活跃段。
   * 只取进入会话时的首个基线——之后 invalidate 回流的服务端值不回灌
   * （本地累计 ≥ 已上报值 ≥ 服务端值，回灌会让倒计时倒退）
   */
  useEffect(() => {
    if (!running || baselineMs === undefined) return
    if (baseRef.current !== null) return
    baseRef.current = clampElapsedMs(baselineMs)
    if (document.visibilityState === 'visible') {
      segStartRef.current = Date.now()
    }
    lastReportAtRef.current = Date.now()
    onReport(baseRef.current, { keepalive: false })
  }, [running, baselineMs, onReport])

  /**
   * 可见性联动 + 卸载兜底（节奏③）：隐藏即结算当前段折入基线并上报；
   * 重新可见打下一段起点（不跨段依赖墙钟）；pagehide 用 keepalive 尽力上报
   */
  useEffect(() => {
    if (!running) return
    const pause = (keepalive: boolean) => {
      if (baseRef.current === null) return
      const segStart = segStartRef.current
      if (segStart !== null) {
        baseRef.current = clampElapsedMs(baseRef.current + (Date.now() - segStart))
        segStartRef.current = null
      }
      onReport(baseRef.current, { keepalive })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        pause(false)
      } else if (!expiredRef.current && baseRef.current !== null && segStartRef.current === null) {
        segStartRef.current = Date.now()
      }
    }
    const onPageHide = () => pause(true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [running, onReport])

  /** 周期 tick：重算剩余（每 tick 用 Date.now() 重算不累计漂移）、周期上报（节奏②）、归零触发收卷 */
  useEffect(() => {
    if (!running || baselineMs === undefined || totalMinutes === undefined) return
    const totalMs = totalMinutes * 60_000
    const tick = () => {
      const base = baseRef.current
      if (base === null) return // 初始化 effect 同拍先跑，这里仅是类型收窄兜底
      const segStart = segStartRef.current
      const elapsed = clampElapsedMs(base + (segStart === null ? 0 : Date.now() - segStart))
      const remaining = totalMs - elapsed
      setRemainingMs(remaining)
      const now = Date.now()
      if (now - lastReportAtRef.current >= REPORT_INTERVAL_MS) {
        lastReportAtRef.current = now
        onReport(elapsed, { keepalive: false })
      }
      if (remaining <= 0 && !expiredRef.current) {
        expiredRef.current = true
        onExpire()
      }
    }
    // 进入 effect 先对齐一拍（异步回调），不等首个 interval tick
    const first = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, TICK_MS)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [running, baselineMs, totalMinutes, onReport, onExpire])

  /** 当前累计绝对值（交卷前末次上报用）；未启动返回 null */
  const getElapsedMs = useCallback((): number | null => {
    const base = baseRef.current
    if (base === null) return null
    const segStart = segStartRef.current
    return clampElapsedMs(base + (segStart === null ? 0 : Date.now() - segStart))
  }, [])

  return { remainingMs, getElapsedMs }
}
