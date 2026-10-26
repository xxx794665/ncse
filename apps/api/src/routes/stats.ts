import { Hono } from 'hono'
import { and, asc, eq, sql, type SQL } from 'drizzle-orm'
import {
  DEFAULT_BLUEPRINT,
  deriveMastery,
  deriveQuestionTimeLimit,
  needsReinforce,
  STATS_TREND_DAYS,
} from '@ncse/shared'
import type {
  KnowledgeMasteryModule,
  KnowledgeMasteryPoint,
  PracticeDailyStat,
  PracticeModuleStat,
  PracticeOverallStats,
  StatsSummaryResponse,
  XingceModuleCode,
} from '@ncse/shared'
import { createDb } from '../db'
import { knowledgePoints, masteryStats, modules, practiceRecords, questions } from '../db/schema'
import { requireAuth } from '../auth/middleware'
import type { AppEnv } from '../types'

/**
 * 统计域路由（T1-11a，挂载于 /api/stats，见 src/routes/api.ts）：
 * - GET /summary：当前用户练习统计汇总——overall 全历史聚合 + modules 分模块聚合
 *   （仅含有作答记录的模块，moduleCode 升序）+ daily 近 STATS_TREND_DAYS 天北京时间日趋势
 *   （零填空、日期升序、今日在末）。窗口外的历史记录仍计入 overall 与 modules，只是 daily 不反映。
 * - GET /knowledge（M3/T3-01d）：当前用户分模块知识点掌握度——mastery_stats 知识点行
 *   innerJoin knowledge_points/modules 取编码名称与定位（仅含有行的知识点，空表/无行
 *   返回 []，打标前空态可用）；模块序 = modules.sort_order（id 并列稳定）、模块内知识点序
 *   = sort_order + id；mastery/needsReinforce 服务端经 shared mastery.ts 派生后随原始计数
 *   一并下发（推导口径两端同锚，勿在此另写公式）；timeLimitSec 按默认标准卷蓝图推导，
 *   卷外模块为 null（该模块各点用时得分按 0 处理，见 shared deriveMastery 防御口径）；
 *   模块级掌握度不落行不现算下发（D4 决策：本端点只出知识点颗粒）。
 * 全端点 requireAuth；无业务错误分支（401 由组合根收敛为 unauthorized 信封），成功 200 直接返回 DTO。
 */

/**
 * 北京时间 UTC 偏移小时数：daily 的日界按北京时间切（自用中国省考受众固定 +8）；
 * SQL strftime 修饰符与服务端「今日」计算共用本常量防 JS/SQL 两端日界漂移，
 * SaaS 化再随账号时区演进。导出仅为集成测试用同一偏移推「北京时间今日」，勿在别处另写偏移字面量。
 */
export const STATS_TIMEZONE_OFFSET_HOURS = 8

/** 北京时间偏移毫秒数（「今日」计算用，来源同上） */
const TIMEZONE_OFFSET_MS = STATS_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000

/** 一天毫秒数（窗口日序列推算用） */
const DAY_MS = 24 * 60 * 60 * 1000

/** strftime 时区修饰符的参数值（由偏移常量拼出，绑定参数传值——非 SQL 字面量，勿带引号） */
const TIMEZONE_MODIFIER = `+${STATS_TIMEZONE_OFFSET_HOURS} hours`

/**
 * 北京时间日表达式（'YYYY-MM-DD'）：daily 的 select、窗口过滤与 groupBy 共用同一 SQL 片段，
 * 防同一表达式两处手抄漂移；created_at 为 ISO-8601 UTC 文本（schema 约定），strftime 直接解析。
 */
const beijingDay: SQL<string> = sql`strftime('%Y-%m-%d', ${practiceRecords.createdAt}, ${TIMEZONE_MODIFIER})`

export const statsRoute = new Hono<AppEnv>()

// 本域无公开端点：summary 与 knowledge 一律经 requireAuth（401 由组合根收敛为 unauthorized 信封）
statsRoute.use(requireAuth)

