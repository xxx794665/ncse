import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // base 取 .env.<mode> 的 VITE_BASE_PATH（GH Pages 项目页 /ncse/，见 apps/web/.env.production；
  // 缺省 '/'）。应用侧经 import.meta.env.BASE_URL 消费为 Router basename（src/main.tsx）。
  const { VITE_BASE_PATH } = loadEnv(mode, process.cwd(), 'VITE_BASE_PATH')
  const base = VITE_BASE_PATH || '/'
  return {
    base,
    plugins: [
      react(),
      // PWA（T1-14，F1-11）：主屏安装（Web App Manifest）+ 离线兜底（App Shell 缓存）。
      // registerType autoUpdate：插件自动补 skipWaiting/clientsClaim，新 SW 激活后自动重载页面；
      // 不做「发现新版本」提示弹窗（遗留：如需提示可接 registerSW 的 onNeedRefresh/onOfflineReady）。
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          id: base,
          name: 'ncse · 公务员考试练习',
          short_name: 'ncse',
          description: '公务员考试练习（自用备考平台）',
          lang: 'zh-CN',
          // start_url/scope 跟随 vite base（根路径部署为 '/'，避免硬编码与子路径部署脱钩）
          start_url: base,
          scope: base,
          display: 'standalone',
          // 颜色取 tokens.css 实际值：background_color = --color-bg-base 亮色 #FFFFFF；
          // theme_color 与 index.html 现有 meta theme-color 亮色默认（#FFFFFF）一致
          // （暗色由 index.html 内联脚本按主题切换 meta，manifest 静态值只能取其一，取亮色默认）。
          background_color: '#FFFFFF',
          theme_color: '#FFFFFF',
          // 图标：public/ 静态 PNG（生成脚本 apps/web/scripts/generate-pwa-icons.mjs）；
          // src 前缀 base 保证子路径部署时仍在 scope 内
          icons: [
            { src: `${base}pwa-192.png`, sizes: '192x192', type: 'image/png' },
            { src: `${base}pwa-512.png`, sizes: '512x512', type: 'image/png' },
            {
              src: `${base}pwa-maskable-192.png`,
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: `${base}pwa-maskable-512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // precache：Vite 构建产物（js/css/html，index.html 即 App Shell）。
          // PWA 图标与 manifest.webmanifest 由插件经 additionalManifestEntries 自动并入
          // 预缓存（includeManifestIcons 默认 true），glob 不再含 png/webmanifest 以免重复登记。
          globPatterns: ['**/*.{js,css,html}'],
          // 离线导航兜底：导航请求失败回退缓存的 index.html（SPA 壳可离线打开）；
          // /api/* 导航不回退（同域部署形态下也不给 API 伪造壳响应）
          navigateFallback: `${base}index.html`,
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              // 仅同源静态图片 SWR；API 请求一律不进 SW 缓存（跨域 API 与 /api/*
              // 同域形态都不匹配本规则，离线时 fetch 自然失败，走应用既有错误态）
              urlPattern: ({ sameOrigin, request }) =>
                sameOrigin && request.destination === 'image',
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'ncse-static-images',
                expiration: {
                  maxEntries: 64,
                  maxAgeSeconds: 30 * 24 * 60 * 60, // 30 天
                },
              },
            },
          ],
        },
      }),
    ],
  }
})
