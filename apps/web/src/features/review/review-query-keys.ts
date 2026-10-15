/**
 * 复习域（/review）React Query 键（T1-10b）
 * 错题本/难点本列表与收藏列表的键定义集中于此，避免页内自造字面量导致失效半径不一致；
 * 错题处置后 active/hard 两列表都可能变化（归置跨账本），失效统一走 wrongBookAll 前缀
 */

export const reviewQueryKeys = {
  /** 错题本/难点本列表前缀（处置成功后按此前缀失效，active/hard 双状态同刷） */
  wrongBookAll: ['review', 'wrong-book'] as const,
  /** 错题本/难点本列表（GET /api/wrong-book?status=active|hard） */
  wrongBook: (status: 'active' | 'hard') => ['review', 'wrong-book', status] as const,
  /** 收藏列表（GET /api/favorites） */
  favorites: ['review', 'favorites'] as const,
} as const
