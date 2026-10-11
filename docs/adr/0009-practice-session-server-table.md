# ADR-0009：练习会话落服务端实表（推翻 T1-02「不建实表」决策）

日期：2026-10-11　任务：T1-08a　状态：已采纳

## 背景

T1-02 定稿决策③：`practice_records.session_id` 为 TEXT UUID **不建实表**（整卷才有 mock_sessions 实表），题目批次清单隐含由客户端持有。该设计的代价在产品定位下显形：ncse 是 PC + 移动端双端使用的自用备考平台（GH Pages 前端 + PWA，T1-14），localStorage 持有的题目清单只能**同设备**续做——PC 上刷一半，手机上无法继续；且未作答题目集合在服务端无处可查（practice_records 只存已答记录）。

## 决策

新增 `practice_sessions` 实表（迁移 0002）：user/mode/module、题目清单（questionIds JSON）、status（in_progress | finished | abandoned）、时间戳。`practice_records.session_id` 语义不变（批次分组键），值改挂会话。续做 = 取活动会话的题目清单减去已答记录。备选方案已评估并否决：localStorage（同设备限制，本 ADR 的动因）、按会话种子确定性重算题目集合（题库增量后批次漂移，不可靠）。

## 后果

- 跨设备续做成立；题目集合服务端权威，换设备/重抽一致。
- 推翻 T1-02 决策③的代价：一张轻量表 + 一次迁移 + 会话生命周期管理（finished 判定 = 全部作答；abandoned 由用户显式放弃或留待惰性处理）。
- 整卷模考的 mock_sessions 设计不受影响（两者并存：练习会话轻量无蓝图，模考会话挂蓝图与交卷判分）。
