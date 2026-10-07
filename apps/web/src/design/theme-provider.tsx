/**
 * ThemeProvider 与 useTheme（docs/design/设计规范.md §8 的 React 接线）
 * 对外契约：useTheme() 返回 { mode, resolved, setMode }；切换控件组件由 T0-04 实现
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  applyResolvedTheme,
  getSystemTheme,
  readStoredMode,
  resolveTheme,
  startThemeTransition,
  storeMode,
  subscribeSystemTheme,
} from './theme'
import type { ResolvedTheme, ThemeMode } from './theme'

/** 主题上下文值：当前模式、实际生效主题与切换入口 */
export interface ThemeContextValue {
  /** 用户所选模式（system / light / dark），默认 system */
  mode: ThemeMode
  /** 实际生效主题（light / dark） */
  resolved: ResolvedTheme
  /** 切换模式：立即全站生效（无刷新）并持久化到 localStorage */
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode())
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme())
  const resolved = resolveTheme(mode, systemTheme)

  // 系统偏好变化：mode=system 时经 resolved 立即跟随切换；mode 为 light/dark 时 resolved 不变，天然忽略（§8.2）
  useEffect(() => subscribeSystemTheme(setSystemTheme), [])

  // resolved 变化时写入 <html data-theme> 与 meta theme-color；
  // 仅当属性值真要变化时挂一次性过渡类——首挂载时内联脚本已写入同值，不会触发过渡（§8.2 FOUC）
  useEffect(() => {
    if (document.documentElement.getAttribute('data-theme') !== resolved) {
      startThemeTransition()
    }
    applyResolvedTheme(resolved)
  }, [resolved])

  const setMode = useCallback((next: ThemeMode) => {
    storeMode(next)
    setModeState(next)
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** 读取主题状态与切换入口；必须在 <ThemeProvider> 内使用 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme 必须在 <ThemeProvider> 内使用')
  }
  return ctx
}
