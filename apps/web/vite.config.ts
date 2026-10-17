import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // base 取 .env.<mode> 的 VITE_BASE_PATH（GH Pages 项目页 /ncse/，见 apps/web/.env.production；
  // 缺省 '/'）。应用侧经 import.meta.env.BASE_URL 消费为 Router basename（src/main.tsx）。
  const { VITE_BASE_PATH } = loadEnv(mode, process.cwd(), 'VITE_BASE_PATH')
  return {
    base: VITE_BASE_PATH || '/',
    plugins: [
      react(),
      // PWA 占位（T1-14 实现）：安装 vite-plugin-pwa 后在此追加
      // VitePWA({ registerType: 'autoUpdate', workbox: { ... } })，
      // 提供 App Shell 缓存与离线兜底。本任务不安装该依赖。
    ],
  }
})
