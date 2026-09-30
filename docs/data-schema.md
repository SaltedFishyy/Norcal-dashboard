# Data Schema（数据字段与规则）

本文件记录数据字段、粒度、来源、新鲜度和清洗规则。项目级数据原则见 `AGENTS.md` 第 15–16 节；本文件是细节补充，两者冲突时以 `AGENTS.md` 为准并提出不一致。

> 状态：初版。第 1 节之外的内容迁移自旧版 `AGENTS.md` 第 16 节（2026-09-30），属于**设计方向和候选字段**，不是已确认的数据规范。实际数据集接入时，由对应 feature spec 确认后再更新本文件。

---

## 1. 当前已有数据（Current Datasets）

| 数据 | 位置 | 类型 | 粒度 | 来源 / 更新方式 | Last Updated 显示 |
|---|---|---|---|---|---|
| 站点 / ZIP / DSP / Route 数据 | `nc-ops-console-main/index.html` 内 `#mapdata`（内嵌 JSON） | 静态内嵌 | 待记录 | 待记录 | 待确认 |
| ZIP 边界 | `nc-ops-console-main/index.html` 内 `#zipgeo`（内嵌 GeoJSON） | 静态内嵌 | ZIP | 待记录 | — |
| ZIP 价格表 | `nc-ops-console-main/data/price_adjustments.csv` | CSV，手动维护 | ZIP | 手动编辑后提交；页面加载时读取 `zip,price` 两列（`station,route` 仅供参考） | 侧边栏状态行显示加载的 ZIP 数 |
| W27 司机取件分析 | `nc-ops-console-main/analytics/w27-pickup.html` 内嵌 | 静态快照 | 待记录 | 待记录 | 待确认 |
| DSP 定价 | `nc-ops-console-main/analytics/dsp-pricing.html` 内嵌 | 静态快照 | Station | 待记录 | 待确认 |

“待记录”项需要在下一次涉及该数据的任务中，由 Codex 检查代码后补充，不要凭猜测填写。

---

## 2. 核心运营指标（Core Operational Metrics，候选）

在数据可得时，设计应支持以下字段：

```text
Date
Region
Station
Route
ZIP
DSP
Daily Volume
PPH
Delivery Success Rate
Price
Difficulty
Driver Count
DSP Capacity
```

可以后续增加字段。不要假设每个数据集都包含所有字段。

---

## 3. Excel / CSV 源数据

源文件可能存在：列名不同、缺失值、重复记录、日期格式不同、DSP / Route / ZIP 命名不一致。

处理规则：

1. 尽量保留原始源文件。
2. 用脚本做可复现的清洗。
3. 能脚本化的就不要手工一次性处理。
4. 记录重要清洗规则（写在本文件或对应 feature spec）。
5. 未经明确要求，不覆盖原始源文件。

---

## 4. 字段说明

### 4.1 ZIP

- 一律按字符串处理（如 `"94005"`、`"94112"`），保留前导零。

### 4.2 PPH

- 保留源数据原值。
- 不补造缺失的 PPH。
- 明确区分实际值和计算估算值。
- 适用时支持 ZIP、Route、Station、DSP 层级分析。
- 汇总 PPH 的计算方法必须记录。

### 4.3 Volume

- 可能存在 ZIP、Route、Station、DSP、Date 各层级的值，不同层级不可互换。
- 合计和平均必须使用正确的聚合逻辑。
- 现有实现：route / station / DSP 平均价格按 volume 加权平均（见 `AGENTS.md` 第 4.4 节）。

### 4.4 Delivery Success Rate

- 英文名统一使用 **Delivery Success Rate**，除非另有指定的内部术语。
- 与 **On-Time Delivery Rate** 是不同概念，不要混用。

### 4.5 Route Difficulty

- 可能的分类：Easy、Medium、Hard、Very Hard。
- 可能的输入：PPH、volume、配送密度、距离、Delivery Success Rate、历史表现。
- 判定规则**未确认**，不得硬编码，逻辑必须可配置。未决问题记录在 `docs/open-questions.md`。

---

## 5. DSP Resource Pool（候选字段）

```text
DSP Name
Operating Area
Current Station
Current Routes
Driver Count
Maximum Daily Capacity
Available Capacity
Interested Area
Local Resources
Contact Person        ← 敏感，禁止出现在公开页面（AGENTS.md 第 14 节）
Contact Information   ← 敏感，禁止出现在公开页面（AGENTS.md 第 14 节）
Status
Notes
```

---

## 6. Route Reallocation（分析输入，候选）

示例场景：某 DSP 释放了一批 route，哪些现有或新 DSP 可以接？

可使用的分析输入：capacity、当前 volume、司机可用性、现有 route、route difficulty、PPH、配送表现、本地准备度。

系统只提供决策支持信息，不自动做最终业务决定（`AGENTS.md` 第 13 节）。

---

## 7. Mock Data

- 真实数据不可用或不能公开时使用 mock data。
- Mock data 必须在 UI 和文件名 / 元数据中明确标注。
- 不得把编造的数字当作真实业务数据展示。

---

## 8. Route Profile（路区画像，DMS 刷新）

- 规格：`docs/features/dms-refresh.md`（Draft v2）
- 来源类型：Scraper / browser automation（Playwright，使用 Product Owner 本人的 DMS 登录态），只在用户点击刷新时运行
- 粒度：一行 = 一个 Station 下的一条 Route（最新一次成功抓取）
- 新鲜度：每个 Station 单独记录 `fetched_at`（Last Updated）；第一阶段不保存历史
- 存储：本机 runtime 目录中的 `route-profiles.json`（不进 Git）

| 字段 | 类型 | 定义 | 状态 |
|---|---|---|---|
| `station` | string | Station 代码，如 `SFO01` | 已确认 |
| `route_name` | string | DMS 原值 | 已确认 |
| `dsp_name` | string | DSP / Fleet Name，DMS 原值 | 已确认 |
| `pickup_volume` | number \| null | **领件量**。不是 Daily Volume，不要混用 | 统计窗口待确认（D6） |
| `pph` | number \| null | DMS 原值，不自行计算 | 已确认 |
| `first_mile_distance` | number \| null | DMS 原值 | 单位 / 口径待确认（D2） |
| `address_type_distribution` | object | 地址类型 → 占比或数量 | 结构待确认（D3） |
| `route_difficulty` | string \| null | 只存 DMS 提供的值，不自行推算 | 来源待确认（D4） |
| `fetched_at` | ISO datetime（Station 级） | 该 Station 最近一次成功抓取的时间 | 已确认 |
| `source_as_of` | ISO datetime \| null | DMS 页面显示的数据截至时间（如有） | 待 T4 确认 |

Station / Route 关联：`station` 取抓取时在 DMS 中选择的真实 Station，**不从 `route_name` 解析**（即使形如 `SFO02-042`）。第一阶段逻辑标识 = `station + route_name`；以后如果能拿到稳定的 DMS route ID，再引入唯一 ID。

术语：`pickup_volume` 与 legacy `#mapdata` 中的 `volume` 口径不同，两者不能直接比较或合并。
