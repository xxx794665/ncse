/**
 * 整卷模考推导与 DTO（T2-01b，M2 拆片定稿 D2/D3/D4/D5/D6/D8）：
 * 试卷完整度分档（D2）与默认整卷时长推导（D3）为纯函数——前后端共用同一口径，勿单方改阈值；
 * DTO 覆盖试卷目录、模考会话生命周期（建会话/列表/详情）、作答/计时上报与交卷成绩单。
 * 类型依赖 index.ts 的数据层同构类型（type-only 导入，编译后无运行时循环）。
 */
import type { XingceModuleCode } from './blueprint.js'
import type { MockSessionStatus, QuestionKind, QuestionOption, RichContent } from './index.js'

/* ============ 完整度分档与整卷时长推导（纯函数，两端共用） ============ */

/** 试卷完整度（D2：全部卷开放，按题数标注完整/部分/残卷供前端置顶推荐与提示） */
export type PaperCompleteness = 'full' | 'partial' | 'fragment'

/** 完整卷最小题数（题数 ≥ 本值为 full；真实省考行测卷普遍 100–135 题，取保守下沿） */
export const PAPER_FULL_MIN_QUESTIONS = 110

/** 部分卷最小题数（题数 ≥ 本值为 partial，否则 fragment；残卷 = 可考但明显缺模块/题量） */
export const PAPER_PARTIAL_MIN_QUESTIONS = 30

/** 试卷完整度分档（D2）：题数 ≥110 为 full、≥30 为 partial、其余 fragment */
export function classifyPaperCompleteness(questionCount: number): PaperCompleteness {
  if (questionCount >= PAPER_FULL_MIN_QUESTIONS) {
    return 'full'
  }
  return questionCount >= PAPER_PARTIAL_MIN_QUESTIONS ? 'partial' : 'fragment'
}

/** 显式整卷时长的合法下限（分钟，D3：开考前可调） */
export const MOCK_TOTAL_MINUTES_MIN = 5

/** 显式整卷时长的合法上限（分钟，10 小时——防荒谬值，超长模考本身失去模拟意义） */
export const MOCK_TOTAL_MINUTES_MAX = 600

/**
 * 默认整卷时长推导（D3）：1 题/分钟，向上取整到 5 分钟的倍数，下限钳 5
 * （即使残卷也保留最短完整作答窗口）。开考前 totalMinutes 缺省时服务端按本推导固化。
 */
export function deriveMockTotalMinutes(questionCount: number): number {
  return Math.max(MOCK_TOTAL_MINUTES_MIN, Math.ceil(questionCount / 5) * 5)
}

/* ============ 试卷目录与会话生命周期 DTO（T2-01b 定稿，前端直接复用） ============ */

/** GET /api/papers 列表项（全量卷目录，自用规模一次下发不分页） */
export interface PaperSummary {
  /** 试卷 id（papers 表主键） */
  id: number
  /** 卷名（导入自然键，全库唯一） */
  name: string
  /** 年份（null = 未标定） */
  year: number | null
  /** 地区（null = 未标定） */
  region: string | null
  /** 卷型（null = 未标定，自由文本如 '联考'） */
  paperType: string | null
  /** 本次导入实际归属题数（question_papers 实际 pair 数） */
  questionCount: number
  /** 完整度分档（服务端按 questionCount 经 classifyPaperCompleteness 派生） */
  completeness: PaperCompleteness
}

/** POST /api/mock/sessions 请求体（totalMinutes 省缺按题数推导，D3） */
export interface CreateMockSessionRequest {
  /** 试卷 id（正整数；不存在 404） */
  paperId: number
  /** 整卷时长（分钟，整数，[MOCK_TOTAL_MINUTES_MIN, MOCK_TOTAL_MINUTES_MAX]；开考前可调，开考即固化） */
  totalMinutes?: number
}

/**
 * 模考会话内的已答回显（MockQuestionDto.answered 的形状）。
 * 刻意不含判分结果（D4：作答中不下发答案/解析，交卷统一判分）；交卷后的成绩 DTO 由后续片另定义。
 */
export interface MockAnsweredInfo {
  /** 用户作答内容（单选为选项键，如 'A'） */
  answer: string
  /** 本题用时（毫秒，作答端点上报） */
  durationMs: number
}

