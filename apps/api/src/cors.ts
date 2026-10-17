/**
 * CORS 白名单：正式前端 Origin 列表。
 * 当前为 GH Pages 项目页 origin（仓库 github.com/xxx794665/ncse，站点 https://xxx794665.github.io/ncse/；
 * origin 只含协议+主机，不含 /ncse 路径）；本地开发另放行 vite dev server（http://localhost:5173）。
 * 正式域名（tiku.<域名>）待用户决策后替换/追加（docs/架构设计.md §7、T1-13）。
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://xxx794665.github.io',
  'http://localhost:5173',
]

export function isAllowedOrigin(
  origin: string | null | undefined,
): origin is string {
  return typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin)
}
