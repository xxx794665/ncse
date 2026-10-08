/**
 * @ncse/shared — 前后端共用类型与常量（占位）。
 * 后续将承载：DTO、枚举、考试蓝图与每题时限推导（T1-07）等。
 */

/** 应用基本信息（占位类型） */
export interface AppInfo {
  /** 应用名（ncse） */
  name: string
  /** 当前阶段标识，如 "M0-scaffold" */
  phase: string
}

/** GET /healthz 响应体 */
export interface HealthzResponse {
  status: 'ok'
  service: string
  time: string
}

/**
 * 统一错误响应信封（API 层唯一错误格式，前后端同构）。
 * 成功响应直接返回 DTO，不包 success 壳；仅错误走本信封。
 */
export interface ApiErrorBody {
  error: {
    /** 稳定语义错误码（取值见 API_ERROR_CODES，客户端据此分支处理） */
    code: string
    /** 人类可读消息（面向最终用户，不包含内部细节） */
    message: string
  }
}

/**
 * API 稳定语义错误码（字符串字面量常量，客户端不得依赖 HTTP status 文本）。
 * T1-03 认证落地时按需扩充（如 unauthorized、bad_request 等）。
 */
export const API_ERROR_CODES = {
  /** 资源不存在（404） */
  not_found: 'not_found',
  /** 未预期的服务端错误（5xx） */
  internal_error: 'internal_error',
} as const

/** API_ERROR_CODES 的值联合类型 */
export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]
