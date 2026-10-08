/**
 * Workers 环境绑定类型（全 app 及各子路由统一 `Hono<{ Bindings: Env }>`）。
 * 约定：凡绑定与凭据一律走 wrangler 配置与 secret，不写入源码：
 * - T1-02（已落地）：D1 数据库（wrangler.toml [[d1_databases]]，绑定名 DB；schema 与迁移见 src/db/）；
 * - T1-03 起：JWT_SECRET（`wrangler secret put JWT_SECRET`，本地用不入库的 .dev.vars）。
 */
export interface Env {
  /** D1 数据库绑定（database_name = ncse-db）；类型化客户端经 src/db/index.ts 的 createDb(env) 获取 */
  DB: D1Database
}
