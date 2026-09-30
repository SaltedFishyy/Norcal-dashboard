# Tableau

Tableau 数据集、看板和集成方式的说明。项目级原则见 `AGENTS.md` 第 17 节。

> 状态：初版。内容迁移自旧版 `AGENTS.md` 第 17 节（2026-09-30），属于**规划方向**，目前还没有已建成的 Tableau 数据集或看板。

---

## 1. 分工

**Web Dashboard 侧重：** 交互地图、Station / DSP / Route 导航、ZIP 级运营、DSP 资源管理、运营工作流、route 分配工具。

**Tableau 侧重：** 历史趋势、PPH 分析、volume 分析、Delivery Success Rate、DSP 表现、route 表现、route difficulty 分析、运营报表。

---

## 2. 初始指标（Initial Metrics）

```text
Station
Route
ZIP
DSP
Daily Volume
PPH
Delivery Success Rate
Difficulty
Date
```

字段定义见 `docs/data-schema.md`。

## 3. 可能的可视化

Route Volume Comparison、ZIP PPH Comparison、PPH vs Volume、DSP Performance、Route Difficulty Distribution、Delivery Success Rate Trends、Station Performance。

---

## 4. 数据准备

优先使用干净的表格结构，例如：

```text
Date | Station | Route | ZIP | DSP | Volume | PPH | Delivery Success Rate | Difficulty
```

- 每一行必须有明确的粒度（granularity）。
- 除非结构明确支持，不要在同一数据集混合 ZIP 级和 Station 级的行。

---

## 5. 集成方式（未确认）

不要假设 Tableau 必须嵌入网页。可选方案：

- A：Web dashboard 和 Tableau 保持独立
- B：从 web 应用链接到 Tableau 看板
- C：之后嵌入部分 Tableau 视图
- D：两边共用同一个中央数据库

需求确认前保持架构灵活。Tableau 凭据遵守 `AGENTS.md` 第 14 节。

---

## 6. 数据集清单

| 数据集 | 粒度 | 来源 | 更新方式 | 状态 |
|---|---|---|---|---|
| （暂无） | | | | |
