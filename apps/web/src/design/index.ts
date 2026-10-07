/** design 域出口：tokens（CSS 侧）+ 主题三态（TS 侧） */
export { ThemeProvider, useTheme } from './theme-provider'
export type { ThemeContextValue } from './theme-provider'
export {
  THEME_STORAGE_KEY,
  isThemeMode,
  readStoredMode,
  resolveTheme,
} from './theme'
export type { ResolvedTheme, ThemeMode } from './theme'
