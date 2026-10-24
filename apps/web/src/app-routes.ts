/**
 * 全站路由注册表（T0-05）：信息架构的单一权威来源
 * - 架构设计 §9：React Router 路由全量注册（含占位路由）；功能页按 features/* 域组织
 * - 未实现功能统一渲染 EmptyPlaceholder（设计规范 §6.7、ADR-0006），里程碑按 docs/功能清单.md 的 M 阶段标注
 * - 新增页面先回本表登记，App.tsx 按本表生成 <Routes>，首页速记入口同源取数
 * - requiresAuth 标记受保护路由（T1-16）：App.tsx 据此包 RequireAuth 守卫（匿名 → /login）
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

/** 页面形态：home=首页仪表盘骨架；design=组件演示实页；login/register=认证实页（T1-16）；practice=专项刷题模块选择实页（T1-08f）；practice-session=专项刷题作答实页（T1-08g）；mock=整卷模考卷选实页（T2-01c）；mock-session=整卷模考作答实页（T2-01d）；review=错题/难点/收藏三视图实页（T1-10b）；stats=基础统计实页（T1-11b）；placeholder=未实现功能占位 */
export type AppRouteKind =
  | 'home'
  | 'design'
  | 'login'
  | 'register'
  | 'practice'
  | 'practice-session'
  | 'mock'
  | 'mock-session'
  | 'review'
  | 'stats'
  | 'placeholder'

export interface AppRoute {
  /** 路由路径（'/' 为首页，注册为 index 路由） */
  path: string
  key: string
  /** 页面标题：占位页标题 / 首页速记入口名 */
  title: string
  /** 功能入口图标（设计规范 §5，24px 功能入口档） */
  icon: LucideIcon
  kind: AppRouteKind
  /** 受保护路由（T1-16）：匿名访问被 RequireAuth 重定向 /login（state.from 原路返回） */
  requiresAuth?: boolean
  /** 内部路由（T1-08f）：不进首页速记入口（如作答页等二级页，仅经页内导航到达） */
  internal?: boolean
  /** 占位页里程碑徽章（功能清单 M 阶段）；实页（home/design/login/register/practice/practice-session/mock/mock-session/review/stats）不设 */
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
    kind: 'practice',
    requiresAuth: true,
    summary: '按模块 / 知识点逐题练习与判分',
  },
  {
    path: '/practice/sessions/:id',
    key: 'practice-session',
    title: '专项刷题 · 作答',
    icon: BookOpen,
    kind: 'practice-session',
    requiresAuth: true,
    internal: true,
  },
  {
    path: '/mock',
    key: 'mock',
    title: '整卷模考',
    icon: FileText,
    kind: 'mock',
    requiresAuth: true,
    summary: '真题整卷计时模考与成绩单',
  },
  {
    path: '/mock/sessions/:id',
    key: 'mock-session',
    title: '整卷模考 · 作答',
    icon: FileText,
    kind: 'mock-session',
    requiresAuth: true,
    internal: true,
  },
  {
    path: '/review',
    key: 'review',
    title: '错题 · 难点 · 收藏',
    icon: CircleX,
    kind: 'review',
    requiresAuth: true,
    summary: '错题重做、难点跟进与收藏清单',
  },
  {
    path: '/stats',
    key: 'stats',
    title: '统计',
    icon: ChartColumn,
    kind: 'stats',
    requiresAuth: true,
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
      '应用设置（含 AI 设置）属 M4：账号级偏好与 AI 接口配置（OpenAI 兼容地址 / 密钥 / 模型 / 参数上限），密钥加密存 D1、由后端代理调用（功能清单 F4-3）。',
    summary: '偏好与 AI 接口配置',
  },
  {
    path: '/login',
    key: 'login',
    title: '登录',
    icon: LogIn,
    kind: 'login',
    summary: '登录账号，练习记录与错题本随账号保存',
  },
  {
    path: '/register',
    key: 'register',
    title: '注册',
    icon: UserPlus,
    kind: 'register',
    summary: '注册新账号，开始刷题',
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
