/**
 * 主题三态核心逻辑（docs/design/设计规范.md §8 的纯函数部分，不依赖 React）
 * mode：用户可选模式（system/light/dark）；resolved：实际生效主题（light/dark）
 * index.html 的内联脚本（FOUC 防护）与本文件逻辑保持一致，改动需两边同步
 */

/** 用户可选主题模式（§8.1） */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 实际生效主题（§8.1） */
export type ResolvedTheme = 'light' | 'dark'

/** mode 的 localStorage 持久化键（§8.1）；未写入视为 system */
export const THEME_STORAGE_KEY = 'ncse-theme-mode'

/** 切换过渡类移除延迟（§8.2）：覆盖 --duration-normal 过渡并留余量 */
export const THEME_TRANSITION_MS = 600

/** <meta name="theme-color"> 随 resolved 取值（§8.2 定值：亮 #FFFFFF / 暗 #0F172A） */
const THEME_META_COLOR: Record<ResolvedTheme, string> = {
  light: '#FFFFFF',
  dark: '#0F172A',
}

/** 系统偏好媒体查询（§8.2） */
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** 读取持久化的 mode；未写入/非法值/localStorage 不可用时回落 system（§8.1 默认） */
export function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(stored) ? stored : 'system'
  } catch {
    // localStorage 不可用（隐私模式等）：按未写入处理，回落 system
    return 'system'
  }
}

/** 持久化 mode（§8.1）；localStorage 不可用时降级为仅本次会话生效并告警 */
export function storeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch (error) {
    console.warn('[theme] localStorage 不可用，主题偏好无法持久化', error)
  }
}

/** 系统偏好当前值 */
export function getSystemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? 'dark' : 'light'
}

/** mode → resolved（§8.1：system 时取系统偏好当前值，resolved 不落盘、每次实时求值） */
export function resolveTheme(mode: ThemeMode, systemTheme: ResolvedTheme): ResolvedTheme {
  return mode === 'system' ? systemTheme : mode
}

/** 订阅系统偏好变化；返回取消订阅函数（§8.2：仅 mode=system 时变化才会传导到 resolved） */
export function subscribeSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
  const mql = window.matchMedia(DARK_SCHEME_QUERY)
  const handler = (event: MediaQueryListEvent) => onChange(event.matches ? 'dark' : 'light')
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}

/** 把 resolved 写到 <html data-theme> 并同步 meta theme-color（§8.2） */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', resolved)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', THEME_META_COLOR[resolved])
  }
}

/** 挂一次性过渡类，THEME_TRANSITION_MS 后移除（§8.2，避免加载期过渡闪烁） */
export function startThemeTransition(): void {
  const root = document.documentElement
  root.classList.add('theme-transition')
  window.setTimeout(() => root.classList.remove('theme-transition'), THEME_TRANSITION_MS)
}
