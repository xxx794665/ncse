/**
 * CORS 白名单：正式前端 Origin 列表。
 * 正式域名（GH Pages 自定义域，T1-13c 用户落地）：https://ncse.xxx794665.party
 * （旧 github.io 项目页 origin 已随自定义域名收敛移除——github.io/ncse/ 现已 301 至正式域名，
 * 该 origin 不再实际运行应用）；本地开发另放行 vite dev server（http://localhost:5173）。
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://ncse.xxx794665.party',
  'http://localhost:5173',
]

export function isAllowedOrigin(
  origin: string | null | undefined,
): origin is string {
  return typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin)
}
