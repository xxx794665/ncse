/**
 * 整卷模考域 React Query 键（T2-01c）
 * 卷目录、进行中会话列表与作答页（T2-01d）共用的键定义集中于此，避免各页面自造字面量导致失效半径不一致
 */

export const mockQueryKeys = {
  /** 全量卷目录（GET /api/papers） */
  papers: ['mock', 'papers'] as const,
  /** 进行中模考会话列表（GET /api/mock/sessions） */
  sessions: ['mock', 'sessions'] as const,
  /** 模考会话详情（GET /api/mock/sessions/:id，作答页 T2-01d 消费） */
  session: (id: number) => ['mock', 'session', id] as const,
} as const
