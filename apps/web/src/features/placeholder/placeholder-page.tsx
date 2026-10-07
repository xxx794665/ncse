/**
 * 统一占位页（T0-05）：未实现功能渲染 EmptyPlaceholder（设计规范 §6.7、ADR-0006）
 * 标题 + 一句说明 + 里程碑徽章（按 docs/功能清单.md M 阶段，见 app-routes.ts）+ 返回首页
 */

import { useNavigate } from 'react-router-dom'
import { EmptyPlaceholder } from '../../components'
import type { AppRoute } from '../../app-routes'

export function PlaceholderPage({ route }: { route: AppRoute }) {
  const navigate = useNavigate()
  return (
    <EmptyPlaceholder
      title={route.title}
      description={route.description}
      milestone={route.milestone}
      onAction={() => navigate('/')}
    />
  )
}

/** 未匹配路由 fallback：同一占位组件，不标里程碑 */
export function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <EmptyPlaceholder
      title="页面不存在"
      description="你访问的地址没有对应页面：功能可能尚未建设，或入口已迁移。"
      onAction={() => navigate('/')}
    />
  )
}
