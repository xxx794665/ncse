/**
 * 首页仪表盘骨架（T0-05）：问候 + 模块速记入口
 * 入口取自路由注册表（app-routes.ts，首页自身除外），未实现入口点击后进入统一占位页；
 * 「继续上次」「今日任务」等真实数据区由后续里程碑接入
 */

import { useNavigate } from 'react-router-dom'
import { Card, Tag } from '../../components'
import { APP_ROUTES } from '../../app-routes'
import './home-page.css'

/** 按当前小时给问候语（账号体系落地前不带称呼，F1-4 后接入昵称） */
function greetingByHour(hour: number): string {
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function HomePage() {
  const navigate = useNavigate()
  const entries = APP_ROUTES.filter((route) => route.kind !== 'home')

  return (
    <div className="home">
      <header className="home-hero">
        <h1 className="home-hero__title">{greetingByHour(new Date().getHours())}</h1>
        <p className="home-hero__desc">
          目标 2027 省考 · 各功能模块按里程碑陆续上线，未完成的入口先进入占位页。
        </p>
      </header>
      <div className="home-grid">
        {entries.map((route) => {
          const Icon = route.icon
          const go = () => navigate(route.path)
          return (
            <Card
              key={route.key}
              interactive
              className="home-entry"
              onClick={go}
              role="link"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  go()
                }
              }}
            >
              <div className="home-entry__head">
                <Icon className="home-entry__icon" aria-hidden="true" />
                <h2 className="home-entry__title">{route.title}</h2>
              </div>
              <p className="home-entry__desc">{route.summary ?? route.description}</p>
              <div className="home-entry__meta">
                {route.milestone ? (
                  <Tag tone="muted">里程碑 {route.milestone}</Tag>
                ) : (
                  <Tag tone="primary">M0 · 已可用</Tag>
                )}
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
