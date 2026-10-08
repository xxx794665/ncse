import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit 配置：SQLite（D1）方言，schema 取 src/db/schema 统一导出，
 * 迁移产物输出到 apps/api/migrations/（即 wrangler d1 migrations 目录，见 wrangler.toml）。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/index.ts',
  out: './migrations',
})
