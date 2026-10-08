import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { MasteryTargetType, ReinforceReason, ReinforceStatus } from '@ncse/shared'
import { users } from './account'
import { questions } from './content'
import { createdAt, updatedAt } from './common'

/**
 * 掌握度统计：按知识点或模块两种颗粒聚合（多态目标，不建外键）。
 * target_id 依 target_type 解释为 knowledge_points.id / modules.id，合法性由写入方保证——
 * SQLite 无跨表 CHECK，两个可空外键方案又无法表达「恰有一个非空」，故取多态列 + 复合唯一键。
 */
export const masteryStats = sqliteTable(
  'mastery_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull().$type<MasteryTargetType>(),
    targetId: integer('target_id').notNull(),
    /** 累计作答次数 */
    totalCount: integer('total_count').notNull().default(0),
    /** 累计答对次数 */
    correctCount: integer('correct_count').notNull().default(0),
    /** 正确率（0–1，正确数/总数，冗余存储供排序） */
    accuracy: real('accuracy').notNull().default(0),
    /** 平均用时（毫秒） */
    avgDurationMs: integer('avg_duration_ms').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('mastery_stats_user_target_uq').on(table.userId, table.targetType, table.targetId)],
)

/**
 * 强化队列：user+question 唯一——重复触发（再答错/再超时）复用同一行并刷新 reason 与时间，
 * 答对后由业务层置 resolved；再次触发可复活为 pending。
 */
export const reinforceQueue = sqliteTable(
  'reinforce_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    /** 汇入原因：最近一次触发覆盖（答错/超时） */
    reason: text('reason').notNull().$type<ReinforceReason>(),
    status: text('status').notNull().default('pending').$type<ReinforceStatus>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('reinforce_queue_user_question_uq').on(table.userId, table.questionId),
    index('reinforce_queue_user_status_idx').on(table.userId, table.status),
  ],
)
