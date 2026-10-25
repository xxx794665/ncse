/**
 * @ncse/shared — 前后端共用类型与常量。
 * 已承载：统一错误信封、数据层同构类型（富片段、枚举，T1-02 起与 Drizzle schema 共用）、
 * 考试蓝图与每题时限推导（T1-07，见 blueprint.ts）、练习会话 DTO（T1-08b）、
 * 判分与错题本 DTO（T1-08c）、错题本/难点本列表与收藏 DTO 及建会话 wrong_redo 模式（T1-10a）、
 * 需加强清单 DTO 与建会话 reinforce 模式（M3/T3-01e）、
 * 统计汇总 DTO（T1-11a）、整卷模考推导与 DTO（T2-01b，见 mock.ts）、
 * 知识点树常量/校验与树查询 DTO（M3/T3-01a，见 knowledge-tree.ts，ADR-0013）；
 * 后续将承载：其余业务 DTO 等。
 */

import type { XingceModuleCode } from './blueprint.js'

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
 * T1-03 已扩充 bad_request / unauthorized / conflict。
 */
export const API_ERROR_CODES = {
  /** 请求参数不合法（400：校验失败、请求体缺失或不可解析） */
  bad_request: 'bad_request',
  /** 未认证或认证失效（401：Bearer 缺失/无效/过期，用户名或密码错误） */
  unauthorized: 'unauthorized',
  /** 资源不存在（404） */
  not_found: 'not_found',
  /** 资源冲突（409：如用户名已被注册） */
  conflict: 'conflict',
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

/**
 * R2 图片内容寻址键形态（ADR-0007：img/<源字节 sha256 64hex>.webp|.gif）。
 * DB 恒存裸键，访问 URL = /api/img/<裸键>；practice 域投影与 img 端点键校验两端共用，勿单方改。
 */
export const IMAGE_KEY_PATTERN = /^img\/[0-9a-f]{64}\.(webp|gif)$/

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

/** 逐题练习模式：按模块专项 / 按知识点专项 / 随机 / 错题重做 / 需加强强化 */
export type PracticeMode = 'module' | 'knowledge' | 'random' | 'wrong_redo' | 'reinforce'

/** 练习会话状态（in_progress 支持中断跨设备续做；abandoned = 用户显式放弃） */
export type PracticeSessionStatus = 'in_progress' | 'finished' | 'abandoned'

/** 整卷模拟会话状态（in_progress 支持中断续做） */
export type MockSessionStatus = 'in_progress' | 'submitted' | 'abandoned'

/**
 * 错题本条目状态（ADR-0010）：active 在错题本 / hard 在难点本（用户归置）/
 * eliminated 已移除（软保留计数，答错任意在册题自动复活为 active）。
 */
export type WrongBookStatus = 'active' | 'eliminated' | 'hard'

/** 汇入强化队列的原因：答错 / 超时 */
export type ReinforceReason = 'wrong' | 'timeout'

/** 强化队列条目状态：pending 待重做 / resolved 已清除（新的汇入原因可复活为 pending） */
export type ReinforceStatus = 'pending' | 'resolved'

/** 掌握度统计目标颗粒：知识点 / 模块（mastery_stats 多态目标） */
export type MasteryTargetType = 'knowledge_point' | 'module'

/* ============ 认证 DTO（T1-03 定稿，前端 T1-08 直接复用） ============ */

/**
 * 登录后对外的当前用户视图。
 * 不含 password_hash 等敏感字段；role 取值与 users.role 列
 * （apps/api/src/db/schema/account.ts 的 UserRole）对齐，两端勿单方扩值。
 */
export interface AuthUser {
  id: number
  username: string
  role: 'user' | 'admin'
}

/** POST /api/auth/register 请求体 */
export interface RegisterRequest {
  username: string
  password: string
}

/** POST /api/auth/login 请求体 */
export interface LoginRequest {
  username: string
  password: string
}

/** 注册/登录成功响应：token 为 Bearer JWT（前端存 localStorage，请求附 Authorization 头） */
export interface AuthResponse {
  token: string
  user: AuthUser
}

/** GET /api/auth/me 响应体（受保护路由） */
export interface MeResponse {
  user: AuthUser
}

/* ============ 练习会话 DTO（T1-08b 定稿，前端 T1-08f 直接复用） ============ */

/**
 * POST /api/practice/sessions 请求体（判别联合，按 mode 分支，T1-10a 扩展、M3/T3-01e 再扩展）：
 * - module 分支：按行测模块抽题（mode 省缺视同 'module'——既有 web 调用与 M1 前端不传 mode，
 *   向后兼容零改动）；
 * - wrong_redo 分支：按错题本/难点本在册条目重做（题目序 = wrong_book.updatedAt 倒序）；
 * - reinforce 分支：按需加强清单 pending 题目建会话（题目序 = reinforce_queue.updatedAt 倒序，
 *   最近汇入在前）。
 * 三分支 count 取值 5/10/20/30（与前端模块选择页的题数选项一致，勿单方扩值），缺省 10；
 * 题目不足 count 时按实际数建会话（不报错），为 0 时 400。
 */
export type CreatePracticeSessionRequest =
  | {
      /** 练习模式（省缺视同 'module'，向后兼容；显式传 'module' 等价） */
      mode?: 'module'
      /** 行测模块编码（六模块之一，非法值 400；module 分支必填） */
      module: XingceModuleCode
      /** 题目数量（5/10/20/30，缺省 10） */
      count?: number
    }
  | {
      /** 错题重做模式（T1-10a） */
      mode: 'wrong_redo'
      /** 重做来源：'active' 错题本 / 'hard' 难点本（非法值 400） */
      source: WrongBookRedoSource
      /** 题目数量（5/10/20/30，缺省 10） */
      count?: number
    }
  | {
      /** 需加强强化模式（M3/T3-01e）：按需加强清单 pending 题目建会话，题目序 = updatedAt 倒序（最近汇入在前） */
      mode: 'reinforce'
      /** 题目数量（5/10/20/30，缺省 10） */
      count?: number
    }

/**
 * 续做回显的已答题目信息：读 practice_records 中该会话该题最近一条
 * （判分端点 POST /api/practice/sessions/:id/answers 落库，T1-08c）。
 */
export interface PracticeAnsweredInfo {
  /** 用户作答内容（单选为选项键，如 'A'） */
  answer: string
  /** 是否答对 */
  isCorrect: boolean
  /** 是否超时 */
  isTimeout: boolean
  /** 本题用时（毫秒） */
  durationMs: number
}

/**
 * 练习会话内的题目视图。
 * 不含答案与解析（服务端判分共识，见 ADR-0009 与任务索引 T1-08 拆片：
 * answer/analysis 仅在判分响应中回发）；
 * 图片段 path 已投影为可渲染绝对 URL（/api/img/<键>，图片端点 T1-08d），text 段原样。
 */
export interface PracticeQuestionDto {
  /** 题目 id（questions 表主键） */
  id: number
  /** 题目类型（M1 仅 'single_choice'） */
  kind: QuestionKind
  /** 题干富片段（图片段 path 已投影 URL） */
  stem: RichContent
  /** 选项数组（含选项键；content 图片段 path 已投影 URL） */
  options: QuestionOption[]
  /** 已答信息（null = 未作答；续做回显用） */
  answered: PracticeAnsweredInfo | null
}

/** GET /api/practice/sessions/:id 响应体（POST 建会话同型，answered 全 null） */
export interface PracticeSessionDetail {
  /** 会话 id */
  id: number
  /** 练习模式（M1 仅 'module'） */
  mode: PracticeMode
  /** 行测模块编码（mode='module' 时非空） */
  moduleCode: XingceModuleCode | null
  /** 会话状态（in_progress | finished | abandoned，任意状态均可取详情） */
  status: PracticeSessionStatus
  /** 题目总数（questionIds 清单长度） */
  total: number
  /** 会话内已答题目数（去重） */
  answeredCount: number
  /** 题目列表（序 = 会话 questionIds 序；不含答案与解析） */
  questions: PracticeQuestionDto[]
}

/** GET /api/practice/sessions 列表项（当前用户 in_progress 会话，createdAt 倒序） */
export interface PracticeSessionSummary {
  /** 会话 id */
  id: number
  /** 练习模式（M1 仅 'module'） */
  mode: PracticeMode
  /** 行测模块编码（mode='module' 时非空） */
  moduleCode: XingceModuleCode | null
  /** 会话状态（列表恒为 in_progress） */
  status: PracticeSessionStatus
  /** 题目总数（questionIds 清单长度） */
  total: number
  /** 会话内已答题目数（去重） */
  answeredCount: number
  /** 创建时间（ISO-8601 UTC） */
  createdAt: string
}

/* ============ 判分与错题本 DTO（T1-08c 定稿，前端 T1-08f 直接复用） ============ */

/**
 * POST /api/practice/sessions/:id/answers 请求体。
 * questionId 不属于该会话题目清单、answer 非该题选项键、durationMs 超出
 * [0, 86400000) 整数区间时均 400（判分前拒绝，不落任何记录）。
 */
export interface SubmitPracticeAnswerRequest {
  /** 题目 id（正整数，须属于该会话的 questionIds 清单） */
  questionId: number
  /** 用户作答（单选为选项键，如 'A'；须是该题 options[].key 之一） */
  answer: string
  /** 本题用时（毫秒，整数，0 ≤ 值 < 86400000） */
  durationMs: number
}

/**
 * 判分响应中的错题本上下文：该题经判分状态机执行后的在册状态。
 * null = 不在册且本次答对（答对不在册不建行，ADR-0010）；
 * 答对在册时前端据此弹处置提示（每次答对在册 active 题均提示，忽略 = 保持）。
 */
export interface WrongBookContext {
  /** 状态机执行后的条目状态（答错任意在册题恒 'active'——复活语义） */
  status: WrongBookStatus
}

/**
 * POST /api/practice/sessions/:id/answers 响应体。
 * correctAnswer/analysis 仅判分后回发（服务端判分共识，见 ADR-0009）；
 * analysis 图片段 path 已投影为可渲染绝对 URL（/api/img/<键>，图片端点 T1-08d）。
 */
export interface SubmitPracticeAnswerResponse {
  /** 题目 id（回显请求值） */
  questionId: number
  /** 是否答对（服务端与题目答案比对，单选为选项键相等） */
  isCorrect: boolean
  /** 是否超时（用时严格大于每题时限才超时；模块未知不判超时） */
  isTimeout: boolean
  /** 正确答案（选项键） */
  correctAnswer: string
  /** 解析富片段（图片段 path 已投影 URL） */
  analysis: RichContent
  /** 错题本上下文（null = 不在册且答对） */
  wrongBook: WrongBookContext | null
  /** 判分后的会话状态（全部作答完成则 'finished'，否则保持原值，ADR-0009） */
  sessionStatus: PracticeSessionStatus
}

/**
 * 错题本处置动作（ADR-0010：消灭由用户处置取代自动连对）：
 * remove = 移出（软移除，计数保留） / to_hard = 归入难点本。
 */
export type WrongBookDisposeAction = 'remove' | 'to_hard'

/** POST /api/wrong-book/:questionId/disposal 请求体 */
export interface WrongBookDisposeRequest {
  /** 处置动作（'remove' → eliminated；'to_hard' → hard） */
  action: WrongBookDisposeAction
}

/**
 * POST /api/wrong-book/:questionId/disposal 响应体。
 * 处置只翻转状态，wrongCount/redoCount/consecutiveCorrect 原值保留（计数随作答演进）。
 */
export interface WrongBookDisposeResponse {
  /** 题目 id（回显路径参数） */
  questionId: number
  /** 处置后的条目状态 */
  status: WrongBookStatus
  /** 累计答错次数（处置不变更） */
  wrongCount: number
  /** 累计重做次数（处置不变更） */
  redoCount: number
  /** 重做连续答对次数（处置不变更；仅供后续分析，ADR-0010） */
  consecutiveCorrect: number
}

/* ============ 错题本/难点本列表与收藏 DTO（T1-10a 定稿，前端 T1-10b 直接复用） ============ */

/** 错题重做会话的来源（CreatePracticeSessionRequest 的 wrong_redo 分支）：错题本 / 难点本 */
export type WrongBookRedoSource = 'active' | 'hard'

/**
 * GET /api/wrong-book?status=active|hard 列表项（错题本/难点本，T1-10a）。
 * status 缺省 'active'，仅容 'active'|'hard'；eliminated 软移除条目永不列出（ADR-0010）。
 * 排序 updatedAt 倒序（最近变化在前），id 倒序并列稳定。
 */
export interface WrongBookEntrySummary {
  /** 题目 id（questions 表主键） */
  questionId: number
  /** 行测模块编码（题目当前所属模块；悬空题行整条跳过，故恒非空） */
  moduleCode: XingceModuleCode
  /**
   * 题干预览（服务端生成）：stem 的 text 段以空格连接，超 80 字符截断加「…」；
   * 无 text 段（纯图题）为「（图片题）」。
   */
  stemPreview: string
  /** 累计答错次数 */
  wrongCount: number
  /** 累计重做次数 */
  redoCount: number
  /** 条目状态（列表恒为查询指定的 active 或 hard） */
  status: WrongBookStatus
  /** 最近变化时间（ISO-8601 UTC，作答/处置均刷新） */
  updatedAt: string
}

/**
 * GET /api/favorites 列表项（收藏夹，T1-10a）。
 * 取消收藏即删行（schema 设计），列表只反映在册行；排序 createdAt 倒序（最近收藏在前），id 倒序并列稳定。
 */
export interface FavoriteSummary {
  /** 题目 id（questions 表主键） */
  questionId: number
  /** 行测模块编码（题目当前所属模块；悬空题行整条跳过，故恒非空） */
  moduleCode: XingceModuleCode
  /** 题干预览（生成规则同 WrongBookEntrySummary.stemPreview，两端共用后端同一实现） */
  stemPreview: string
  /** 收藏时间（ISO-8601 UTC） */
  favoritedAt: string
}

/**
 * POST /api/favorites/:questionId 与 DELETE /api/favorites/:questionId 响应体（T1-10a）。
 * 幂等：重复收藏（onConflictDoNothing）与取消不存在的收藏均恒 200，
 * 语义为「操作后该题是否在当前用户收藏」（POST 恒 true、DELETE 恒 false）。
 */
export interface FavoriteToggleResponse {
  /** 题目 id（回显路径参数） */
  questionId: number
  /** 操作后是否在收藏（POST 恒 true、DELETE 恒 false） */
  favorited: boolean
}

/* ============ 需加强清单 DTO（M3/T3-01e 定稿） ============ */

/**
 * GET /api/reinforce?status=pending|resolved 列表项（需加强清单，M3/T3-01e）。
 * 全自动强化队列（与错题本并存：错题本是用户处置状态机，本队列无任何用户处置动作）：
 * 汇入（答错/超时，练习判分与模考交卷同口径）与出队（仅练习判分答对且不超时）由判分联动。
 * status 缺省 'pending'，仅容 'pending'|'resolved'（白名单外 400）；
 * 排序 updatedAt 倒序（最近汇入在前），id 倒序并列稳定。
 */
export interface ReinforceEntrySummary {
  /** 题目 id（questions 表主键） */
  questionId: number
  /** 行测模块编码（题目当前所属模块；悬空题行整条跳过，故恒非空） */
  moduleCode: XingceModuleCode
  /**
   * 题干预览（服务端生成）：stem 的 text 段以空格连接，超 80 字符截断加「…」；
   * 无 text 段（纯图题）为「（图片题）」。
   */
  stemPreview: string
  /** 汇入原因（最近一次触发覆盖：答错 'wrong' / 答对但超时 'timeout'；答错且超时同用记 wrong） */
  reason: ReinforceReason
  /** 条目状态（列表恒为查询指定的 pending 或 resolved） */
  status: ReinforceStatus
  /** 最近变化时间（ISO-8601 UTC，汇入/出队均刷新） */
  updatedAt: string
}

/* ============ 统计 DTO（T1-11a 定稿，前端 T1-11b 直接复用） ============ */

/** 统计趋势窗口天数（GET /api/stats/summary 的 daily 数组长度与窗口口径；两端共用同一常量，勿单方改值） */
export const STATS_TREND_DAYS = 30

/**
 * 练习作答的全历史聚合（GET /api/stats/summary 的 overall，T1-11a）。
 * 正确率与均时刻意不预计算：前端由 correct/answered、totalDurationMs/answered 派生
 * （answered=0 时除零兜底归前端处理，服务端不特判）。
 */
export interface PracticeOverallStats {
  /** 累计作答次数（practice_records 行数） */
  answered: number
  /** 累计答对次数 */
  correct: number
  /** 累计用时（毫秒） */
  totalDurationMs: number
  /** 累计超时次数 */
  timeoutCount: number
}

/**
 * 分模块作答聚合（GET /api/stats/summary 的 modules，T1-11a）。
 * 仅含有作答记录的模块（无记录模块不出现，前端自行零填），moduleCode 升序。
 */
export interface PracticeModuleStat {
  /** 行测模块编码 */
  moduleCode: XingceModuleCode
  /** 该模块累计作答次数 */
  answered: number
  /** 该模块累计答对次数 */
  correct: number
  /** 该模块累计用时（毫秒） */
  totalDurationMs: number
  /** 该模块累计超时次数 */
  timeoutCount: number
}

/**
 * 逐日作答趋势项（GET /api/stats/summary 的 daily，T1-11a）。
 * date 为北京时间日（'YYYY-MM-DD'，中国省考受众的日界）；数组恰 STATS_TREND_DAYS 项、
 * 日期升序（最旧在前、北京时间今日在末）、中间无记录的天零填空。
 */
export interface PracticeDailyStat {
  /** 北京时间日（'YYYY-MM-DD'） */
  date: string
  /** 当日作答次数 */
  answered: number
  /** 当日答对次数 */
  correct: number
}

/**
 * GET /api/stats/summary 响应体（T1-11a，直接返回不包壳）。
 * overall 与 modules 为全历史聚合（窗口外的历史记录仍计入）；daily 只反映最近
 * STATS_TREND_DAYS 天窗口（窗口外不计入，见 statsRoute 文件头）。
 */
export interface StatsSummaryResponse {
  /** 全历史聚合 */
  overall: PracticeOverallStats
  /** 分模块聚合（仅含有作答记录的模块，moduleCode 升序） */
  modules: PracticeModuleStat[]
  /** 近 STATS_TREND_DAYS 天北京时间日趋势（零填空、升序、今日在末） */
  daily: PracticeDailyStat[]
}

export * from './blueprint.js'
export * from './knowledge-tree.js'
export * from './mock.js'
