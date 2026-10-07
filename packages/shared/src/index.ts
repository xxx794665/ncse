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

/** 统一 API 返回包装（占位类型，T1-01 路由分层时细化） */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }
