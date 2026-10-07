# design 域：design tokens 与主题三态（T0-03 已实现）

唯一权威来源是 docs/design/设计规范.md（§8 主题三态、§9 token 对照表）；本目录是其代码落地。

- `tokens.css`：§9 表 A–E 全量 CSS 变量。`:root` = 亮色语义值 + 主题无关常量（表 A 基础色板 / 表 D 字体 / 表 E 间距圆角栅格动效），`[data-theme="dark"]` = 暗色覆盖（表 B / 表 C 暗列）；`.theme-transition` 为切换一次性过渡（§8.2）。
- `base.css`：全局底座（box-sizing、body 底色/文字/字族，仅引 token）。
- `theme.ts`：三态纯逻辑——`ThemeMode`/`ResolvedTheme`、`ncse-theme-mode` 持久化（默认 system）、系统偏好订阅、`<html data-theme>` 与 meta theme-color 应用。**index.html 的内联脚本（FOUC 防护）与本文件逻辑一致，改动需两边同步。**
- `theme-provider.tsx`：`ThemeProvider` + `useTheme()` → `{ mode, resolved, setMode }`；切换控件组件由 T0-04 实现。
- `index.ts`：域出口。

约束（§2.1、§9 契约条款）：界面只引用语义 token（表 B–E），禁止直接引用基础色板，禁止硬编码颜色/间距；新增或改值先回设计规范登记并复算对比度。
