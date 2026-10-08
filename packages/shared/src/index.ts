/**
 * @ncse/shared — 前后端共用类型与常量。
 * 已承载：统一错误信封、数据层同构类型（富片段、枚举，T1-02 起与 Drizzle schema 共用）；
 * 后续将承载：业务 DTO、考试蓝图与每题时限推导（T1-07）等。
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

/* ============ 数据层同构类型（T1-02 定稿，Drizzle schema 与前端渲染共用） ============ */

/**
 * 富片段：题干/材料/选项/解析共用的「文本段 + 图片引用」混合结构。
 * 图片 path 为 R2 对象路径（导入管线写入，前端取图时再拼访问 URL）。
 */
export type RichSegment = { type: 'text'; text: string } | { type: 'image'; path: string; alt?: string }

/** 完整富片段序列（D1 中以 JSON 数组存于 TEXT 列，Drizzle text json 模式序列化/反序列化） */
export type RichContent = RichSegment[]

/** 单选项：key 为 answer 引用的选项键（如 'A'/'B'），content 为选项内容富片段 */
export interface QuestionOption {
  key: string
  content: RichContent
}

/** 题目类型：M1 仅单选；多选/填空/主观题等扩展值逐里程碑追加（一律存字符串，勿存数字） */
export type QuestionKind = 'single_choice'

/** 难度分级（AI 估计或人工标定；数据库可空 = 未标定） */
export type QuestionDifficulty = 'easy' | 'medium' | 'hard'

/** 知识点打标来源：官方 / AI 打标 / 人工校对 */
export type TagSource = 'official' | 'ai' | 'human_verified'

/** 逐题练习模式：按模块专项 / 按知识点专项 / 随机 / 错题重做 */
export type PracticeMode = 'module' | 'knowledge' | 'random' | 'wrong_redo'

/** 整卷模拟会话状态（in_progress 支持中断续做） */
export type MockSessionStatus = 'in_progress' | 'submitted' | 'abandoned'

/** 错题本条目状态：active 待消灭 / eliminated 已消灭（再次答错会复活为 active） */
export type WrongBookStatus = 'active' | 'eliminated'

/** 汇入强化队列的原因：答错 / 超时 */
export type ReinforceReason = 'wrong' | 'timeout'

/** 强化队列条目状态：pending 待重做 / resolved 已清除（新的汇入原因可复活为 pending） */
export type ReinforceStatus = 'pending' | 'resolved'

/** 掌握度统计目标颗粒：知识点 / 模块（mastery_stats 多态目标） */
export type MasteryTargetType = 'knowledge_point' | 'module'
