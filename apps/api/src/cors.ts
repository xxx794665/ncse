/**
 * CORS 白名单（占位常量）。
 * 部署时将 tiku.example.com 替换为正式前端域名（docs/架构设计.md §7、T1-13）；
 * 本地开发另放行 vite dev server（http://localhost:5173）。
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://tiku.example.com',
  'http://localhost:5173',
]

export function isAllowedOrigin(
  origin: string | null | undefined,
): origin is string {
  return typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin)
}
