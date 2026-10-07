/**
 * 组件库演示页（/design，T0-04）
 * 分区块渲染全部基础组件；「亮暗对照」开关把每个区块复制进强制 data-theme=light/dark
 * 两个面板并排对照（tokens.css 的 [data-theme] 选择器对任意元素生效），
 * 全局主题由 ThemeModeCycleButton 切换（system → light → dark，§8.2）
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BookOpen,
  CalendarCheck,
  ChartColumn,
  CircleCheck,
  CircleX,
  Flame,
  Star,
  Timer,
  User,
} from 'lucide-react'
import {
  BottomTab,
  Button,
  Card,
  EmptyPlaceholder,
  Input,
  Modal,
  QuestionCard,
  Select,
  StatChip,
  Tag,
  Textarea,
  ThemeModeCycleButton,
  TopNav,
} from '../../components'
import './design-demo.css'

/** 图片插槽示例图（内联 SVG data URI，不依赖外部资源） */
const DEMO_IMAGE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">' +
      '<rect width="640" height="480" fill="#F1F5F9"/>' +
      '<rect x="40" y="40" width="560" height="400" fill="#DBEAFE" stroke="#94A3B8" stroke-width="2"/>' +
      '<text x="320" y="248" font-size="28" text-anchor="middle" fill="#475569">题目图片插槽示例 4:3</text>' +
      '</svg>',
  )

const TOP_NAV_ITEMS = [
  { key: 'practice', label: '刷题', href: '/design' },
  { key: 'mock', label: '模考', href: '/' },
  { key: 'wrong', label: '错题本', href: '/' },
  { key: 'stats', label: '统计', href: '/' },
  { key: 'plan', label: '计划', href: '/' },
]

const BOTTOM_TAB_ITEMS = [
  { key: 'practice', label: '刷题', href: '/design', icon: BookOpen },
  { key: 'wrong', label: '错题', href: '/', icon: CircleX },
  { key: 'stats', label: '统计', href: '/', icon: ChartColumn },
  { key: 'plan', label: '计划', href: '/', icon: CalendarCheck },
  { key: 'me', label: '我的', href: '/', icon: User },
]

/** 亮暗对照容器：开启后子树分别强制 data-theme=light / dark 并排渲染 */
function Compare({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (!enabled) return <>{children}</>
  return (
    <div className="demo-compare">
      <div className="demo-pane" data-theme="light">
        <Tag tone="muted">亮色</Tag>
        <div className="demo-pane__body">{children}</div>
      </div>
      <div className="demo-pane" data-theme="dark">
        <Tag tone="muted">暗色</Tag>
        <div className="demo-pane__body">{children}</div>
      </div>
    </div>
  )
}

function Section({
  title,
  desc,
  compare,
  children,
}: {
  title: string
  desc?: string
  compare: boolean
  children: ReactNode
}) {
  return (
    <section className="demo-section">
      <h2 className="demo-section__title">{title}</h2>
      {desc && <p className="demo-section__desc">{desc}</p>}
      <Compare enabled={compare}>{children}</Compare>
    </section>
  )
}

/** 按钮加载态演示（自带状态，便于在亮暗两个面板中独立操作） */
function LoadingButtonDemo() {
  const [loading, setLoading] = useState(false)
  return (
    <Button
      variant="secondary"
      loading={loading}
      onClick={() => {
        setLoading(true)
        window.setTimeout(() => setLoading(false), 1500)
      }}
    >
      {loading ? '提交中…' : '点击模拟加载'}
    </Button>
  )
}

/** 模态演示（自带状态；disablePortal 跟随所在面板主题，移动端呈底部 Sheet） */
function ModalDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开模态（移动端为底部 Sheet）</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="清空本题作答记录？"
        disablePortal
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              确认清空
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          遮罩点击或 Esc 可关闭；窄于 PC 断点时从底部以 Sheet 形态滑入。此操作不可恢复，按钮使用
          danger 变体并二次确认（§6.1）。
        </p>
      </Modal>
    </>
  )
}