/**
 * 模考会话内的题目视图（D4：不含答案与解析——交卷统一判分后才回发）；
 * 图片段 path 已投影为可渲染绝对 URL（/api/img/<键>），text 段原样。
 */
export interface MockQuestionDto {
  /** 题目 id（questions 表主键） */
  id: number
  /** 题目所属行测模块编码（modules.code） */
  moduleCode: XingceModuleCode
  /** 题目类型（M1 仅 'single_choice'） */
  kind: QuestionKind
  /** 题干富片段（图片段 path 已投影 URL） */
  stem: RichContent
  /** 选项数组（含选项键；content 图片段 path 已投影 URL） */
  options: QuestionOption[]
  /** 已答回显（null = 未作答；不含判分结果，D4） */
  answered: MockAnsweredInfo | null
}

/** GET /api/mock/sessions/:id 响应体（POST /api/mock/sessions 同型，answered 全 null、elapsedMs 0） */
export interface MockSessionDetail {
  /** 会话 id */
  id: number
  /** 所考试卷（目录项同型；取卷行当前值——restrict 保证行存在） */
  paper: PaperSummary
  /** 卷型蓝图编码（分析锚，前端展示蓝图名称用） */
  blueprintCode: string
  /** 开考锁定的整卷时长（分钟，D3） */
  totalMinutes: number
  /** 计时累计（毫秒，D6：前端上报绝对值，服务端原样回发） */
  elapsedMs: number
  /** 会话状态（in_progress | submitted | abandoned，任意状态均可取——交卷后回看） */
  status: MockSessionStatus
  /** 题目总数（questionIds 快照长度，悬空题不计入 questions 但计入 total） */
  total: number
  /** 已答题目数（会话内 mock_answers 行数） */
  answeredCount: number
  /** 题目列表（序 = questionIds 快照序 = 开考时卷内题序；不含答案/解析，D4） */
  questions: MockQuestionDto[]
}

/** GET /api/mock/sessions 列表项（当前用户 in_progress 会话，createdAt 倒序） */
export interface MockSessionSummary {
  /** 会话 id */
  id: number
  /** 卷名 */
  paperName: string
  /** 卷年份（null = 未标定） */
  paperYear: number | null
  /** 开考锁定的整卷时长（分钟） */
  totalMinutes: number
  /** 计时累计（毫秒） */
  elapsedMs: number
  /** 会话状态（列表恒 in_progress） */
  status: MockSessionStatus
  /** 题目总数（questionIds 快照长度） */
  total: number
  /** 已答题目数（会话内 mock_answers 行数） */
  answeredCount: number
  /** 创建时间（ISO-8601 UTC） */
  createdAt: string
}

/* ============ 作答与计时上报 DTO（T2-01b 第四子片，D4/D6） ============ */

/**
 * 用时类数值的合法上限（毫秒）：24 小时——与练习域 MAX_DURATION_MS 同上限惯例，
 * 防把时间戳等荒谬值当用时落库。每题 durationMs 与会话 elapsedMs 共用本上限
 * （均为 [0, MOCK_MAX_DURATION_MS) 整数区间）。
 */
export const MOCK_MAX_DURATION_MS = 24 * 60 * 60 * 1000

/**
 * POST /api/mock/sessions/:id/answers 请求体（逐题作答，D4：作答中不判分不下发答案/解析）。
 * questionId 不属于该会话快照清单、answer 非该题选项键、durationMs 超出
 * [0, MOCK_MAX_DURATION_MS) 整数区间时均 400（不落库）；会话非 in_progress 时 400。
 */
export interface SubmitMockAnswerRequest {
  /** 题目 id（正整数，须属于会话 questionIds 快照清单） */
  questionId: number
  /** 用户作答（单选为选项键，如 'A'；须是该题 options[].key 之一） */
  answer: string
  /**
   * 本题停留用时累计的绝对值（毫秒）：前端跨多次进入/切题累计后上报，
   * 服务端对既有行取 max 落库——防乱序/重复上报回退缩水与重复累计。
   */
  durationMs: number
}

/**
 * POST /api/mock/sessions/:id/answers 响应体（轻响应）：
 * 不回发题目详情，前端 react-query invalidate 会话详情重新拉取（answered 回显走详情端点）。
 */
export interface SubmitMockAnswerResponse {
  /** 题目 id（回显请求值） */
  questionId: number
  /** 作答后会话内已答题目数（mock_answers 行数） */
  answeredCount: number
}

