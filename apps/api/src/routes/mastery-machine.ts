import { inArray, sql } from 'drizzle-orm'
import type { DbClient } from '../db'
import { masteryStats, questionKnowledge } from '../db/schema'

/**
 * 掌握度增量更新机（M3/T3-01d；照 wrong-book-machine.ts / reinforce-machine.ts 先例
 * 独立成跨路由共享文件，练习判分与模考交卷判分两域复用同一实现，勿在各路由内留拷贝）：
 * - 输入为逐题判分增量 [{questionId, isCorrect, durationMs}]（练习判分每题单事件 n=1、
 *   模考交卷整卷已判分答案一次性传入——聚合后每知识点仅 1 条 upsert，135 题整卷高效）；
 * - question_knowledge 一次性反查打标 pair（Map<questionId, kpId[]>；inArray 按批 90 分批，
 *   D1 每查询绑定参数上限 100，见 mock.ts D1_PARAM_BATCH_SIZE 同惯例），未打标题静默跳过
 *   （打标跨天执行中，大量题无 pair 属正常态，不报错不建行）；
 * - 按 kpId 聚合 {n, correct, sumMs} 后逐知识点单条 upsert mastery_stats
 *   （targetType='knowledge_point'，user+targetType+targetId 三列复合唯一）：
 *   totalCount/correctCount 行自引用累加；accuracy 以 CAST REAL 除法落列（SQLite 整数除法
 *   截断陷阱）；avgDurationMs 增量加权均值 (旧均值×旧总数 + sumMs)/(旧总数 + n)——除数
 *   + 0.0 防整除截断漂移，ROUND 后 CAST 回 INTEGER；
 * - 只写知识点行，绝不写模块级行（模块级走查询端点现算，D4 决策）；模考作答与专项作答
 *   同权重汇入（D4：模考计入掌握度）。
 * updatedAt 显式给值（$onUpdate 在 upsert 冲突分支不触发，不依赖它——wrong-book-machine 惯例）。
 * mastery/needsReinforce 不在此落列：派生口径以 shared mastery.ts 为唯一权威，查询端点现算下发。
 */

/** 逐题判分增量（判分侧一次事件的粒度：一题一行，isCorrect 为判分结果、durationMs 为用时） */
export interface MasteryAnswerIncrement {
  /** 题目 id（questions 表主键，须已判分） */
  questionId: number
  /** 是否答对（判分结果，非用户作答内容） */
  isCorrect: boolean
  /** 本题用时（毫秒） */
  durationMs: number
}

/**
 * D1 绑定参数分批上限（照 mock.ts D1_PARAM_BATCH_SIZE 惯例：Cloudflare D1 每查询最多
 * 100 个绑定参数，批大小为 inArray 之外的其余绑定参数留余量；本地 miniflare 模拟无此
 * 限制，集成测试防不住——100+ 题整卷的 inArray 反查打标必须分批）。
 */
const D1_PARAM_BATCH_SIZE = 90

/** 按固定批大小切分列表（尾批可短；空列表返回空批数组，调用方循环天然短路——mock.ts 同构） */
function chunked<T>(list: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size))
  }
  return chunks
}

/**
 * 掌握度增量更新：把一批已判分作答按知识点聚合后 upsert mastery_stats（详见文件头）。
 * 空数组/全部未打标时无任何写库（幂等安全，调用方无需预判打标覆盖度）。
 */
export async function applyMasteryIncrements(
  db: DbClient,
  userId: number,
  increments: readonly MasteryAnswerIncrement[],
): Promise<void> {
  if (increments.length === 0) {
    return
  }

  // 打标反查：Map<questionId, kpId[]>（同题多 pair 全保留——一题计入多个知识点各自聚合）
  const kpIdsByQuestion = new Map<number, number[]>()
  const questionIds = [...new Set(increments.map((item) => item.questionId))]
  for (const batch of chunked(questionIds, D1_PARAM_BATCH_SIZE)) {
    const rows = await db
      .select({
        questionId: questionKnowledge.questionId,
        knowledgePointId: questionKnowledge.knowledgePointId,
      })
      .from(questionKnowledge)
      .where(inArray(questionKnowledge.questionId, batch))
    for (const row of rows) {
      const list = kpIdsByQuestion.get(row.questionId)
      if (list === undefined) {
        kpIdsByQuestion.set(row.questionId, [row.knowledgePointId])
      } else {
        list.push(row.knowledgePointId)
      }
    }
  }

  // 按知识点聚合（未打标题静默跳过：无 pair 不建行，打标覆盖度演进中属正常态）
  const aggByKp = new Map<number, { n: number; correct: number; sumMs: number }>()
  for (const item of increments) {
    const kpIds = kpIdsByQuestion.get(item.questionId)
    if (kpIds === undefined) {
      continue
    }
    for (const kpId of kpIds) {
      let agg = aggByKp.get(kpId)
      if (agg === undefined) {
        agg = { n: 0, correct: 0, sumMs: 0 }
        aggByKp.set(kpId, agg)
      }
      agg.n += 1
      if (item.isCorrect) {
        agg.correct += 1
      }
      agg.sumMs += item.durationMs
    }
  }

  const updatedAt = new Date().toISOString()
  for (const [kpId, agg] of aggByKp) {
    // 冲突分支的行自引用累加：SQLite ON CONFLICT DO UPDATE 中裸表名引用取既有行值
    //（与 wrong-book-machine 的 wrongCount + 1 同一手法）；首次插入 values 与冲突分支同口径
    //（由 n/correct/sumMs 派生初值：accuracy REAL 除法、avg ROUND 后取整）。
    await db
      .insert(masteryStats)
      .values({
        userId,
        targetType: 'knowledge_point',
        targetId: kpId,
        totalCount: agg.n,
        correctCount: agg.correct,
        accuracy: agg.correct / agg.n,
        avgDurationMs: Math.round(agg.sumMs / agg.n),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [masteryStats.userId, masteryStats.targetType, masteryStats.targetId],
        set: {
          totalCount: sql`${masteryStats.totalCount} + ${agg.n}`,
          correctCount: sql`${masteryStats.correctCount} + ${agg.correct}`,
          // CAST REAL 除法：SQLite 整数/整数按整除截断（如 1/2 → 0），必须先 CAST 再除
          accuracy: sql`CAST(${masteryStats.correctCount} + ${agg.correct} AS REAL) / (${masteryStats.totalCount} + ${agg.n})`,
          // 增量加权均值：除数 + 0.0 强制 REAL 除法防截断漂移，ROUND 四舍五入后 CAST 回 INTEGER
          avgDurationMs: sql`CAST(ROUND((${masteryStats.avgDurationMs} * ${masteryStats.totalCount} + ${agg.sumMs}) / (${masteryStats.totalCount} + ${agg.n} + 0.0)) AS INTEGER)`,
          updatedAt,
        },
      })
  }
}