/** 题目卡片演示（自带作答/判分/收藏/标记状态） */
function QuestionCardDemo() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [graded, setGraded] = useState(false)
  const [favorite, setFavorite] = useState(false)
  const [flagged, setFlagged] = useState(false)

  return (
    <div className="demo-question">
      <QuestionCard
        index={1}
        meta="qid 2023-国考-013 · 2023 年 · 难度 中等"
        stem="科学精神的核心是求真务实，我们的一切实践都需符合规律、切合实际。规律指引下的世界变动不居，我们不能墨守成规，而应敢于质疑、善于包容、勇于创新。这段文字意在强调什么？"
        options={[
          { key: 'A', content: '科学精神要求人们在实践中不断修正既有认知' },
          { key: 'B', content: '求真务实是开展一切工作的前提条件' },
          { key: 'C', content: '应在尊重规律的基础上保持质疑与创新的勇气' },
          { key: 'D', content: '世界的变动不居决定了规律的相对性' },
        ]}
        selectedKey={selectedKey}
        correctKey="C"
        graded={graded}
        onSelect={(key) => setSelectedKey(key)}
        favorite={favorite}
        onFavoriteToggle={() => setFavorite((v) => !v)}
        flagged={flagged}
        onFlagToggle={() => setFlagged((v) => !v)}
        imageSlot={<img src={DEMO_IMAGE} alt="题目图片示例" loading="lazy" />}
        analysis="文段先指出科学精神的核心是求真务实，随后以「变动不居」转折强调不能墨守成规，落脚点在最后一句：要敢于质疑、善于包容、勇于创新。C 项完整涵盖「尊重规律」与「质疑创新」两层意思。"
        optionAnalysis={[
          { key: 'A', content: '仅对应首句，未涵盖转折后的重点，片面。' },
          { key: 'B', content: '「前提条件」无中生有，文段未作此表述。' },
          { key: 'C', content: '正确：兼顾「求真务实（尊重规律）」与转折后的「质疑创新」。' },
          { key: 'D', content: '「规律的相对性」偷换概念，文段说的是实践不能墨守成规。' },
        ]}
        knowledgeTags={[
          { key: 'kp-ym-zx', label: '言语理解 · 中心理解' },
          { key: 'kp-ym-yt', label: '意图判断' },
        ]}
        onKnowledgeTagClick={() => undefined}
      />
      <div className="demo-row">
        <Button size="lg" disabled={!selectedKey || graded} onClick={() => setGraded(true)}>
          提交答案
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setSelectedKey(null)
            setGraded(false)
          }}
        >
          重置
        </Button>
      </div>
    </div>
  )
}