/**
 * POST /api/mock/sessions/:id/timer 请求体（计时上报，D6：累计绝对值口径）。
 * 服务端不做墙钟推导，跨设备续考以 mock_sessions.elapsedMs 恢复基线；
 * elapsedMs 超出 [0, MOCK_MAX_DURATION_MS) 整数区间 400；会话非 in_progress 时 400。
 */
export interface UpdateMockTimerRequest {
  /** 计时累计（毫秒，整数，0 ≤ 值 < MOCK_MAX_DURATION_MS；前端累计绝对值） */
  elapsedMs: number
}

/** POST /api/mock/sessions/:id/timer 响应体：服务端 max 防回退后的落库值，前端据回发值校准本地基线 */
export interface UpdateMockTimerResponse {
  /** 计时累计落库值（毫秒，与请求值的较大者——防回退） */
  elapsedMs: number
}

/* ============ 交卷判分与成绩单 DTO（T2-01b 第五子片，D4/D5/D8） ============ */

/**
 * 模考成绩单总览聚合（MockSessionReport.summary）。
 * 计数给、率不给：正确率等由前端派生（沿用 PracticeOverallStats 先例，服务端不预计算，
 * 除零兜底归前端处理）。
 */
export interface MockReportSummary {
  /** 题目总数（快照内实际存在题目行的题数，悬空 id 不计——与交卷判分口径一致） */
  total: number
  /** 已答题数（已判分行数；交卷后已答行恒已判分，abandoned 未判分行不计） */
  answered: number
  /** 答对题数 */
  correct: number
  /** 未答题数（total - answered） */
  unanswered: number
  /** 超时题数（已判分行 isTimeout 计数；D5 仅供成绩单分析） */
  timeoutCount: number
  /** 已判分行用时合计（毫秒） */
  totalDurationMs: number
}

/**
 * 模考成绩单分模块聚合（MockSessionReport.modules 项）。
 * 仅列卷内实际出现的模块（蓝图含但卷内无题的模块不出现）；聚合口径同 summary（已答 = 已判分行）。
 */
export interface MockModuleReport {
  /** 行测模块编码 */
  moduleCode: XingceModuleCode
  /** 该模块题目总数（悬空 id 不计） */
  total: number
  /** 该模块已答题数（已判分行数） */
  answered: number
  /** 该模块答对题数 */
  correct: number
  /** 该模块超时题数 */
  timeoutCount: number
  /** 该模块已判分行用时合计（毫秒） */
  totalDurationMs: number
}

/**
 * 模考成绩单逐题项（MockSessionReport.questions 项），供前端对错答题卡回顾。
 * 刻意不含正确答案与解析：交卷后回发正确答案虽合法，但本端点保持克制——
 * 成绩单页要展示解析走既有题目详情或后续需求。
 */
export interface MockReportQuestionItem {
  /** 题目 id（questions 表主键） */
  questionId: number
  /** 行测模块编码 */
  moduleCode: XingceModuleCode
  /** 用户作答（单选为选项键，如 'A'；null = 未作答） */
  answer: string | null
  /** 判分结果（null = 未作答未判分；交卷后已答行恒非空） */
  isCorrect: boolean | null
  /** 是否超时（D5：按蓝图每题时限严格大于判超时，等于不超；未作答恒 false） */
  isTimeout: boolean
  /** 本题用时（毫秒；未作答恒 0） */
  durationMs: number
}

/**
 * POST /api/mock/sessions/:id/submit 与 GET /api/mock/sessions/:id/report 响应体
 * （交卷即回成绩单，两形状逐字段一致；report 全部从库重算，交卷后可随时回看）。
 * submit 对非 in_progress 会话 400（交卷即定卷，重复交卷拒绝）；report 对 in_progress
 * 会话 400（成绩单只对已定卷会话有意义），submitted/abandoned 均可取。
 */
export interface MockSessionReport {
  /** 总览聚合 */
  summary: MockReportSummary
  /** 分模块聚合（序 = 蓝图 modules 序，蓝图未含的模块按编码字典序殿后） */
  modules: MockModuleReport[]
  /** 逐题项（序 = questionIds 快照序 = 开考时卷内题序；悬空 id 跳过） */
  questions: MockReportQuestionItem[]
}
