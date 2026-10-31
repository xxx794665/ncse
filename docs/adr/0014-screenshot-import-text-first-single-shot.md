# ADR-0014 截图导入一期：文本化、一图一题、独立 shot.sql

日期：2026-10-31　状态：已接受

## 背景

M3 T3-01h（F3-6 题目截图导入一期）按 D7 定稿为自用工具链：截图入目录 → 视觉提取子代理（glm-5.3-flash）→ 题目 JSON 草稿 → 人工确认 → 经既有管线入库。产品内上传入口待 M4 AI 通道，不在一期。实现前需要落定四个影响后续数据形态的取舍。

## 决策

1. **qid 命名空间 `shot-<截图文件名>`**：截图导入题的 qid 加 `shot-` 前缀（如 `shot-20261101-01`），与源仓库纯数字 qid 空间（27,362 题）隔离。文件名（吸收时校验 `[A-Za-z0-9_-]+`）即幂等键，无需 manifest 维护映射。一旦真实数据入库，改 qid 规则属再蒸馏范畴。
2. **一期一图一题**：一张截图对应一道题。一张图含多道小题时，提取代理输出 `multiQuestion: true` 标记、吸收记 warning 不产草稿，由用户拆图重截；`question_groups` 题组与材料挂组不做，材料性文本由用户在草稿题干中自行合并。
3. **一期纯文本化（不入图片段）**：截图本身不上传 R2，题干/选项/解析为转写文本（公式 LaTeX）。复杂图表题（如资料分析）转写有损，由人工确认环节兜底；图片段入库（截图 → sharp 压缩 → 内容寻址 → R2 → stem 图片段）为二期增强，不破坏一期数据。
4. **独立 `shot.sql`，不并入 import.sql**：截图入库循 tag.sql / ai-analysis.sql 先例——独立自包含 SQL + 独立 `import_runs` 版本号（下一空闲，当前为 3），不与主库 98.9MB 重导耦合；分类体系（exam_types/subjects/modules）upsert 定位行随 SQL 自包含。

## 理由

- 自用补题量级小（个位数十位），渐进式交付优先；一期先打通「截图 → 可练习题目」主链路，图片保真等增强按真实使用反馈排期。
- 管线全部复用既有先例：执行模型照 ADR-0008（子代理只写 staging、吸收权在 importer），质量门照 db-stage 码表（answer_not_in_options / missing_answer / no_options 等），独立 SQL 照 tag-stage——不新造轮子。
- 草稿人工确认是质量闸门：代理只产建议（含模块归属建议），`moduleCode`/答案在草稿中人工校对后置 `status: "confirmed"` 才进 emit；`answer` 缺失题被质量门拦截待补。

## 影响

- importer 新增 `shot` 子命令（吸收 + `--emit` 两模式）与批次生成器；新代理定义 `screenshot-extractor`（glm-5.3-flash）。
- staging/drafts/批文件均在 `.import-out/` 下（gitignored，ADR-0004）。
- 二期增强点（登记于任务索引）：图片段入库、一图多题、题组挂组。
