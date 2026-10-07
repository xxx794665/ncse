/**
 * 主题三态循环切换按钮（设计规范 §8.2：system → light → dark → system，图标即当前 mode）
 * 图标约定：Monitor=跟随系统 / Sun=亮 / Moon=暗（§6.4、§8.2）
 */

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../design'
import type { ThemeMode } from '../design'
import './theme-mode-button.css'

const MODE_CYCLE: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const MODE_ICON: Record<ThemeMode, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

const MODE_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
}

export function ThemeModeCycleButton() {
  const { mode, setMode } = useTheme()
  const Icon = MODE_ICON[mode]
  const next = MODE_CYCLE[mode]
  return (
    <button
      type="button"
      className="ncse-theme-cycle"
      onClick={() => setMode(next)}
      aria-label={`主题：${MODE_LABEL[mode]}，点击切换为${MODE_LABEL[next]}`}
      title={`主题：${MODE_LABEL[mode]} → ${MODE_LABEL[next]}`}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}
