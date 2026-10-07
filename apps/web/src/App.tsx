/**
 * 应用根组件（T0-05）：路由全量注册
 * - 实页：/ 首页仪表盘骨架、/design 组件库演示
 * - 未实现功能：按 app-routes 注册表统一渲染 EmptyPlaceholder（设计规范 §6.7）
 * - 未匹配路由 fallback 到统一占位（NotFoundPage）
 * - 全站套 AppLayout（PC TopNav / 移动 BottomTab + 主题三态控件）
 */

import { Route, Routes } from 'react-router-dom'
import { AppLayout } from './app-layout'
import { APP_ROUTES } from './app-routes'
import { DesignDemoPage } from './features/design-demo/design-demo-page'
import { HomePage } from './features/home/home-page'
import { NotFoundPage, PlaceholderPage } from './features/placeholder/placeholder-page'
import './app.css'

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        {APP_ROUTES.map((route) => {
          if (route.kind === 'home') {
            return <Route key={route.key} index element={<HomePage />} />
          }
          if (route.kind === 'design') {
            return <Route key={route.key} path={route.path} element={<DesignDemoPage />} />
          }
          return (
            <Route key={route.key} path={route.path} element={<PlaceholderPage route={route} />} />
          )
        })}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
