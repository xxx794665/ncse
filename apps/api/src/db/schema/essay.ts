import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { RichContent } from '@ncse/shared'
import { users } from './account'
import { subjects } from './content'
import { createdAt, updatedAt } from './common'

/**
 * 申论域（M4 才接入，本任务按概念模型建表）。
 * 范文分类与批改明细的字段取值为概念级定稿，M4 落地时可细化迁移。
 */

/** 范文类别：高分/中档/低分范文与点评（M4 可细化） */
export type EssaySampleCategory = 'excellent' | 'average' | 'low' | 'commentary'

/** AI 批改单维度明细 */
export interface EssayGradeDetail {
  /** 维度名（如「要点覆盖」「论证深度」） */
  dimension: string
  score: number
  maxScore: number
  comment: string
}

/** 申论材料：挂申论科目，同一材料可被多道申论题引用 */
export const essayMaterials = sqliteTable(
  'essay_materials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subjectId: integer('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    /** 材料富片段（文本为主，图片引用预留） */
    content: text('content', { mode: 'json' }).$type<RichContent>().notNull(),
    year: integer('year'),
    region: text('region'),
    paperType: text('paper_type'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('essay_materials_subject_year_idx').on(table.subjectId, table.year)],
)

/** 申论题目：材料可空（小题可脱离给定材料），qid 为导入自然键 */
export const essayQuestions = sqliteTable(
  'essay_questions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    materialId: integer('material_id').references(() => essayMaterials.id, { onDelete: 'cascade' }),
    qid: text('qid').notNull(),
    /** 题干富片段（作答要求） */
    stem: text('stem', { mode: 'json' }).$type<RichContent>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('essay_questions_qid_uq').on(table.qid)],
)

/** 申论作答：user+question 唯一（当前作答，重做覆盖）；手写拍照走 R2，识别文本入库 */
export const essayAnswers = sqliteTable(
  'essay_answers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => essayQuestions.id, { onDelete: 'cascade' }),
    /** 最终作答文本（用户键入或校对后的手写识别文本） */
    contentText: text('content_text'),
    /** 手写稿照片的 R2 对象路径（空 = 纯键入作答） */
    imagePath: text('image_path'),
    /** 手写识别文本（识别产物原样留档，供重新识别与比对） */
    handwrittenText: text('handwritten_text'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('essay_answers_user_question_uq').on(table.userId, table.questionId)],
)

/** AI 批改结果：每作答可多次批改（append-only 历史，一行一次批改） */
export const aiGrades = sqliteTable(
  'ai_grades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    answerId: integer('answer_id')
      .notNull()
      .references(() => essayAnswers.id, { onDelete: 'cascade' }),
    /** 批改所用模型（OpenAI 兼容模型名） */
    model: text('model').notNull(),
    /** 总分（空 = 批改失败未给分） */
    score: real('score'),
    /** 总评 */
    comment: text('comment'),
    /** 分维度明细（JSON 数组） */
    details: text('details', { mode: 'json' }).$type<EssayGradeDetail[]>(),
    createdAt: createdAt(),
  },
  (table) => [index('ai_grades_answer_idx').on(table.answerId)],
)

/** 范文库：挂申论题目，同题可挂多篇不同类别的范文 */
export const essaySamples = sqliteTable(
  'essay_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    questionId: integer('question_id')
      .notNull()
      .references(() => essayQuestions.id, { onDelete: 'cascade' }),
    category: text('category').notNull().$type<EssaySampleCategory>(),
    /** 范文全文（纯文本） */
    content: text('content').notNull(),
    /** 范文得分（空 = 未标分，如点评类） */
    score: real('score'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('essay_samples_question_idx').on(table.questionId)],
)
