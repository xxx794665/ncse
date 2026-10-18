/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** 构建期注入的环境变量（值来源：.env.development 本地开发 / .env.production 线上构建） */
interface ImportMetaEnv {
  /** API 基址（如 http://localhost:8787）；缺省/空串 = 同源相对路径形态 */
  readonly VITE_API_BASE_URL?: string
  /** 站点子路径（如 /ncse/）：构建期由 vite.config.ts 读取为 base；应用侧经 BASE_URL 消费，缺省 / */
  readonly VITE_BASE_PATH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
