import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { authRoute } from './auth'
import { favoritesRoute } from './favorites'
import { imgRoute } from './img'
import { knowledgeRoute } from './knowledge'
import { mockRoute } from './mock'
import { papersRoute } from './papers'
import { practiceRoute } from './practice'
import { reinforceRoute } from './reinforce'
import { statsRoute } from './stats'
import { wrongBookRoute } from './wrong-book'

/**
 * `/api` 业务域聚合路由（组合根 src/index.ts 挂载），子路由统一 `Hono<AppEnv>`。
 * 各业务域子路由挂载点，后续任务落地时逐个追加：
 * - T1-03（已落地）认证：authRoute → /api/auth/*（注册/登录、JWT 签发与校验）；
 * - T1-08b（已落地）专项刷题·练习会话：practiceRoute → /api/practice/*
 *   （建会话/详情/列表/判分，全路由 requireAuth；T1-10a 建会话扩 wrong_redo 错题重做模式）；
 * - T1-08c（已落地）错题本处置：wrongBookRoute → /api/wrong-book/*
 *   （在册条目移除/归难点本，ADR-0010，全路由 requireAuth；T1-10a 增 GET / 错题本/难点本列表）；
 * - T1-08d（已落地）题目图片：imgRoute → /api/img/*（公开端点、不挂 requireAuth：
 *   `<img>` 标签不带 Authorization 头，内容寻址 64hex 键即不可枚举的能力凭证，ADR-0007）；
 * - T1-10a（已落地）收藏：favoritesRoute → /api/favorites/*（收藏列表/收藏/取消，
 *   幂等切换，全路由 requireAuth）；
 * - T1-11a（已落地）基础统计：statsRoute → /api/stats/*（GET /summary 练习统计汇总：
 *   overall/modules 全历史聚合 + daily 近 30 天北京日趋势；GET /knowledge 分模块知识点
 *   掌握度（M3/T3-01d，mastery/needsReinforce 经 shared 派生下发），全路由 requireAuth）；
 * - T2-01b（已落地）试卷目录：papersRoute → /api/papers/*（GET / 全量卷目录，
 *   完整度分档 D2，全路由 requireAuth）；
 * - T2-01b（已落地）整卷模拟·模考会话：mockRoute → /api/mock/*（建会话/列表/详情/作答/计时/
 *   交卷判分/成绩单——时长锁定 D3、作答中不下发答案 D4、交卷统一判分与错题本联动 D8、
 *   计时累计 D6，全路由 requireAuth；模考后端数据面就绪）；
 * - M3/T3-01a（已落地）知识点树：knowledgeRoute → /api/knowledge/*（GET /tree 全量
 *   三级嵌套树，数据源 importer 种子（ADR-0013 两级树+版本化种子），全路由 requireAuth）；
 * - M3/T3-01e（已落地）需加强清单：reinforceRoute → /api/reinforce/*（GET / 强化队列列表，
 *   全自动队列——汇入/出队由练习判分与模考交卷联动（M3 D5），无用户处置端点；建强化会话走
 *   POST /api/practice/sessions 的 reinforce 分支，全路由 requireAuth）；
 * - AI 代理（ADR-0005）：aiRoute → /api/ai/*（申论批改、AI 参考答案等 POST 转发）；
 * - 题库、做题记录等其余业务域：按任务进展追加。
 */
export const apiRoute = new Hono<AppEnv>()

// 认证域：/register 与 /login 公开，/me 经 requireAuth 示范受保护路由的接入方式
apiRoute.route('/auth', authRoute)

// 专项刷题会话域：全端点 requireAuth（子路由内部 use），抽题与判分共识见 ADR-0009
apiRoute.route('/practice', practiceRoute)

// 错题本域：全端点 requireAuth（子路由内部 use），处置语义见 ADR-0010
apiRoute.route('/wrong-book', wrongBookRoute)

// 收藏域：全端点 requireAuth（子路由内部 use），幂等切换（重复收藏/取消均恒 200）
apiRoute.route('/favorites', favoritesRoute)

// 题目图片域：公开代理（无 requireAuth，理由见 imgRoute 文件头），键校验与缓存语义见 ADR-0007
apiRoute.route('/img', imgRoute)

// 统计域：全端点 requireAuth（子路由内部 use），汇总口径（全历史 + 近 30 天北京日）见 statsRoute 文件头
apiRoute.route('/stats', statsRoute)

// 试卷目录域：全端点 requireAuth（子路由内部 use），完整度分档口径（D2）见 papersRoute 文件头
apiRoute.route('/papers', papersRoute)

// 整卷模拟·模考会话域：全端点 requireAuth（子路由内部 use），拆片决策（D3/D4/D6/D7）见 mockRoute 文件头
apiRoute.route('/mock', mockRoute)

// 知识点域：全端点 requireAuth（子路由内部 use），树形态与种子入库见 ADR-0013
apiRoute.route('/knowledge', knowledgeRoute)

// 需加强清单域：全端点 requireAuth（子路由内部 use），全自动队列口径（M3 D5）见 reinforceRoute 文件头
apiRoute.route('/reinforce', reinforceRoute)
