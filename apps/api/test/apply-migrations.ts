import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// setup 文件在每测试文件的存储隔离之外执行、可能被多次调用：
// applyD1Migrations 只应用 d1_migrations 表未记录过的迁移，重复调用幂等。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
