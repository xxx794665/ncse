/**
 * 整卷模考域 React Query 键（T2-01c/T2-01e）
 * 卷目录、进行中会话列表、作答页（T2-01d）与成绩单页/历史列表（T2-01e）共用的键定义集中于此，
 * 避免各页面自造字面量导致失效半径不一致
 */

export const mockQueryKeys = {
  /** 全量卷目录（GET /api/papers） */
  papers: ['mock', 'papers'] as const,
  /** 进行中模考会话列表（GET /api/mock/sessions） */
  sessions: ['mock', 'sessions'] as const,
  /** 模考会话详情（GET /api/mock/sessions/:id，作答页 T2-01d 消费） */
  session: (id: number) => ['mock', 'session', id] as const,
  /** 模考成绩单（GET /api/mock/sessions/:id/report，成绩单页 T2-01e 消费） */
  report: (id: number) => ['mock', 'report', id] as const,
  /** 模考历史列表（GET /api/mock/history，卷选页历史区与成绩单页交卷时间反查共用） */
  history: ['mock', 'history'] as const,
} as const
