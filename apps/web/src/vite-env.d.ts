/// <reference types="vite/client" />

/** 构建期注入的环境变量（值来源：.env.development 本地开发 / T1-13 部署时按环境注入） */
interface ImportMetaEnv {
  /** API 基址（如 http://localhost:8787）；缺省/空串 = 同源相对路径形态 */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
