import { sql } from 'drizzle-orm'
import { text } from 'drizzle-orm/sqlite-core'

/**
 * 时间戳列约定：TEXT 存 ISO-8601 UTC（如 2026-10-08T03:04:05.678Z）。
 * 插入默认值由 SQLite strftime 在库端计算，不依赖写入方时钟；
 * updated_at 额外挂 $onUpdate：仅经 Drizzle 查询构建器更新时由 ORM 刷新（原生 SQL 更新不触发，需自查）。
 */
export const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)

export const updatedAt = () =>
  text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    .$onUpdate(() => new Date().toISOString())
