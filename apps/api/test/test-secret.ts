/**
 * 测试专用 JWT 密钥（T1-03 测试纪律）：显式的 test-only 常量。
 * 不可能被用于任何真实环境——生产密钥由 `wrangler secret put JWT_SECRET` 注入，
 * 本地开发密钥只存在于不入库的 .dev.vars；源码/测试中不得出现可用凭据字面量。
 */
export const TEST_JWT_SECRET = 'test-only-jwt-secret-勿用于任何环境'
