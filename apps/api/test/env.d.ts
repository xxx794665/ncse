/**
 * 测试侧环境类型（cloudflare:workers 的 env / exports 的类型来源）：
 * - Cloudflare.Env：测试 worker 的绑定——DB 与 JWT_SECRET 来自 wrangler.toml
 *   + miniflare 覆盖（见 vitest.config.ts），TEST_MIGRATIONS 仅 setup 消费；
 * - GlobalProps.mainModule：主入口 src/index.ts，使 exports.default 的 fetch 可按类型调用。
 */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    JWT_SECRET: string
    /** 迁移清单（vitest.config.ts 经 miniflare bindings 注入） */
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
  interface GlobalProps {
    mainModule: typeof import('../src/index')
  }
}
