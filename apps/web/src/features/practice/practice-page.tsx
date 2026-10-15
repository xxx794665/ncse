/**
 * 专项刷题·模块选择页（T1-08f，/practice，requiresAuth）
 * - 进行中会话：useQuery 拉取 in_progress 列表（createdAt 倒序即接口序），卡片「续做」→ /practice/sessions/:id；
 *   会话名经 sessionDisplayName（module 会话显模块名，wrong_redo 错题重做会话显「错题重做」，T1-10b）
 * - 六模块入口：点模块卡弹 Modal 选题数（5/10/20/30 默认 10），useMutation 建会话成功跳作答页（T1-08g 落地）
 * - 三态反馈：列表 pending 骨架（§6.8）/ error 提示 + 重试 / 空态引导；建会话 400 展示 ApiError.message；
 *   401 由 api client 全局回调接管（本页不特判）
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { BookOpenCheck, CalendarClock, Play } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { PracticeSessionSummary } from '@ncse/shared'
import { ApiError, createPracticeSessionApi, fetchPracticeSessionsApi } from '../../api'
import { Button, Card, Modal, Tag } from '../../components'
import type { XingceModuleMeta } from './modules'
import { XINGCE_MODULES, sessionDisplayName } from './modules'
import { practiceQueryKeys } from './practice-query-keys'
import './practice.css'

/** 题数选项（与 shared CreatePracticeSessionRequest.count 契约一致，勿单方扩值） */
const COUNT_OPTIONS = [5, 10, 20, 30] as const
/** 默认题数（§1：表单默认值给足） */
const DEFAULT_COUNT = 10
/** 进行中会话列表 staleTime：30s（会话仅经本人操作变更；建会话成功与作答页返回均 invalidate 兜底） */
const SESSIONS_STALE_TIME = 30_000

/** createdAt（ISO-8601 UTC）中文格式化，如「2026年10月13日 14:05」；不可解析时原样回显 */
function formatCreatedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/** 建会话失败消息：ApiError 透传后端消息（如 400 该模块暂无题目），其余给通用文案 */
function createErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '创建练习失败，请稍后重试'
}

/** 进行中会话卡片：模块名 + 作答进度条 + 创建时间 + 续做入口 */
function SessionCard({ session }: { session: PracticeSessionSummary }) {
  const navigate = useNavigate()
  const moduleName = sessionDisplayName(session.mode, session.moduleCode)
  const percent =
    session.total > 0 ? Math.round((session.answeredCount / session.total) * 100) : 0
  const resume = () => navigate(`/practice/sessions/${String(session.id)}`)

  return (
    <Card className="practice-session">
      <div className="practice-session__head">
        <h3 className="practice-session__module">{moduleName}</h3>
        <Tag tone="primary">进行中</Tag>
      </div>
      <div className="practice-session__progress">
        <div
          className="practice-session__progress-track"
          role="progressbar"
          aria-valuenow={session.answeredCount}
          aria-valuemin={0}
          aria-valuemax={session.total}
          aria-label={`${moduleName}作答进度`}
        >
          <div className="practice-session__progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="practice-session__progress-text">
          已答 {session.answeredCount}/{session.total}
        </span>
      </div>
      <div className="practice-session__meta">
        <span className="practice-session__time">
          <CalendarClock aria-hidden="true" />
          {formatCreatedAt(session.createdAt)}
        </span>
        <Button size="sm" icon={<Play aria-hidden="true" />} onClick={resume}>
          续做
        </Button>
      </div>
    </Card>
  )
}

/** 会话列表加载骨架（§6.8：bg-muted 圆角块 + 1.2s 呼吸动画；条高取所代表行的字号 token） */
function SessionsSkeleton() {
  return (
    <div className="practice-sessions" role="status" aria-label="正在加载进行中的练习">
      {[0, 1, 2].map((index) => (
        <div key={index} className="practice-skeleton" aria-hidden="true">
          <div className="practice-skeleton__line practice-skeleton__line--title" />
          <div className="practice-skeleton__line" />
          <div className="practice-skeleton__line practice-skeleton__line--short" />
        </div>
      ))}
    </div>
  )
}

