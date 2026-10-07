import { Route, Routes } from 'react-router-dom'
import type { AppInfo } from '@ncse/shared'

const appInfo: AppInfo = { name: 'ncse', phase: 'M0-脚手架' }

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage appInfo={appInfo} />} />
    </Routes>
  )
}

/** 占位首页：全量路由与占位页由 T0-05 起逐任务实现 */
function HomePage({ appInfo }: { appInfo: AppInfo }) {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>ncse · 公务员考试练习</h1>
      <p>占位首页（阶段：{appInfo.phase}）——设计系统与页面由后续任务（T0-02 起）实现。</p>
    </main>
  )
}
