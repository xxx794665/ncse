# Drizzle schema 与 D1 迁移（T1-02）

- `schema/` 按域拆分：account（账号）/ content（内容）/ practice（练习）/ review（复习）/
  essay（申论，M4）/ plan（计划，M5）/ pipeline（导入管线）；`schema/index.ts` 统一 re-export，
  `schema/common.ts` 提供时间戳列约定（TEXT 存 ISO-8601 UTC，库端 strftime 默认值）。
  富片段与枚举 TS 类型取自 @ncse/shared（前后端同构）。
- `index.ts`：`createDb(env)` 由 `Env.DB`（D1 绑定）创建类型化 Drizzle 客户端（`DbClient`）。
- 迁移生成：apps/api 下 `npx drizzle-kit generate`（配置 `drizzle.config.ts`，产物入 `migrations/`）。
- 本地应用：`npx wrangler d1 migrations apply ncse-db --local`（状态存 `.wrangler/`，不入 Git）。
- 远程 `database_id`（wrangler.toml 中现为全零占位）替换与远端应用在 T1-13 部署时处理；
  凭据一律走 `wrangler secret`，本地用不入库的 `.dev.vars`。
