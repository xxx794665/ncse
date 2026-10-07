import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // PWA 占位（T1-14 实现）：安装 vite-plugin-pwa 后在此追加
    // VitePWA({ registerType: 'autoUpdate', workbox: { ... } })，
    // 提供 App Shell 缓存与离线兜底。本任务不安装该依赖。
  ],
})
