/**
 * 统计域（/stats）React Query 键（T1-11b）
 * 汇总查询的键定义集中于此，避免页内自造字面量导致失效半径不一致
 */

export const statsQueryKeys = {
  /** 统计汇总（GET /api/stats/summary） */
  summary: ['stats', 'summary'] as const,
} as const
