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

### PostgreSQL 存储基础设施（Central DB P2 / CD-T2）

- District 数据库层（DA-T1，migration `004_districts.sql`）：`known_stations` 每个已知 Station 一行，保存 `code`、可空的 `scrape_disabled_reason` 和 `created_at`；`districts` 每个片区一行，保存 id、中英文名称及唯一 `ordinal`；`district_stations` 每个已分配 Station 一行，以 `station_code` 为主键并外键关联 Station 和 District，保存片区内 `ordinal`；`district_config_version` 为单行版本及 `updated_at`。四张表分别提供 `v_*` 视图，版本视图不暴露内部 singleton id。
- District 种子来源为手动维护的 `config/districts.json`，通过 `db:import-districts` 一次性事务导入；补入 `stations` 中的历史代码，但不为其生成归属。任意目标表已有数据即拒绝，保留源文件。跳过原因属于 Station，不因移动或移除归属而改变。`nc_district` 只能修改归属和版本。2026-10-14 经 Product Owner 授权仅部署 migration 004，并用现有种子导入初始化 4 个片区、46 个站点归属（含 Seattle），版本为 1；应用读取来源仍是文件，尚未切换到数据库。详见 [District Management spec 第 4 节](features/district-admin.md#4-数据设计migration-004_districtssql) 和 [Seattle 执行记录](features/seattle-district.md)。
- 已新增 schema `nc` 的建表脚本、批处理双写、一次性 JSON 导入和 DB 只读 API；正式库操作由维护者在 review 后执行。
- 主要表：`stations`、`scrape_runs`、`scrape_run_stations`、`station_snapshots`、`snapshot_routes`、`snapshot_route_zips`、`route_detail_versions`、`route_detail_zips`、`warehouses`；`schema_migrations` 记录迁移版本。
- `v_warehouses` 排除内部查重字段 `address_key`；reader 只读该视图，`nc_warehouse` 仅拥有仓库表的 SELECT、INSERT、DELETE、指定八列 UPDATE，以及该视图的 SELECT。详见 [Warehouse spec 第 4 节](features/warehouses.md#4-数据设计)。
- 数据来源为 `dms-playwright`（浏览器自动化）或 `json_import`（本地 JSON 导入）。`npm run db:import-json` 以 scraper 身份只读两个 runtime JSON 文件，保留原始字段 / fetched_at，导入为 active snapshot 和 committed Detail（包括历史 Route）；整次事务提交，已有 snapshot / Detail 时拒绝，不修改源文件。
- `DATA_SOURCE=json|db` 选择 API 数据源，默认 json；db 使用 `NC_DB_READER_URL` 连接池，只查询 `v_*` 视图，不缓存数据。两种来源共用业务逻辑和字段投影，Profile API 不返回 raw，数据库不可用返回 503 `data_source_unavailable`。边界、District 配置与底图仍来自文件。`npm run db:parity` 仅本地比较两种来源的 HTTP 状态及完整 JSON，不输出响应数据。
- Snapshot 粒度为 Station 的一次抓取；Route 和 ZIP 属于对应 snapshot；Detail / ZIP 属于一个带版本的 Route Detail。`fetched_at` 原样保存为 text，ZIP 保留为字符串；非实时数据的新鲜度沿用源数据时间。
- 只读角色仅查询过滤原始字段的视图；抓取角色仅有指定的 INSERT、列级 UPDATE 和 SELECT 权限。完整字段与权限见 [central-db.md 第 21 节](features/central-db.md#21-p2-详细设计product-owner-2026-10-07-授权)。

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
- MS-T1 多站点批处理：手动运行 `npm run dms:scrape-stations`，通过同一 Playwright 会话的全局 Station 和列表逐条验证获取 active Route；全部页完成后按 Station 覆盖 snapshot，沿用 `fetched_at` 和 schema_version 1。来源仍是 DMS browser automation，续跑状态与 summary 单独保存在 runtime（见 `docs/features/multi-station.md`）。

| 字段 | 类型 | 定义 | 状态 |
|---|---|---|---|
| `station` | string | Station 代码，如 `SFO01` | 已确认 |
| `route_id` | number | DMS `roadAreaId`，Route 的稳定唯一标识（首选） | 已确认（D9） |
| `route_name` | string | DMS 原值（`roadAreaName`） | 已确认 |
| `dsp_name` | string | DSP / Fleet Name，DMS 原值 | 已确认 |
| `pickup_volume` | number \| null | **领件量**（DMS `receiptQty`）。不是 Daily Volume，不要混用 | 统计窗口待确认（D6） |
| `pph` | number \| null | DMS 原值，不自行计算 | 已确认 |
| `first_mile_distance` | number \| null | DMS 原值（`firstOrderMileage`），单位 mile | 已确认（T2） |
| `address_type_distribution` | array \| null | DMS `receiveAddressType[]` → `[{ type_code, type_name, share }]`，`share` 为占比（每个 Route 合计 1.0） | 已确认（T2 / T3） |
| `postal_codes` | string[] | 该 Route 包含的 ZIP：DMS 列表字段 `postalCodeList`（逗号分隔字符串）按逗号拆分。每个都是 5 位字符串（保留前导 0）；数量必须等于 `postalCodeNum`；同一 Route 内不重复；同一 Station 内一个 ZIP 只能属于一条 Route。任一校验不通过时整次抓取失败、报告原因、不写 snapshot（不自动消解）。`raw` 中保留 `postalCodeList` / `postalCodeNum` 原值。schema_version 仍为 1：新 snapshot 必须写此字段；旧 snapshot 缺失时 reader / API 仍可读取；不做 migration | 已确认（Product Owner 2026-10-02，TBL2） |
| `route_difficulty` | string \| null | DMS 系统难易度（`roadAreaDifficulty`，另存 code），不自行推算；前端默认展示 | 已确认（D4b） |
| `route_difficulty_manual` | string \| null | DMS 人工难易度（`roadAreaDifficultyManual(Name)`），空值为 null | 已确认（D4b） |
| `fetched_at` | ISO datetime（Station 级） | 该 Station 最近一次成功抓取的时间 | 已确认 |
| `source_as_of` | ISO datetime \| null | DMS 页面显示的数据截至时间（如有） | T2：列表接口中没有，暂为 null |

Station / Route 关联：`station` 取抓取时在 DMS 中选择的真实 Station，**不从 `route_name` 解析**（即使形如 `SFO02-042`）。唯一标识首选 `route_id`（DMS `roadAreaId`）；`station + route_name` 继续保存，用于展示和一致性校验。

术语：`pickup_volume` 与 legacy `#mapdata` 中的 `volume` 口径不同，两者不能直接比较或合并。

## 9. Route Detail / ZIP Profile（路区 ZIP 画像，按 Route 抓取）

- 规格：`docs/features/route-detail.md`（Approved 2026-10-02）
- 来源类型：Scraper / browser automation（Playwright，Product Owner 本人的 DMS 登录态），只在手动运行 `npm run dms:scrape-route-detail -- --route <route_name>`（单条）或 `npm run dms:scrape-route-details -- --station SFO01`（RD3 批量，串行）时访问 DMS；两者写入同一文件、同一结构
- DMS 接口：`POST …/roadAreaPortraitDetails/details/getRoadAreaContent`（请求体 `{roadAreaId}`），校验用 `…/details/getRoadAreaHeader`
- 粒度：一行 = 某条 Route 下的一个 ZIP（最新一次成功抓取）。逻辑唯一标识 `route_id + postal_code`
- 新鲜度：每条 Route 单独记录 `fetched_at`，与 `route-profiles.json` 中 Station 的 `fetched_at` 互相独立
- 存储：本机 runtime 目录中的 `route-details.json`（不进 Git），不修改 `route-profiles.json`
- MS-T1 新命令也通过相同详情页面流程写入此 cache，沿用 RD4 字段和每 Route 的 `fetched_at`；同时独立更新该 Station 的 Route Profile snapshot。移出 active 列表的历史 Route Detail 保留，完整性判断检查原始 `pickup_volume_daily` 键，不使用 API 的 null 默认值。

```json
{
  "schema_version": 1,
  "routes": {
    "831": {
      "route_id": 831, "station": "SFO01", "route_name": "SFO01-001",
      "route_difficulty": "A级 难", "route_difficulty_code": "3",
      "fetched_at": "2026-10-02T18:20:00Z", "source": "dms-playwright",
      "zip_count": 21,
      "zips": [
        { "postal_code": "…", "postal_code_tag": "0", "postal_code_difficulty": "…",
          "first_mile_distance": 0, "experienced_pph": 0,
          "delivery_fail_rate": 0, "dnr_rate": 0, "safety_level": "…",
          "raw": { }, "parse_errors": [ ] }
      ],
      "parse_errors": [ ]
    }
  }
}
```

Route 级字段：

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `route_id` | number | 列表响应 `roadAreaId`（= 详情请求体 `roadAreaId`） | 主标识；`routes` 的 key 为其字符串形式 |
| `station` | string | 抓取时选择的 Station | 不从 `route_name` 解析 |
| `route_name` | string | `getRoadAreaHeader.roadAreaName` | 必须与 `--route` 和列表行一致 |
| `route_difficulty` / `route_difficulty_code` | string \| null | `getRoadAreaHeader.roadAreaDifficulty` / `roadAreaDifficultyCode` | DMS 原值 |
| `zip_count` | number \| null | `getRoadAreaHeader.postalCodeNum` | 与 `zips.length` 不一致时记入 Route 级 `parse_errors`，不修正 |
| `fetched_at` | ISO datetime | 抓取时间 | |

ZIP 级字段（`getRoadAreaContent.data[]`）：

| 字段 | 类型 | DMS 字段 | 说明 |
|---|---|---|---|
| `postal_code` | string | `postalCode` | 保持字符串，不转数字 |
| `postal_code_tag` | string \| null | `postalCodeTag` | **只存原值**。样本中 `"1"` 对应页面显示 `94617NEW`，但未确认含义，不解释 |
| `postal_code_difficulty` | string \| null | `postalCodeDifficulty` | DMS 原值（五级文字），**接口没有 code**；不自行计算 |
| `first_mile_distance` | number \| null | `assignedRouteAreaFirstOrderMileage` | 单位 mile。**Route 级「所属路区首单里程」，在每个 ZIP 行重复，不是 ZIP 独立指标** |
| `experienced_pph` | number \| null | `experiencedPph` | 熟手 PPH，DMS 原值 |
| `delivery_fail_rate` | number \| null | `deliveryFailRate` | 派送异常率，**小数**（0.0206 = 2.06%）；前端 ×100 显示 |
| `dnr_rate` | number \| null | `dnrRate` | DNR 率，**小数**；前端 ×100 显示 |
| `safety_level` | string \| null | `safetyLevel` | DMS 原值（样本：安全 / 一般 / 风险 / 高危），接口没有 code |
| `pickup_volume_daily` | number \| null | 产能详情「按邮编」接口 `…/businessPropertiesProductionCapacity/details/postalCodeDimension` 的 `receiptQty`（页面“领件量日均”），按 `postalCode` 合并 | RD4（2026-10-05）新增；旧记录中缺失时视为 null。统计窗口见 RD-Q4。Route 级另存 `capacity_raw`（API 不返回） |

RD4 起 Route Detail 页面只展示 ZIP、领件量（日均）、熟手 PPH、ZIP 难度、首公里距离；`delivery_fail_rate` / `dnr_rate` / `safety_level` 仍保存在 cache 中，但不展示。
| `raw` | object | 整条原始记录 | 调试用；API 不返回 |
| `parse_errors` | array | — | 类型不符时记录字段名，值存为 null |

## 10. Tableau Route-ZIP 输入表（Station → Route → ZIP）

- 规格：`docs/features/tableau-route-map.md`（设计 Approved 2026-10-02；TBL2 定稿前字段可能微调）
- 来源：**`route-profiles.json` 中每行的 `postal_codes`（第 8 节）**，即 DMS 路区画像列表接口的 `postalCodeList`（Product Owner 2026-10-02 确认，TBL1.5 阶段 A 结论）。不需要逐 Route 抓取
- 生成方式：`npm run export:tableau-route-zips`，只读 `route-profiles.json`，不访问 DMS
- 粒度：一行 = 一个 Station 下某条 Route 的一个 ZIP
- 存储：本机 runtime 目录 `tableau/route-zips.csv`（不进 Git）
- 不包含任何指标（Difficulty / PPH / Volume 等）

| 字段 | 类型 | 定义 | 状态 |
|---|---|---|---|
| `station` | string | Station 代码，取自数据来源中明确的 Station，**不从 `route_name` 解析** | 已确认 |
| `route_id` | number \| null | DMS `roadAreaId`（与第 8、9 节相同）；来源不提供时为 null | 已确认 |
| `route_name` | string | Route 名称原值 | 已确认 |
| `postal_code` | string | 5 位 ZIP 字符串，保留前导 0，不转数字；与边界文件 `ZCTA5CE20` join | 已确认 |
| `source` | string | 取 snapshot 的 `source`（目前为 `dms-playwright`） | 已确认（TBL2） |
| `fetched_at` | ISO datetime | 该 Station snapshot 的 `fetched_at`（DMS 抓取时间，不是导出时间） | 已确认（TBL2） |

校验与冲突（不自动消解，Product Owner 2026-10-02 更新 spec M5）：抓取时 transform 已校验（第 8 节 `postal_codes`）；导出时再校验一次。同一 Station 内一个 `postal_code` 属于多条 Route、一个 `postal_code` 属于多个 Station、或格式 / 数量不符时，**导出失败并报告冲突明细，不写 CSV**。旧 snapshot 没有 `postal_codes` 时导出失败并提示重新运行 `npm run dms:scrape`。

CSV 注意：Tableau 读取文本文件时可能把 `postal_code` 推断为数字，TBL3 中需把该字段设为字符串（北加 ZIP 没有前导 0，但规则上必须是字符串）。

边界文件：Census 2020 ZCTA cb 1:500k（`cb_2020_us_zcta520_500k`），join key `ZCTA5CE20`。**ZCTA ≠ USPS 投递 ZIP 边界**；PO Box / 单一机构 / 2020 年后新设的 ZIP 可能没有 polygon（实测 SFO01-001 中 21 个 ZIP 有 6 个没有）。

## 11. District 业务配置（DS）

- 2026-10-26 经 Product Owner 授权，将 SFO02 追加到北加州现有 Station 顺序末尾（第十个），配置与数据库归属一致，数据库配置版本更新为 3。仅使用现有多站点批次入口获取该站数据，来源仍为已授权 DMS browser automation，沿用既有 snapshot / Detail schema、缓存完整性校验和 freshness 时间戳。详见 [SFO02 spec](features/sfo02-station.md)。

- Phoenix 配置完成后，Product Owner 于 2026-10-14 另行授权 DMS 抓取。现有浏览器自动化和 JSON/数据库 dual-write 流程已完成该片区可用站点的 snapshot / Detail 抓取及逐站激活；沿用既有字段、时间戳和缓存完整性规则，未更改 schema 或 Warehouse 数据。详见 [Phoenix capture 记录](features/phoenix-district.md#authorized-capture-continuation-2026-10-14)。

- 2026-10-14 新增 `phoenix`（凤凰城片区 / Phoenix District），与北加、丹佛、南加、西雅图同级；站点顺序为 PHX01、TUC01、CGZ01、PRC01、LAS01、STG01、IFP01、FLG01。文件与数据库冲突检查均无冲突，事务追加 8 个归属后数据库配置版本为 2。应用继续使用文件读取路径；本次没有运行 DMS，也没有修改 Route / ZIP 或 Warehouse 数据。

- 来源类型：人工维护的业务配置，文件为 `config/districts.json`，版本 `schema_version: 1`。配置可进 Git，不包含 DMS 运行数据或凭据。
- 粒度：一个 District 包含一个有序 Station 代码列表；`id` 唯一，`name_zh` / `name_en` 为显示名称，`stations` 的顺序为展示顺序。配置不决定 active Route，后者仍来自 Station snapshot。
- `/api/districts` 将配置与本地 snapshot 合并，Station 的 `has_snapshot` 仅表示该 Station 存在有效结构的 snapshot（成功空列表也算存在）。未配置但有 snapshot 的 Station 自动归入末尾 `unassigned`，按字母排序。
- `/api/route-map/district` 复用单站地图组装，逐站合并 Route、边界及缺少边界的 ZIP；coverage 汇总 Station–Route–ZIP 行数，跨站重叠按各站分别计数，不擅自判定唯一归属。missing 行增加 `station`，现有单站 API 字段不变。
- 快照非实时：响应中的 `stations[].fetched_at` 来自各 Station snapshot，地图按当前范围逐站显示更新时间，不生成虚假的统一数据时刻。详情难度仍使用既有 snapshot / detail join。
- 配置展示顺序独立于批处理抓取顺序；不改变 cache schema、清洗规则或 Tableau 导出结构。
