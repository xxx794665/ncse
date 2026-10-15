/**
 * 应用根组件：路由全量注册（按 app-routes 注册表生成，单一权威来源）
 * - 实页：/ 首页仪表盘骨架、/design 组件库演示、/login 登录、/register 注册（T1-16）、
 *   /practice 专项刷题模块选择（T1-08f）、/practice/sessions/:id 专项刷题作答（T1-08g）、
 *   /review 错题/难点/收藏三视图（T1-10b）
 * - requiresAuth 路由（如 /practice）经 RequireAuth 守卫：restoring 加载态 / 匿名跳 /login
 * - 未实现功能按注册表统一渲染 EmptyPlaceholder（设计规范 §6.7）；未匹配路由 fallback NotFoundPage
 * - 全站套 AppLayout（PC TopNav / 移动 BottomTab + 主题三态控件）
 * - AuthProvider 挂 <Routes> 之上（位于 BrowserRouter 内，Provider 可用 useNavigate/useLocation）
 */

import { Route, Routes } from 'react-router-dom'
import { AppLayout } from './app-layout'
import { APP_ROUTES } from './app-routes'
import { AuthProvider } from './features/auth/auth-context'
import { LoginPage } from './features/auth/login-page'
import { RegisterPage } from './features/auth/register-page'
import { RequireAuth } from './features/auth/require-auth'
import { DesignDemoPage } from './features/design-demo/design-demo-page'
import { HomePage } from './features/home/home-page'
import { NotFoundPage, PlaceholderPage } from './features/placeholder/placeholder-page'
import { PracticePage } from './features/practice/practice-page'
import { PracticeSessionPage } from './features/practice/session-page'
import { ReviewPage } from './features/review/review-page'
import './app.css'

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route element={<AppLayout />}>
          {APP_ROUTES.map((route) => {
            if (route.kind === 'home') {
              return <Route key={route.key} index element={<HomePage />} />
            }
            if (route.kind === 'design') {
              return <Route key={route.key} path={route.path} element={<DesignDemoPage />} />
            }
            if (route.kind === 'login') {
              return <Route key={route.key} path={route.path} element={<LoginPage />} />
            }
            if (route.kind === 'register') {
              return <Route key={route.key} path={route.path} element={<RegisterPage />} />
            }
            if (route.kind === 'practice') {
              const page = <PracticePage />
              return (
                <Route
                  key={route.key}
                  path={route.path}
                  element={route.requiresAuth ? <RequireAuth>{page}</RequireAuth> : page}
                />
              )
            }
            if (route.kind === 'practice-session') {
              const page = <PracticeSessionPage />
              return (
                <Route
                  key={route.key}
                  path={route.path}
                  element={route.requiresAuth ? <RequireAuth>{page}</RequireAuth> : page}
                />
              )
            }
            if (route.kind === 'review') {
              const page = <ReviewPage />
              return (
                <Route
                  key={route.key}
                  path={route.path}
                  element={route.requiresAuth ? <RequireAuth>{page}</RequireAuth> : page}
                />
              )
            }
            const page = <PlaceholderPage route={route} />
            return (
              <Route
                key={route.key}
                path={route.path}
                element={route.requiresAuth ? <RequireAuth>{page}</RequireAuth> : page}
              />
            )
          })}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  )
}
