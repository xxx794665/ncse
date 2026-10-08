import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { createdAt, updatedAt } from './common'

/**
 * 管线域：题库导入管线的运行记录（幂等与再蒸馏依据，见架构设计 §5）。
 * 同 version 重跑覆盖、新 version 重生成——按自然键（qid/code 等）upsert，
 * 不做先删后插（外键级联会把用户做题数据连带清掉）。
 */

/** 导入运行状态 */
export type ImportRunStatus = 'running' | 'success' | 'failed'

/** 导入产物统计（按实体计数，运行结束写入，运行中为全零） */
export interface ImportRunStats {
  questions: number
  questionGroups: number
  images: number
  knowledgePoints: number
}

/** 一次导入运行：version 单调递增，input_digest 判断输入是否变化（变化 → 新 version 再蒸馏） */
export const importRuns = sqliteTable(
  'import_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 导入版本号（同 version 重跑幂等覆盖；人工全量再蒸馏时递增） */
    version: integer('version').notNull(),
    status: text('status').notNull().default('running').$type<ImportRunStatus>(),
    /** 输入摘要（来源仓库快照指纹，如 commit + 内容哈希） */
    inputDigest: text('input_digest').notNull(),
    stats: text('stats', { mode: 'json' }).$type<ImportRunStats>().notNull(),
    /** 失败原因（status = failed 时必填） */
    errorMessage: text('error_message'),
    finishedAt: text('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('import_runs_version_uq').on(table.version)],
)
