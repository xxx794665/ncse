import { type AnySQLiteColumn, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { QuestionDifficulty, QuestionKind, QuestionOption, RichContent, TagSource } from '@ncse/shared'
import { createdAt, updatedAt } from './common'

/**
 * 内容域：一切内容挂 exam_type（扩容单位，通用层级：考试类型→科目→模块→知识点/题目/蓝图）。
 * 来源元数据（year/region/paper_type）在 question_groups 与 questions 两级均落列：
 * 组级描述同组共享来源，题级为过滤查询与组缺省时的兜底（导入时同值写入）。
 */

/** 考试类型：扩容单位（公务员 → 软考等，见架构设计 §8） */
export const examTypes = sqliteTable(
  'exam_types',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 稳定编码，如 'civil_service' */
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('exam_types_code_uq').on(table.code)],
)

/** 科目：挂考试类型（如行测/申论） */
export const subjects = sqliteTable(
  'subjects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    examTypeId: integer('exam_type_id')
      .notNull()
      .references(() => examTypes.id, { onDelete: 'cascade' }),
    /** 稳定编码，如 'xingce' / 'shenlun' */
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('subjects_exam_type_code_uq').on(table.examTypeId, table.code)],
)

/** 模块：挂科目（行测六大模块等），sort_order 控制展示顺序 */
export const modules = sqliteTable(
  'modules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subjectId: integer('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    /** 稳定编码（模块内幂等导入的依据之一） */
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('modules_subject_code_uq').on(table.subjectId, table.code),
    index('modules_subject_sort_idx').on(table.subjectId, table.sortOrder),
  ],
)

/** 知识点：自引用树（parent_id 空 = 根），挂模块；子树随父节点级联删除 */
export const knowledgePoints = sqliteTable(
  'knowledge_points',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    moduleId: integer('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    parentId: integer('parent_id').references((): AnySQLiteColumn => knowledgePoints.id, {
      onDelete: 'cascade',
    }),
    /** 稳定编码（模块内唯一，打标幂等导入的依据） */
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('knowledge_points_module_code_uq').on(table.moduleId, table.code),
    index('knowledge_points_parent_idx').on(table.parentId),
  ],
)

/** 题组/材料：同组题目共享的材料富片段与来源元数据（如资料分析一篇材料多道题） */
export const questionGroups = sqliteTable(
  'question_groups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    moduleId: integer('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    /** 导入自然键（'<试卷文件相对路径>#<材料序号>'，如 '06-资料分析/xx.md#1'；同模块内唯一，幂等 upsert 依据，T1-15 补 T1-02 自然键缺口） */
    sourceKey: text('source_key').notNull(),
    /** 材料富片段（文本+图片引用混合） */
    material: text('material', { mode: 'json' }).$type<RichContent>().notNull(),
    /** 同组共享来源：年份（如 2024） */
    year: integer('year'),
    /** 同组共享来源：地区编码（如 'national' / 'shandong'） */
    region: text('region'),
    /** 同组共享来源：卷型（如 '省级' / '市级' / '行政执法'，自由文本） */
    paperType: text('paper_type'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('question_groups_module_source_key_uq').on(table.moduleId, table.sourceKey),
    index('question_groups_module_year_idx').on(table.moduleId, table.year),
  ],
)

/**
 * 题目：挂模块，可空挂题组；qid 为导入自然键（幂等 upsert 依据）。
 * kind 预留扩展（M1 仅 'single_choice'）；answer 存选项键（单选如 'A'，将来多选如 'ABC'）。
 * vision_text 为视觉提取的可搜索纯文本（图片题 OCR 汇总，空串 = 无图片内容）。
 */
export const questions = sqliteTable(
  'questions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    moduleId: integer('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    groupId: integer('group_id').references(() => questionGroups.id, { onDelete: 'cascade' }),
    /** 导入自然键（来源仓库 qid，全库唯一） */
    qid: text('qid').notNull(),
    kind: text('kind').notNull().$type<QuestionKind>(),
    /** 题干富片段 */
    stem: text('stem', { mode: 'json' }).$type<RichContent>().notNull(),
    /** 选项富片段数组（含选项键） */
    options: text('options', { mode: 'json' }).$type<QuestionOption[]>().notNull(),
    /** 答案：引用选项键 */
    answer: text('answer').notNull(),
    /** 解析富片段 */
    analysis: text('analysis', { mode: 'json' }).$type<RichContent>().notNull(),
    /** 难度（可空 = 未标定） */
    difficulty: text('difficulty').$type<QuestionDifficulty>(),
    year: integer('year'),
    region: text('region'),
    paperType: text('paper_type'),
    /** 视觉提取可搜索文本（空串表示无），LIKE 检索无需 COALESCE */
    visionText: text('vision_text').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('questions_qid_uq').on(table.qid),
    index('questions_group_idx').on(table.groupId),
    index('questions_module_year_idx').on(table.moduleId, table.year),
  ],
)

/** 题目-知识点多对多：打标版本（产出该打标的 import_runs 序号）与来源（官方/AI/人工校对） */
export const questionKnowledge = sqliteTable(
  'question_knowledge',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    knowledgePointId: integer('knowledge_point_id')
      .notNull()
      .references(() => knowledgePoints.id, { onDelete: 'cascade' }),
    /** 打标版本：产出该打标的 import_runs 序号（再蒸馏时据此判断是否重打） */
    tagVersion: integer('tag_version').notNull(),
    source: text('source').notNull().$type<TagSource>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('question_knowledge_pair_uq').on(table.questionId, table.knowledgePointId),
    index('question_knowledge_kp_idx').on(table.knowledgePointId),
  ],
)

/** 卷型蓝图：挂科目（如「国考行测·省级卷」），题目量与时长明细在 blueprint_modules */
export const blueprints = sqliteTable(
  'blueprints',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subjectId: integer('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    /** 稳定编码（蓝图配置幂等导入的依据） */
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('blueprints_subject_code_uq').on(table.subjectId, table.code)],
)

/** 蓝图模块明细：卷型→模块/题量/时长；module 须属于蓝图的科目（应用层保证，库层无跨表 CHECK） */
export const blueprintModules = sqliteTable(
  'blueprint_modules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    blueprintId: integer('blueprint_id')
      .notNull()
      .references(() => blueprints.id, { onDelete: 'cascade' }),
    moduleId: integer('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    questionCount: integer('question_count').notNull(),
    /** 该模块在整卷中的时长上限（分钟；整卷总时长由明细汇总推导，T1-07） */
    timeLimitMinutes: integer('time_limit_minutes').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('blueprint_modules_pair_uq').on(table.blueprintId, table.moduleId)],
)