export function DesignDemoPage() {
  const [compare, setCompare] = useState(false)
  const navigate = useNavigate()

  return (
    <div className="demo-page">
      <header className="demo-page__header">
        <div>
          <h1 className="demo-page__title">基础组件库演示</h1>
          <p className="demo-page__desc">
            T0-04 · 全部组件只消费 design tokens；开「亮暗对照」可同屏比较两主题。
          </p>
        </div>
        <div className="demo-page__controls">
          <ThemeModeCycleButton />
          <Button variant={compare ? 'primary' : 'secondary'} onClick={() => setCompare((v) => !v)}>
            亮暗对照：{compare ? '开' : '关'}
          </Button>
        </div>
      </header>

      <Section title="按钮 Button" desc="§6.1：primary / secondary / ghost / danger × sm / md / lg，含禁用与加载态。" compare={compare}>
        <div className="demo-column">
          <div className="demo-row">
            <Button>主要操作</Button>
            <Button variant="secondary">次要操作</Button>
            <Button variant="ghost">幽灵按钮</Button>
            <Button variant="danger">危险操作</Button>
          </div>
          <div className="demo-row">
            <Button size="sm">小按钮</Button>
            <Button size="md">中按钮</Button>
            <Button size="lg">大按钮（移动主操作）</Button>
          </div>
          <div className="demo-row">
            <Button icon={<Star aria-hidden="true" />}>带图标</Button>
            <Button disabled>禁用态</Button>
            <LoadingButtonDemo />
          </div>
        </div>
      </Section>

      <Section title="卡片 Card" desc="§6.2：bg-elevated + border-subtle + radius-lg；interactive 卡片 hover 升阴影上移。" compare={compare}>
        <div className="demo-column">
          <Card title="普通卡片" extra={<Tag tone="info">说明</Tag>}>
            <p className="demo-text">卡片标题 18px semibold，内边距移动 md / PC lg。</p>
          </Card>
          <Card interactive title="可点击卡片" onClick={() => undefined}>
            <p className="demo-text">hover 升 shadow-md 并上移 2px。</p>
          </Card>
        </div>
      </Section>

      <Section title="表单 Input / Textarea / Select" desc="§6.3：高 48（移动）/ 40（PC）；错误态 danger 边框 + 13px 说明。" compare={compare}>
        <div className="demo-form">
          <Input label="账号" placeholder="请输入账号" />
          <Input label="带错误" defaultValue="abc" error="账号格式不正确" />
          <Input label="禁用态" placeholder="不可编辑" disabled />
          <Select label="目标考试" defaultValue="2027-sheng">
            <option value="2027-sheng">2027 省考</option>
            <option value="2026-guo">2026 国考</option>
          </Select>
          <Textarea label="做题笔记" placeholder="记录本题的疑问与心得…" />
        </div>
      </Section>

      <Section title="标签 Tag 与统计徽章 StatChip" desc="§7.4④ / §6.6：soft 成对配色；徽章数值 mono + tabular-nums，语义色仅用于图标。" compare={compare}>
        <div className="demo-column">
          <div className="demo-row">
            <Tag>默认 muted</Tag>
            <Tag tone="primary">primary</Tag>
            <Tag tone="success">success</Tag>
            <Tag tone="warning">warning</Tag>
            <Tag tone="danger">danger</Tag>
            <Tag tone="info">info</Tag>
            <Tag onClick={() => undefined}>可点击知识点</Tag>
          </div>
          <div className="demo-row">
            <StatChip icon={CircleCheck} tone="success" value="86%" label="正确率" />
            <StatChip icon={Timer} tone="info" value="42s" label="平均用时" />
            <StatChip icon={Flame} tone="warning" value="12" label="连续打卡" />
            <StatChip icon={ChartColumn} value="1,280" label="累计做题" />
          </div>
        </div>
      </Section>

      <Section title="题目卡片 QuestionCard" desc="§6.5/§7.1/§7.4：选项五态、判分后禁点并自动展开解析、收藏/标记、图片插槽、知识点标签。" compare={compare}>
        <QuestionCardDemo />
      </Section>

      <Section title="模态 Modal（移动端 Sheet 形态）" desc="PC 居中对话框（≤560px）；移动端底部 Sheet 滑入。" compare={compare}>
        <ModalDemo />
      </Section>

      <Section title="导航 TopNav / BottomTab" desc="§6.4：PC 顶栏（≥1024px 吸顶）与移动底部 Tab（<1024px），此处置于演示框内同屏展示。" compare={compare}>
        <div className="demo-column">
          <div className="demo-frame">
            <TopNav items={TOP_NAV_ITEMS} />
          </div>
          <div className="demo-frame demo-frame--tab">
            <span className="demo-frame__hint">移动底部 Tab（激活态 primary-text）</span>
            <BottomTab items={BOTTOM_TAB_ITEMS} />
          </div>
        </div>
      </Section>

      <Section title="占位 EmptyPlaceholder" desc="§6.7 / ADR-0006：未实现功能 = 标题 + 未完成说明 + 里程碑徽章 + 返回首页。" compare={compare}>
        <Card>
          <EmptyPlaceholder
            title="智能组卷"
            description="按模块、难度、题量抽题生成练习卷的功能尚未完成。"
            milestone="M6"
            onAction={() => navigate('/')}
          />
        </Card>
      </Section>
    </div>
  )
}