export function PracticePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const sessionsQuery = useQuery({
    queryKey: practiceQueryKeys.sessions,
    queryFn: fetchPracticeSessionsApi,
    staleTime: SESSIONS_STALE_TIME,
  })

  // 待建会话的模块（非 null 即弹窗打开）；题数每次开弹窗时重置为默认 10
  const [targetModule, setTargetModule] = useState<XingceModuleMeta | null>(null)
  const [count, setCount] = useState<number>(DEFAULT_COUNT)

  const createMutation = useMutation({
    mutationFn: createPracticeSessionApi,
    onSuccess: (detail) => {
      // 作答页返回时列表不过期：建会话成功即失效列表，再跳作答页
      void queryClient.invalidateQueries({ queryKey: practiceQueryKeys.sessions })
      setTargetModule(null)
      navigate(`/practice/sessions/${String(detail.id)}`)
    },
  })

  const openCreateModal = (meta: XingceModuleMeta) => {
    setCount(DEFAULT_COUNT)
    createMutation.reset()
    setTargetModule(meta)
  }
  const closeCreateModal = () => {
    // 提交中不允许关闭（Esc/遮罩/取消同走本函数），避免请求悬置后状态错乱
    if (createMutation.isPending) return
    setTargetModule(null)
    createMutation.reset()
  }
  const submitCreate = () => {
    if (targetModule === null || createMutation.isPending) return
    createMutation.mutate({ module: targetModule.code, count })
  }
  /** 模块卡键盘可达：Enter/Space 触发开弹窗 */
  const moduleKeyDown = (meta: XingceModuleMeta) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openCreateModal(meta)
    }
  }

  const sessions = sessionsQuery.data ?? []

  return (
    <div className="practice">
      <header className="practice-hero">
        <h1 className="practice-hero__title">专项刷题</h1>
        <p className="practice-hero__desc">
          按行测模块逐题练习，判分与解析即时反馈；练习可中断，随时回来续做。
        </p>
      </header>

      <section className="practice-section" aria-labelledby="practice-sessions-title">
        <div className="practice-section__head">
          <h2 id="practice-sessions-title" className="practice-section__title">
            进行中的练习
          </h2>
        </div>
        {sessionsQuery.isPending && <SessionsSkeleton />}
        {sessionsQuery.isError && (
          <div className="practice-sessions__error" role="alert">
            <p className="practice-sessions__error-text">
              {sessionsQuery.error instanceof ApiError
                ? sessionsQuery.error.message
                : '会话列表加载失败，请稍后重试'}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void sessionsQuery.refetch()}
            >
              重试
            </Button>
          </div>
        )}
        {sessionsQuery.isSuccess && sessions.length === 0 && (
          <div className="practice-sessions-empty">
            <BookOpenCheck className="practice-sessions-empty__icon" aria-hidden="true" />
            <p className="practice-sessions-empty__text">
              还没有进行中的练习，从下方六个模块中选一个开始。
            </p>
          </div>
        )}
        {sessions.length > 0 && (
          <div className="practice-sessions">
            {sessions.map((session) => (
              <SessionCard key={session.id} session={session} />
            ))}
          </div>
        )}
      </section>

      <section className="practice-section" aria-labelledby="practice-modules-title">
        <div className="practice-section__head">
          <h2 id="practice-modules-title" className="practice-section__title">
            选择模块开始练习
          </h2>
        </div>
        <div className="practice-modules">
          {XINGCE_MODULES.map((meta) => {
            const Icon = meta.icon
            return (
              <Card
                key={meta.code}
                interactive
                className="practice-module"
                onClick={() => openCreateModal(meta)}
                role="button"
                tabIndex={0}
                onKeyDown={moduleKeyDown(meta)}
              >
                <Icon className="practice-module__icon" aria-hidden="true" />
                <h3 className="practice-module__name">{meta.name}</h3>
                <p className="practice-module__tagline">{meta.tagline}</p>
              </Card>
            )
          })}
        </div>
      </section>

      <Modal
        open={targetModule !== null}
        onClose={closeCreateModal}
        title={targetModule === null ? undefined : `开始「${targetModule.name}」练习`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeCreateModal}
              disabled={createMutation.isPending}
            >
              取消
            </Button>
            <Button onClick={submitCreate} loading={createMutation.isPending}>
              开始练习
            </Button>
          </>
        }
      >
        <div className="practice-create">
          {createMutation.isError && (
            <p className="practice-create__error" role="alert">
              {createErrorMessage(createMutation.error)}
            </p>
          )}
          <p className="practice-create__label" id="practice-count-label">
            题目数量
          </p>
          <div
            className="practice-count"
            role="radiogroup"
            aria-labelledby="practice-count-label"
          >
            {COUNT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={count === option}
                className={
                  count === option
                    ? 'practice-count__option is-selected'
                    : 'practice-count__option'
                }
                disabled={createMutation.isPending}
                onClick={() => setCount(option)}
              >
                {option} 题
              </button>
            ))}
          </div>
          <p className="practice-create__hint">
            该模块可用题目不足所选数量时，将按实际题量生成练习。
          </p>
        </div>
      </Modal>
    </div>
  )
}
