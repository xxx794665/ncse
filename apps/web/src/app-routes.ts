/**
 * 全站路由注册表（T0-05）：信息架构的单一权威来源
 * - 架构设计 §9：React Router 路由全量注册（含占位路由）；功能页按 features/* 域组织
 * - 未实现功能统一渲染 EmptyPlaceholder（设计规范 §6.7、ADR-0006），里程碑按 docs/功能清单.md 的 M 阶段标注
 * - 新增页面先回本表登记，App.tsx 按本表生成 <Routes>，首页速记入口同源取数
 */

import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  CalendarCheck,
  ChartColumn,
  CircleX,
  FileText,
  Home,
  LogIn,
  Palette,
  PenLine,
  Settings,
  UserPlus,
} from 'lucide-react'

/** 页面形态：home=首页仪表盘骨架；design=组件演示实页；placeholder=未实现功能占位 */
export type AppRouteKind = 'home' | 'design' | 'placeholder'

export interface AppRoute {
  /** 路由路径（'/' 为首页，注册为 index 路由） */
  path: string
  key: string
  /** 页面标题：占位页标题 / 首页速记入口名 */
  title: string
  /** 功能入口图标（设计规范 §5，24px 功能入口档） */
  icon: LucideIcon
  kind: AppRouteKind
  /** 占位页里程碑徽章（功能清单 M 阶段）；实页（home/design）不设 */
  milestone?: string
  /** 占位页「未完成」一句说明 */
  description?: string
  /** 首页速记入口的一句话简介 */
  summary?: string
}

export const APP_ROUTES: AppRoute[] = [
  {
    path: '/',
    key: 'home',
    title: '首页',
    icon: Home,
    kind: 'home',
  },
  {
    path: '/practice',
    key: 'practice',
    title: '专项刷题',
    icon: BookOpen,
    kind: 'placeholder',
    milestone: 'M1',
    description:
      '按模块或知识点的日常练习：逐题判分与解析、蓝图计时与超时告警、可中断续做（功能清单 F1-5/F1-6）。',
    summary: '按模块 / 知识点逐题练习与判分',
  },
  {
    path: '/mock',
    key: 'mock',
    title: '整卷模考',
    icon: FileText,
    kind: 'placeholder',
    milestone: 'M2',
    description: '按真题整卷与真实时长的计时模拟考试，交卷判分并出成绩单（功能清单 F2）。',
    summary: '真题整卷计时模考与成绩单',
  },
  {
    path: '/review',
    key: 'review',
    title: '错题 · 收藏 · 需加强',
    icon: CircleX,
    kind: 'placeholder',
    milestone: 'M3',
    description:
      '错题重做与消灭、收藏练习与需加强清单的统一复习入口；错题与收藏数据自 M1 起积累，需加强清单在 M3 完整落地（功能清单 F1-7/F1-8/F3-4）。',
    summary: '错题重做、收藏练习、需加强清单',
  },
  {
    path: '/stats',
    key: 'stats',
    title: '统计',
    icon: ChartColumn,
    kind: 'placeholder',
    milestone: 'M1',
    description: '正确率、用时、模块分布与趋势的基础统计（功能清单 F1-9）。',
    summary: '正确率、用时与模块趋势',
  },
  {
    path: '/shenlun',
    key: 'shenlun',
    title: '申论',
    icon: PenLine,
    kind: 'placeholder',
    milestone: 'M4',
    description: '材料阅读、限时作答、对照自评，以及 AI 批改与 AI 参考答案（功能清单 F4）。',
    summary: '材料作答、自评与 AI 批改',
  },
  {
    path: '/plan',
    key: 'plan',
    title: '学习计划',
    icon: CalendarCheck,
    kind: 'placeholder',
    milestone: 'M5',
    description: '按考试日期倒排的日程与每日任务量，完成度与刷题数据联动打卡（功能清单 F5）。',
    summary: '倒排日程与每日打卡',
  },
  {
    path: '/settings',
    key: 'settings',
    title: '应用设置',
    icon: Settings,
    kind: 'placeholder',
    milestone: 'M4',
    description:
      '账号级偏好与 AI 设置（OpenAI 兼容接口地址 / 密钥 / 模型 / 参数上限）；密钥加密存储、由后端代理调用（功能清单 F4-3）。',
    summary: '偏好与 AI 接口配置',
  },
  {
    path: '/login',
    key: 'login',
    title: '登录',
    icon: LogIn,
    kind: 'placeholder',
    milestone: 'M1',
    description: '账号体系（注册 / 登录 / JWT）尚未接入，练习数据将与账号绑定（功能清单 F1-4）。',
  },
  {
    path: '/register',
    key: 'register',
    title: '注册',
    icon: UserPlus,
    kind: 'placeholder',
    milestone: 'M1',
    description: '账号体系（注册 / 登录 / JWT）尚未接入，练习数据将与账号绑定（功能清单 F1-4）。',
  },
  {
    path: '/design',
    key: 'design',
    title: '组件演示',
    icon: Palette,
    kind: 'design',
    summary: '基础组件亮暗对照演示',
  },
]
