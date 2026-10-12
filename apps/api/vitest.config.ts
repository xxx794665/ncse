import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { TEST_JWT_SECRET } from './test/test-secret.ts'

/**
 * Vitest 配置（T1-03 测试方案定稿）：@cloudflare/vitest-plugin 在 workerd 运行时内跑测试，
 * 经 wrangler.toml 提供主入口（main = src/index.ts）与 DB 绑定（本地 D1 实例，不触远端）；
 * 迁移在 setup 文件里用 applyD1Migrations 应用 apps/api/migrations。
 * 注：@cloudflare/vitest-pool-workers 已更名为 @cloudflare/vitest-plugin（同一血统的
 * 官方 Workers Vitest 集成，机制不变），详见任务汇报。
 */
export default defineConfig(async () => {
  // 读取全部迁移（按序号排序、拆分为语句数组），经绑定注入给 setup 文件
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // miniflare 层覆盖/追加绑定（优先级高于 wrangler 配置）：
          // JWT_SECRET 为 test-only 常量；TEST_MIGRATIONS 仅供 setup 消费；
          // IMAGES R2 桶显式与 wrangler.toml 同名（绑定名 → 桶名映射，miniflare V4 选项形态），
          // vitest 内 R2 为 miniflare 本地模拟，与 `wrangler dev` 的 .wrangler/state 本地态是不同存储目录。
          bindings: {
            JWT_SECRET: TEST_JWT_SECRET,
            TEST_MIGRATIONS: migrations,
          },
          r2Buckets: { IMAGES: 'ncse-images' },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  }
})
