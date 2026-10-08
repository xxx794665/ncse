import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import * as schema from './schema'
import type { Env } from '../types'

/** 类型化数据库客户端（表定义与 json 模式列的 TS 类型均由 schema 推导） */
export type DbClient = DrizzleD1Database<typeof schema>

/** 从 Workers 环境的 D1 绑定创建 Drizzle 客户端（T1-03 起各业务路由经 c.env 获取） */
export function createDb(env: Env): DbClient {
  return drizzle(env.DB, { schema })
}
