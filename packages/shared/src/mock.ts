/**
 * 整卷模考推导与 DTO（T2-01b，M2 拆片定稿 D2/D3/D4/D6）：
 * 试卷完整度分档（D2）与默认整卷时长推导（D3）为纯函数——前后端共用同一口径，勿单方改阈值；
 * DTO 覆盖试卷目录与模考会话生命周期（建会话/列表/详情）。
 * 作答/计时/交卷 DTO 由后续片在本文件追加（MockAnsweredInfo 已为其预留落位）。
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