statsRoute.get('/summary', async (c) => {
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // overall：该用户 practice_records 全历史聚合（无时间窗口过滤，见文件头）。
  // 无 GROUP BY 的聚合恒返回一行；count 恒非空，空集时 D1 的 SUM 返回 null（与 sql<number>
  // 类型标注不符的库返回形态），读取处 ?? 归 0
  const overallRows = await db
    .select({
      answered: sql<number>`count(*)`,
      correct: sql<number>`sum(${practiceRecords.isCorrect})`,
      totalDurationMs: sql<number>`sum(${practiceRecords.durationMs})`,
      timeoutCount: sql<number>`sum(${practiceRecords.isTimeout})`,
    })
    .from(practiceRecords)
    .where(eq(practiceRecords.userId, authUser.id))
  const overallRow = overallRows[0]
  const overall: PracticeOverallStats = {
    answered: overallRow.answered,
    correct: overallRow.correct ?? 0,
    totalDurationMs: overallRow.totalDurationMs ?? 0,
    timeoutCount: overallRow.timeoutCount ?? 0,
  }

  // modules：inner join questions + modules——悬空题行整条跳过（内容重删的罕见态防御，
  // 与错题本/收藏列表同一理由）；GROUP BY 保证每组至少一行，SUM 恒非 null
  const moduleRows = await db
    .select({
      moduleCode: modules.code,
      answered: sql<number>`count(*)`,
      correct: sql<number>`sum(${practiceRecords.isCorrect})`,
      totalDurationMs: sql<number>`sum(${practiceRecords.durationMs})`,
      timeoutCount: sql<number>`sum(${practiceRecords.isTimeout})`,
    })
    .from(practiceRecords)
    .innerJoin(questions, eq(questions.id, practiceRecords.questionId))
    .innerJoin(modules, eq(modules.id, questions.moduleId))
    .where(eq(practiceRecords.userId, authUser.id))
    .groupBy(modules.code)
    // moduleCode 升序（DTO 约定）；modules.code 库层为无域类型的 TEXT，读取处按域值断言
    //（与错题本/收藏列表的 moduleCode 读取同一约定）
    .orderBy(asc(modules.code))
  const moduleStats: PracticeModuleStat[] = moduleRows.map((row) => ({
    moduleCode: row.moduleCode as XingceModuleCode,
    answered: row.answered,
    correct: row.correct,
    totalDurationMs: row.totalDurationMs,
    timeoutCount: row.timeoutCount,
  }))

  // 北京时间今日（'YYYY-MM-DD'）：Date.now() 加偏移后取 UTC 分量的 ISO 日期
  //（与 SQL strftime 同一偏移常量计算，防 JS/SQL 日界漂移）
  const today = new Date(Date.now() + TIMEZONE_OFFSET_MS).toISOString().slice(0, 10)
  // 窗口日序列：今日往前 STATS_TREND_DAYS 天、升序（最旧在前今日在末），零填空的骨架
  const todayStartMs = Date.parse(`${today}T00:00:00.000Z`)
  const windowDays: string[] = []
  for (let i = STATS_TREND_DAYS - 1; i >= 0; i--) {
    windowDays.push(new Date(todayStartMs - i * DAY_MS).toISOString().slice(0, 10))
  }

  // daily：窗口内按北京日聚合；过滤上下界与分组共用 beijingDay 同一片段（日界口径唯一）。
  // 输出序由 windowDays 决定，不依赖 SQL 排序；GROUP BY 保证 SUM 恒非 null
  const dailyRows = await db
    .select({
      day: beijingDay,
      answered: sql<number>`count(*)`,
      correct: sql<number>`sum(${practiceRecords.isCorrect})`,
    })
    .from(practiceRecords)
    .where(
      and(
        eq(practiceRecords.userId, authUser.id),
        sql`${beijingDay} between ${windowDays[0]} and ${windowDays[windowDays.length - 1]}`,
      ),
    )
    .groupBy(beijingDay)
  const dailyByDay = new Map(dailyRows.map((row) => [row.day, row]))
  const daily: PracticeDailyStat[] = windowDays.map((date) => {
    const row = dailyByDay.get(date)
    return { date, answered: row?.answered ?? 0, correct: row?.correct ?? 0 }
  })

  const body: StatsSummaryResponse = { overall, modules: moduleStats, daily }
  return c.json(body, 200)
})

statsRoute.get('/knowledge', async (c) => {
  const authUser = c.get('authUser')
  const db = createDb(c.env)

  // 本人维度（mastery_stats.userId 隔离）：知识点行 innerJoin knowledge_points/modules——
  // 悬空 target_id（知识点行被内容重删的罕见态防御，与 summary 模块聚合同一理由）整条跳过，
  // 故 code/name 恒非空、模块定位恒命中。SQL 序即输出序：模块 sort_order（id 并列稳定——
  // 列表端点惯例）、模块内知识点 sort_order + id。
  const rows = await db
    .select({
      moduleId: modules.id,
      moduleCode: modules.code,
      pointId: knowledgePoints.id,
      pointCode: knowledgePoints.code,
      pointName: knowledgePoints.name,
      totalCount: masteryStats.totalCount,
      correctCount: masteryStats.correctCount,
      accuracy: masteryStats.accuracy,
      avgDurationMs: masteryStats.avgDurationMs,
    })
    .from(masteryStats)
    .innerJoin(knowledgePoints, eq(knowledgePoints.id, masteryStats.targetId))
    .innerJoin(modules, eq(modules.id, knowledgePoints.moduleId))
    .where(
      and(eq(masteryStats.userId, authUser.id), eq(masteryStats.targetType, 'knowledge_point')),
    )
    .orderBy(
      asc(modules.sortOrder),
      asc(modules.id),
      asc(knowledgePoints.sortOrder),
      asc(knowledgePoints.id),
    )

  // 按 SQL 序两遍装配（模块首次出现即建组，组内逐点追加）：
  // timeLimitSec 按默认标准卷蓝图推导（推导口径以 shared 为唯一权威）；卷外模块为 null，
  // 该模块各点 mastery 用时得分按 0 处理（传 0 → deriveMastery 防御分支同口径，见 shared 注释）
  const moduleById = new Map<number, KnowledgeMasteryModule>()
  const body: KnowledgeMasteryModule[] = []
  for (const row of rows) {
    // modules.code 库层为无域类型的 TEXT（M1 内容域即行测模块编码），读取处按域值断言
    //（与 summary 模块聚合的 moduleCode 读取同一约定）
    const moduleCode = row.moduleCode as XingceModuleCode
    let entry = moduleById.get(row.moduleId)
    if (entry === undefined) {
      entry = {
        module: moduleCode,
        timeLimitSec: deriveQuestionTimeLimit(DEFAULT_BLUEPRINT, moduleCode) ?? null,
        points: [],
      }
      moduleById.set(row.moduleId, entry)
      body.push(entry)
    }
    const mastery = deriveMastery(row.accuracy, row.avgDurationMs, entry.timeLimitSec ?? 0)
    const point: KnowledgeMasteryPoint = {
      knowledgePointId: row.pointId,
      code: row.pointCode,
      name: row.pointName,
      totalCount: row.totalCount,
      correctCount: row.correctCount,
      accuracy: row.accuracy,
      avgDurationMs: row.avgDurationMs,
      mastery,
      needsReinforce: needsReinforce(mastery),
    }
    entry.points.push(point)
  }
  return c.json(body, 200)
})
