import type { AuthUser } from '@ncse/shared'

/**
 * Workers 环境绑定类型（全 app 及各子路由统一 `Hono<AppEnv>`）。
 * 约定：凡绑定与凭据一律走 wrangler 配置与 secret，不写入源码：
 * - T1-02（已落地）：D1 数据库（wrangler.toml [[d1_databases]]，绑定名 DB；schema 与迁移见 src/db/）；
 * - T1-03（已落地）：JWT_SECRET（生产 `wrangler secret put JWT_SECRET` 注入，本地走不入库的 .dev.vars，
 *   模板见 .dev.vars.example；源码/示例/测试中只允许出现明显不可用的占位值）。
 */
export interface Env {
  /** D1 数据库绑定（database_name = ncse-db）；类型化客户端经 src/db/index.ts 的 createDb(env) 获取 */
  DB: D1Database
  /** JWT 签名密钥（HS256），仅运行时从环境读取 */
  JWT_SECRET: string
}

/**
 * Hono Variables 注入：requireAuth 中间件（src/auth/middleware.ts）校验通过后写入
 * authUser，后续受保护路由经 `c.get('authUser')` 读取，不再各自解析 token。
 */
export interface Variables {
  authUser: AuthUser
}

/** 全 app 统一的 Hono 环境类型（绑定 + Variables 注入） */
export type AppEnv = { Bindings: Env; Variables: Variables }
