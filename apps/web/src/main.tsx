import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { ThemeProvider } from './design'
import './design/tokens.css'
import './design/base.css'

const queryClient = new QueryClient()

// PWA（T1-14，F1-11）：注册 Service Worker（App Shell 预缓存 + 离线导航兜底）。
// registerType=autoUpdate：新版本 SW 安装完成自动激活并重载页面（插件内置行为）；
// 不做更新提示弹窗（遗留：如需提示，在此接 onNeedRefresh/onOfflineReady 回调挂 Toast）。
// dev 下 VitePWA 默认不启用 SW，本调用为 no-op。
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <App />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
