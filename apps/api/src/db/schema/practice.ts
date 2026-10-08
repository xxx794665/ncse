import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { MockSessionStatus, PracticeMode, WrongBookStatus } from '@ncse/shared'
import { users } from './account'
import { blueprints, questions } from './content'
import { createdAt, updatedAt } from './common'

/**
 * 逐题练习记录：一次作答一行（append-only，不改不删）。
 * session_id 为「可中断续做」预留：同一次练习批次的所有记录写同一 UUID（客户端或服务端生成均可），
 * 空 = 单题独立练习；续做时按 (user_id, session_id) 取最近批次恢复进度。
 */
export const practiceRecords = sqliteTable(
  'practice_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    /** 用户作答内容（单选为选项键） */
    answer: text('answer').notNull(),
    isCorrect: integer('is_correct', { mode: 'boolean' }).notNull(),
    /** 本题用时（毫秒） */
    durationMs: integer('duration_ms').notNull(),
    /** 超时标记（超蓝图单题时限判超时，见架构设计 §5 / T1-07 推导） */
    isTimeout: integer('is_timeout', { mode: 'boolean' }).notNull().default(false),
    mode: text('mode').notNull().$type<PracticeMode>(),
    /** 可中断续做的批次标识（UUID，空 = 独立单题练习） */
    sessionId: text('session_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('practice_records_user_question_idx').on(table.userId, table.questionId),
    index('practice_records_session_idx').on(table.userId, table.sessionId),
  ],
)

/** 整卷模拟会话头：挂卷型蓝图；in_progress 状态的会话即「可中断续做」的载体（续做重新进入） */
export const mockSessions = sqliteTable(
  'mock_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 删除使用中的蓝图会破坏历史成绩，故 restrict：须先处理会话再删蓝图 */
    blueprintId: integer('blueprint_id')
      .notNull()
      .references(() => blueprints.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('in_progress').$type<MockSessionStatus>(),
    /** 交卷时间（空 = 未交卷） */
    submittedAt: text('submitted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('mock_sessions_user_status_idx').on(table.userId, table.status)],
)

/** 整卷逐题作答：每会话每题一行；交卷前可改答案（updated_at 刷新），未作答 answer 为空 */
export const mockAnswers = sqliteTable(
  'mock_answers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => mockSessions.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    /** 作答内容（空 = 未作答） */
    answer: text('answer'),
    /** 判分结果（交卷判分时落值，空 = 未判分） */
    isCorrect: integer('is_correct', { mode: 'boolean' }),
    durationMs: integer('duration_ms').notNull().default(0),
    isTimeout: integer('is_timeout', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('mock_answers_session_question_uq').on(table.sessionId, table.questionId)],
)

/**
 * 错题本：user+question 唯一（重复答错复用同一行并累加计数）。
 * 消灭规则（连续答对 N 次 → eliminated）的 N 由业务层定，库只存计数与状态。
 */
export const wrongBook = sqliteTable(
  'wrong_book',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('active').$type<WrongBookStatus>(),
    /** 累计答错次数 */
    wrongCount: integer('wrong_count').notNull().default(0),
    /** 累计重做次数 */
    redoCount: integer('redo_count').notNull().default(0),
    /** 重做连续答对次数（消灭判据） */
    consecutiveCorrect: integer('consecutive_correct').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('wrong_book_user_question_uq').on(table.userId, table.questionId)],
)

/** 收藏：user+question 唯一，取消收藏即删行 */
export const favorites = sqliteTable(
  'favorites',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('favorites_user_question_uq').on(table.userId, table.questionId)],
)

/** 笔记：user+question 唯一，纯文本（富文本需求出现时再迁移） */
export const notes = sqliteTable(
  'notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('notes_user_question_uq').on(table.userId, table.questionId)],
)
