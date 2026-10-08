import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { createdAt, updatedAt } from './common'

/** 账号角色（预留：SaaS 化扩展用，默认普通用户） */
export type UserRole = 'user' | 'admin'

/** 用户：username 全局唯一；password_hash 只存哈希（算法 T1-03 定稿），绝不存明文 */
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('user').$type<UserRole>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('users_username_uq').on(table.username)],
)

/**
 * 账号级 OpenAI 兼容配置（ADR-0005：AI 代理调用由服务端代发）。
 * api_key_encrypted 为加密密文：解密只发生在服务端运行时（主钥为 Workers secret），
 * Key 绝不以明文出库、不回传客户端、不写入日志。
 */
export const aiSettings = sqliteTable(
  'ai_settings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** OpenAI 兼容服务的 baseURL（仅公网 http/https，服务端请求前校验 host） */
    baseUrl: text('base_url').notNull(),
    /** 加密后的用户 API Key（加密方案 T1-03+ 落地，列名即契约：只存密文） */
    apiKeyEncrypted: text('api_key_encrypted').notNull(),
    /** 模型名（OpenAI 兼容命名，如 glm-4.7） */
    model: text('model').notNull(),
    /** 单次请求参数上限：max_tokens（申论批改文本量大，默认取架构设计 §5 的大值上限） */
    maxTokens: integer('max_tokens').notNull().default(16384),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('ai_settings_user_id_uq').on(table.userId)],
)
