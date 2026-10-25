import { and, eq } from 'drizzle-orm'
import type { ReinforceReason } from '@ncse/shared'
import type { DbClient } from '../db'
import { reinforceQueue } from '../db/schema'

/**
 * 需加强队列状态机（M3 规划 D5 定稿，T3-01e；照 wrong-book-machine.ts 先例独立成跨路由
 * 共享文件，练习判分与模考交卷判分两域复用同一实现，勿在各路由内留拷贝）：
 * - 汇入（练习判分 + 模考交卷同口径）：答错或超时（含答对但超时——超时=不熟练）→
 *   upsert 复用 user+question 行：status 恒置 pending（resolved 行复活）、reason 覆盖为
 *   最近一次触发（答错记 'wrong'——答错且超时同用时记 wrong；答对但超时记 'timeout'）；
 * - 出队（仅练习判分）：答对且不超时 → 行存在（任意 status）置 resolved，行不存在不建行；
 *   模考交卷不做出队——模考是考试场景、答对不是「重做」（与错题本 D8 保守解释同一口径），
 *   在册 pending 行保守保留，由练习判分答对出队。
 * 与错题本并存：错题本是用户处置状态机（active/eliminated/hard），本队列全自动、
 * 无任何用户处置动作，两域勿混流。updatedAt 显式给值（$onUpdate 在 upsert 冲突分支
 * 等路径不触发，不依赖它——wrong-book-machine 惯例）。
 */

/** 汇入：答错或超时触发——upsert 复用 user+question 行，status 恒 pending、reason 覆盖 */
export async function ingestReinforce(
  db: DbClient,
  userId: number,
  questionId: number,
  reason: ReinforceReason,
): Promise<void> {
  const updatedAt = new Date().toISOString()
  await db
    .insert(reinforceQueue)
    .values({ userId, questionId, reason, status: 'pending', updatedAt })
    .onConflictDoUpdate({
      target: [reinforceQueue.userId, reinforceQueue.questionId],
      set: { reason, status: 'pending', updatedAt },
    })
}

/** 出队：练习判分答对且不超时——行存在（任意 status）置 resolved；行不存在无操作（不建行） */
export async function resolveReinforce(db: DbClient, userId: number, questionId: number): Promise<void> {
  await db
    .update(reinforceQueue)
    .set({ status: 'resolved', updatedAt: new Date().toISOString() })
    .where(and(eq(reinforceQueue.userId, userId), eq(reinforceQueue.questionId, questionId)))
}
