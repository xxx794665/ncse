/**
 * Workers 环境绑定类型（全 app 及各子路由统一 `Hono<{ Bindings: Env }>`）。
 * 约定：凡绑定与凭据一律走 wrangler 配置与 secret，不写入源码：
 * - T1-02 起：挂 D1 数据库（wrangler.toml 中 [d1_databases] 绑定）；
 * - T1-03 起：挂 JWT_SECRET（`wrangler secret put JWT_SECRET`，本地用不入库的 .dev.vars）。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 有意保持空接口：T1-02/T1-03 绑定落地后再补字段
export interface Env {}
