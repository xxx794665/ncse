/**
 * 统计域（/stats）React Query 键（T1-11b / M3 T3-01f）
 * 汇总与知识点掌握度查询的键定义集中于此，避免页内自造字面量导致失效半径不一致
 */

export const statsQueryKeys = {
  /** 统计汇总（GET /api/stats/summary） */
  summary: ['stats', 'summary'] as const,
  /** 分模块知识点掌握度（GET /api/stats/knowledge，M3/T3-01f） */
  knowledge: ['stats', 'knowledge'] as const,
} as const
