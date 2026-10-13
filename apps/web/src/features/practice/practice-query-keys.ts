/**
 * 练习域 React Query 键（T1-08f）
 * 会话列表与作答页（T1-08g）共用的键定义集中于此，避免各页面自造字面量导致失效半径不一致
 */

export const practiceQueryKeys = {
  /** 进行中会话列表（GET /api/practice/sessions） */
  sessions: ['practice', 'sessions'] as const,
  /** 会话详情（GET /api/practice/sessions/:id，作答页 T1-08g 消费） */
  session: (id: number) => ['practice', 'session', id] as const,
} as const
