# Tableau

Tableau 数据集、看板和集成方式的说明。项目级原则见 `AGENTS.md` 第 17 节。

> 状态：初版。2026-10-02 曾确认第一个 Tableau 项目 Route Map（`docs/features/tableau-route-map.md`），同日 Product Owner 决定**暂停 Tableau Desktop 路线**，地图改为做进 NC Ops Console（`docs/features/route-map.md`）。已完成的 Route-ZIP 导出和 ZCTA 边界仍保留，以后做 Tableau 时可直接使用。

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
| Route-ZIP 输入表（Route Map） | Station × Route × ZIP | Route Profile 列表接口的 `postalCodeList` → `postal_codes`（TBL1.5 / TBL2） | 手动运行 `npm run export:tableau-route-zips` | 已实现（TBL2，`npm run export:tableau-route-zips`）；Tableau 使用暂停 |
| ZCTA 边界（截取） | ZIP（ZCTA） | Census 2020 ZCTA cb 1:500k | 十年一次（随人口普查） | 2026-10-02 起由 `geo/zcta2020_ca_nv_or.geojson`（CA + NV + OR 服务区边界库）取代；旧的 SFO01 单站点文件已删除 |
