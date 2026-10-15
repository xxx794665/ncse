/**
 * 每题倒计时 hook（T1-09）
 * - 锚点复用作答页既有 activatedAt「首次成为当前题」时间戳（不另立第二套打点）；
 *   剩余 = 时限 × 1000 − (Date.now() − activatedAt)，每 tick 用 Date.now() 重算
 *   （不累计加法，防漂移；挂后台不暂停，与服务端 durationMs 墙钟口径一致；切题往返按原时间戳续扣）
 * - 驱动：setInterval 250ms 一档（任务允许 250–500ms）；进入 effect 时先 setTimeout(0) 对齐一拍，
 *   避免激活/切回后等到首个 interval tick 才纠偏
 * - 停止即清表不空转：当前题已判分/会话完成（running=false）、无每题时限（limitSeconds=undefined）、卸载
 * - React 19 hooks lint 约束：Date.now() 只在异步回调读取（render 纯度）；换题重置走渲染期
 *   守卫式调整（同 session-page 的 located 哨兵模式），不在 effect 体同步 setState
 */

import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/** tick 间隔（ms）：250–500ms 档取 250，每秒数字翻转与临尾/超时切换最多滞后一拍 */
const COUNTDOWN_TICK_MS = 250

export interface UseQuestionCountdownOptions {
  /** 当前题 id（激活时间戳表的键）；null = 无当前题 */
  questionId: number | null
  /** 每题时限（秒）；undefined = 模块无时限（moduleCode 为 null 或不在蓝图）→ 不跑表 */
  limitSeconds: number | undefined
  /** 是否计时中：当前题未判分且会话未完成；false 即停表 */
  running: boolean
  /** 作答页既有激活时间戳表（导航往返不重置的那一份，与 durationMs 同锚） */
  activatedAt: RefObject<Map<number, number>>
}

/**
 * 返回当前题剩余毫秒（≤ 0 = 已超时，负值绝对值为已超时量）；不计时时返回 null。
 * 新激活（含首帧激活打点 effect 未跑、读不到时间戳）先按全额渲染，下一 tick 按真实剩余自愈。
 */
export function useQuestionCountdown({
  questionId,
  limitSeconds,
  running,
  activatedAt,
}: UseQuestionCountdownOptions): number | null {
  const active = running && questionId !== null && limitSeconds !== undefined
  const [remainingMs, setRemainingMs] = useState<number | null>(null)

  // 换题/停表即重置（渲染期守卫式调整）：新激活题先按全额，tick 后按时间戳重算纠偏
  const [prevActiveKey, setPrevActiveKey] = useState<number | null>(null)
  const activeKey = active ? questionId : null
  if (activeKey !== prevActiveKey) {
    setPrevActiveKey(activeKey)
    setRemainingMs(activeKey === null || limitSeconds === undefined ? null : limitSeconds * 1000)
  }

  useEffect(() => {
    if (!active || questionId === null || limitSeconds === undefined) return
    const currentQuestionId = questionId
    const limitMs = limitSeconds * 1000
    // 每 tick 用 Date.now() 重算剩余（不累计）；读不到打点按已用 0（全额）兜底
    const tick = () => {
      const startedAt = activatedAt.current.get(currentQuestionId)
      const elapsed = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt)
      setRemainingMs(limitMs - elapsed)
    }
    // 激活/切回即对齐一拍（异步回调），不等首个 interval tick
    const first = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, COUNTDOWN_TICK_MS)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [active, questionId, limitSeconds, activatedAt])

  return remainingMs
}
