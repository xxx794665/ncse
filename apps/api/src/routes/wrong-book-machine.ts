import { and, eq, sql } from 'drizzle-orm'
import type { WrongBookContext } from '@ncse/shared'
import type { DbClient } from '../db'
import { wrongBook } from '../db/schema'

/**
 * 错题本状态机（ADR-0010，T1-08c 起为练习域私有，T2-01b 交卷判分需逐题联动——抽出共享：
 * 练习判分与模考交卷判分两域复用同一实现，照 stem-preview.ts / rich-content-project.ts 先例
 * 独立成跨路由共享文件，勿在各路由内留拷贝）：
 * - 答错（无论是否在册）：upsert 复用 user+question 行——插入分支 active/wrongCount=1/redoCount=0/连对 0；
 *   冲突分支回 active（eliminated/hard 复活）、wrongCount 与 redoCount 按行自引用累加、连对清零；
 * - 答对且在册（任意 status）：redoCount/连对累加，status 不动（消灭由用户处置端点翻转）；
 * - 答对不在册：无操作。
 * updatedAt 显式给值（$onUpdate 在 upsert 冲突分支等路径不触发，不依赖它）。
 * 返回状态机执行后的条目上下文（null = 不在册且答对）。
 */
export async function applyWrongBookStateMachine(
  db: DbClient,
  userId: number,
  questionId: number,
  isCorrect: boolean,
): Promise<WrongBookContext | null> {
  const updatedAt = new Date().toISOString()
  if (!isCorrect) {
    await db
      .insert(wrongBook)
      .values({ userId, questionId, status: 'active', wrongCount: 1, redoCount: 0, consecutiveCorrect: 0, updatedAt })
      .onConflictDoUpdate({
        target: [wrongBook.userId, wrongBook.questionId],
        set: {
          status: 'active',
          wrongCount: sql`${wrongBook.wrongCount} + 1`,
          redoCount: sql`${wrongBook.redoCount} + 1`,
          consecutiveCorrect: 0,
          updatedAt,
        },
      })
    return { status: 'active' }
  }
  // 答对：仅行存在时累加（returning 空数组 = 不在册，无操作）；status 原样带回供响应上下文
  const updated = await db
    .update(wrongBook)
    .set({
      redoCount: sql`${wrongBook.redoCount} + 1`,
      consecutiveCorrect: sql`${wrongBook.consecutiveCorrect} + 1`,
      updatedAt,
    })
    .where(and(eq(wrongBook.userId, userId), eq(wrongBook.questionId, questionId)))
    .returning({ status: wrongBook.status })
  const row = updated[0]
  return row === undefined ? null : { status: row.status }
}
