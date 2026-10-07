# 基础组件库（T0-04 已实现）

形态与 token 引用以 docs/design/设计规范.md §6（组件形态）、§7（题目排版）为唯一权威；本目录是其代码落地。

## 组件清单

| 组件 | 文件 | 规范出处 | 要点 |
|---|---|---|---|
| Button | button.tsx / button.css | §6.1 | primary/secondary/ghost/danger × sm/md/lg；加载态 Loader2 旋转 + 锁宽；禁用 0.5 |
| Card | card.tsx / card.css | §6.2 | bg-elevated + border-subtle + radius-lg；interactive hover 升 shadow-md 上移 2px |
| Input / Textarea | input.tsx / input.css | §6.3 | 高 48（移动）/40（PC）；label 上置 14px medium；错误 danger 边框 + 13px 说明 |
| Select | select.tsx / select.css | §6.3 | 原生 select + ChevronDown 装饰，双端可用性优先 |
| Modal | modal.tsx / modal.css | §4.3/§6.8 | PC 居中（≤--layout-max-modal）；移动端底部 Sheet 滑入；Esc/遮罩关闭 |
| TopNav | top-nav.tsx / top-nav.css | §6.4 | ≥1024px：64px 吸顶、stuck 后 shadow-xl、激活项 primary-text + 2px 指示条 |
| BottomTab | bottom-tab.tsx / bottom-tab.css | §6.4 | <1024px：56px + 安全区；激活 primary-text，未激活 text-tertiary |
| QuestionCard | question-card.tsx / question-card.css | §6.5/§7.1/§7.3/§7.4 | 选项五态；判分禁点 + 解析自动展开；mock 模式隐藏解析；图片/解析/知识点插槽 |
| StatChip | stat-chip.tsx / stat-chip.css | §6.6 | 图标 16 + mono/tabular-nums 数值 + aux 标签；语义色仅用于图标 |
| Tag | tag.tsx / tag.css | §7.4④/§2.2 | muted / 六语义 tone（soft 底 + soft-text 成对）；可点击变体 |
| EmptyPlaceholder | empty-placeholder.tsx / empty-placeholder.css | §6.7 | 标题 + 未完成说明 + 里程碑徽章 + 返回首页按钮 |
| ThemeModeCycleButton | theme-mode-button.tsx / .css | §8.2 | system → light → dark 循环，图标即当前 mode（Monitor/Sun/Moon） |

## 约束

- 全部样式只引用 §9 语义 token（var(--…)）；组件内出现的字面量均为规范定值（控件高 32/40/48、导航 64/56、徽标 20px、选项热区 44px、图片 max-h 480px、断点 1024px 对应 --breakpoint-pc 等），新需求先在既有 token 内解决，确需新增先回规范 §9 登记。
- 图标统一 lucide-react，strokeWidth 默认 2，尺寸阶梯 16/20/24（§5）。
- 演示页：/design（分区块 + 亮暗对照 + 主题切换控件）。
