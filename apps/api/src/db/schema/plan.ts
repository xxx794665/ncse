import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { users } from './account'
import { createdAt, updatedAt } from './common'

/**
 * 计划域（M5 才接入，本任务按概念模型建表）。
 * 计划的每日任务粒度（任务清单/完成勾选）M5 落地时再细化，当前仅建会话骨架：
 * study_plans 为计划头（区间 + 状态），checkins 为按日打卡（存在即打卡，note 记补充说明）。
 */

/** 学习计划状态：active 进行中 / archived 已归档（不物理删除，保留历史） */
export type StudyPlanStatus = 'active' | 'archived'

/** 学习计划：挂用户，区间内按日打卡 */
export const studyPlans = sqliteTable(
  'study_plans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** 计划起始日（ISO 日期 YYYY-MM-DD） */
    startDate: text('start_date').notNull(),
    /** 计划截止日（ISO 日期 YYYY-MM-DD） */
    endDate: text('end_date').notNull(),
    status: text('status').notNull().default('active').$type<StudyPlanStatus>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('study_plans_user_status_idx').on(table.userId, table.status)],
)

/** 打卡：一计划一日一行（存在即打卡成功），归属用户经 study_plans 关联 */
export const checkins = sqliteTable(
  'checkins',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    planId: integer('plan_id')
      .notNull()
      .references(() => studyPlans.id, { onDelete: 'cascade' }),
    /** 打卡日期（ISO 日期 YYYY-MM-DD，时区取用户本地日，由客户端换算） */
    date: text('date').notNull(),
    /** 打卡备注（可选） */
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('checkins_plan_date_uq').on(table.planId, table.date)],
)
