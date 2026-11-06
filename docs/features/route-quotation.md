# Route Quotation / DSP 报价（RQ）

- **状态：** Approved（设计定稿，Product Owner 2026-11-05）。**未写 migration，未改代码，未建角色，未授权实现。** 实现、正式库 migration、创建角色、导入真实报价均需另行授权。
- **相关文档：** `docs/data-schema.md` 第 12 节、`docs/features/central-db.md`（数据库角色 / 视图模式）、`docs/features/route-map.md`（地图 tooltip / 选中面板）、`docs/features/route-detail.md`（Route / ZIP 标识）、`docs/open-questions.md`「Route Quotation」。
- **不做（本阶段）：** Lark Bot / Lark Sheet 同步、xlsx 解析依赖、电子围栏附加费（模板第二个 sheet）、历史价格查询 UI、Station / District 价格汇总、写入 UI、DMS 改动、Route / ZIP snapshot 改动。

---

## 1. 目标

在 Dashboard 中显示各 Route / ZIP 当前生效的 DSP 报价：

- 主界面（线路档案、地图）只显示 **首票价格 0–1(lb) / Quotation for the First Parcel 0–1(lb)**。
- 点击后打开价格详情，显示完整报价结构（7 个重量段 × 首票 / 续票、生效日期、结束日期、报价日期）。
- 报价来源不是 DMS，单独建模，不混进 DMS snapshot；保留全部历史，支持未来生效。
- 后续数据链路：`Lark → 校验 Route → PostgreSQL → Dashboard API → 线路档案 + 地图`。本阶段只设计数据库 / API / UI。

## 2. Product Owner 决定（2026-11-05）

| # | 决定 |
|---|---|
| RQ-D1 | 价格粒度按实际报价表确认（第 3 节）。 |
| RQ-D2 | 线路档案：同一 Route 下 ZIP 价格不同时显示区间，如 `$1.75–$1.95`；全部相同显示单值；无价格显示 `—`。 |
| RQ-D3 | 地图：hover ZIP 显示**该 ZIP 自己的** 0–1 lb 首票价格。 |
| RQ-D4 | 新报价到生效日后，旧报价自动结束。支持提前录入未来生效报价。日期按 `America/Los_Angeles` 自然日。 |
| RQ-D5 | 重量段严格按原报价表字段保存和展示，不重新解释边界。 |
| RQ-D6 | 金额 USD，显示两位小数。 |
| RQ-D7 | `DATA_SOURCE=json` 时价格显示 `—`。 |
| RQ-D8 | 局域网只读 Dashboard（3000）可以显示报价。 |
| RQ-D9 | 主界面只显示 0–1 lb 首票价格；其他重量段和续票价格只在价格详情中显示。 |
| RQ-D10 | 不使用单一 `price` 字段；建完整报价结构，API 另外提供 `current_first_0_1lb_price` 给主界面。 |
| RQ-D11 | 报价日期允许为空，只作为来源元数据（将来由 PDF / Lark 补充），**不参与当前价格判断**。当前价格只依赖生效日期 / 结束日期。 |
| RQ-D12 | 有效期 `effective_from <= 当前日期 <= end_date`，结束日当天有效；`end_date` 为空表示长期有效。同一 Route + ZIP 同日多条有效时取生效日期最新者；临时报价结束后原长期报价自动恢复。 |
| RQ-D13 | 同一 Route + ZIP 出现**相同生效日期**的不同报价时不猜测，导入时作为冲突报错。 |
| RQ-D14 | 报价中的 Route 在 DMS active data 中找不到：不猜 `route_id`，不模糊匹配，该行拒绝并明确报告。倾向按行拒绝，不因个别行拒绝整个文件（评估结论见第 8 节：采用行级部分导入）。 |
| RQ-D15 | 首批 XLSX 导入暂不处理，不加依赖；等正式报价文件 / Lark 数据源准备好后再做。 |

## 3. 实际报价表结构（样例核对，2026-11-05）

Claude 只读核对了 Product Owner 本机的 8 份「新OA报价模板（含电子围栏报价）-202609.xlsx」（1 份空模板 + 7 份已填写，共 55 行），未复制任何数据进仓库。

**Sheet 1「新报价模板-无合并表格版」，22 列，一行一个 Route + ZIP：**

| 列 | 表头 | 说明 |
|---|---|---|
| A | 站点名称 / Station | **写法不统一**：`OAR`、`SCK`、`SMF`（城市码）与 `SFO02`（完整 Station 代码）并存，不能直接作为 Station 代码 |
| B | 车队名称 / Fleet | 形如 `OAR-WDA`（站点码-车队码）；一份文件可能含多个 Fleet（切线文件） |
| C | 线路名称 / Route | 形如 `OAR01-001`，与 DMS `route_name` 同格式 |
| D | 邮编 / Zipcode | 每行一个 5 位 ZIP（样例中没有多值、范围或空值） |
| E | 参考邮编（唯一值）/ Reference postal code | 样例中全部等于 D，含义未确认 |
| F–L | 首票价格 0-1 / 1-5 / 5-10 / 10-20 / 20-30 / 30-40 / 40(lb)以上 | 7 个重量段 |
| M–S | 续票价格（同一 stop 第二件及以后）同上 7 段 | |
| T | 报价生效日期 / Quotation Effective Date | 一般为 Excel 日期 |
| U | 报价结束日期 / Quotation End Date | 一般为 Excel 日期；**样例中出现过手输错误文本 `11/1/20217`** |
| V | 备注 / Remarks | 自由文本 |

**Sheet 2「电子围栏附加费」：** Station / Fleet / 电子围栏编码 / 附加费（票/美元）/ 生效日期 / 结束日期 / 截图 / 备注。样例全部为空，本阶段不做（RQ-Q8）。

**核对结论：**

1. **同一 Route 下不同 ZIP 价格确实不同**（样例中有 2 条 Route 出现两种 0–1 lb 首票价格）。→ 价格粒度为 **Route + ZIP**。
2. 同一文件内 `Route + ZIP` 没有重复。
3. 每份文件是**一次变更**（降价 / 价格增加 / 临时报价 / 切线邮编改动），只包含受影响的行，不是整个 Station 的完整报价表。→ 版本不能按「整站报价单」替换，必须按 `Route + ZIP` 逐行生效。
4. 存在「临时报价」：生效 1 周后结束，与已有长期报价时间重叠（按 RQ-D12 处理）。
5. 模板没有「报价日期 / Quotation Date」列（按 RQ-D11 处理）。
6. Station 列不可靠，Station 必须通过 Route 在 DMS active snapshot 中解析，不从 `route_name` 或 Station 列推断（与 `docs/data-schema.md` 第 8 节规则一致）。

## 4. 数据设计（之后的 migration `005_route_quotations.sql`，本阶段不写）

### 4.1 表

```text
quotation_weight_bands        重量段参考表（模板固定 7 段）
  code        text PK         '0_1','1_5','5_10','10_20','20_30','30_40','40_plus'
  ordinal     int UNIQUE
  label_zh    text            取自模板表头，如 '0-1(lb)'、'40(lb)以上'
  label_en    text            如 '0-1(lb)'、'Above 40(lb)'

route_quotation_imports       一次导入 = 一份来源文件 / 一次 Lark 同步（含被拒绝的导入，用于审计）
  id              uuid PK
  source          text  CHECK IN ('manual_file','lark_sheet','lark_bot')
  source_ref      text        文件名 / Lark sheet id / 消息 id
  quotation_date  date NULL   报价日期，来源元数据，不参与当前价格判断（RQ-D11）
  status          text  CHECK IN ('completed','partial','rejected')
  row_count       int NOT NULL      来源数据行数
  accepted_count  int NOT NULL      写入的行
  duplicate_count int NOT NULL      与已有有效行内容完全相同、跳过的行
  rejected_count  int NOT NULL      拒绝的行
  errors          jsonb NOT NULL    [{source_row, route_name, postal_code, code, message}]
  warnings        jsonb NOT NULL    同上结构
  imported_at     timestamptz NOT NULL DEFAULT now()
  imported_by     text NULL

route_quotation_lines         报价行 = 来源表的一行（Route + ZIP）
  id                     bigserial PK
  import_id              uuid  → route_quotation_imports
  source_row             int   来源表行号（排查用）
  station_code           text  → known_stations   由 Route 在 DMS active snapshot 解析得到
  route_id               bigint NOT NULL          DMS roadAreaId，由 route_name 解析
  route_name             text NOT NULL            原值
  postal_code            text NOT NULL CHECK (~ '^\d{5}$')
  station_label_raw      text   原 Station 列（OAR / SFO02 …）
  fleet_name             text   原 Fleet 列
  reference_postal_code  text NULL   原值，不解释（RQ-Q5）
  effective_from         date NOT NULL   报价生效日期
  end_date               date NULL       报价结束日期（含当天）；NULL = 长期有效
  remarks                text NULL
  voided_at              timestamptz NULL   作废（录错），不物理删除；作废一次导入 = 作废其全部行
  void_reason            text NULL
  UNIQUE (import_id, route_id, postal_code)
  CHECK (end_date IS NULL OR end_date >= effective_from)
  UNIQUE INDEX one_quote_per_key_day ON (route_id, postal_code, effective_from) WHERE voided_at IS NULL

route_quotation_prices        价格明细（长表）
  line_id      bigint → route_quotation_lines
  weight_band  text   → quotation_weight_bands
  parcel_type  text   CHECK IN ('first','additional')    首票 / 续票
  price        numeric(8,2) NOT NULL CHECK (price >= 0)  USD
  PRIMARY KEY (line_id, weight_band, parcel_type)
```

- **主键 / 业务键：** 报价的逻辑键是 `route_id + postal_code`；同一键可以有多条历史行（不同导入）。关联 DMS 用 `route_id`（稳定 ID），`route_name` 只作原值与校验。
- **为什么不用宽表：** 模板目前固定 14 个价格列，但重量段是业务配置；长表 + 参考表在模板变化时只需加参考行。导入时校验 14 个价格齐全，缺失即拒绝，不存 null 价格。
- **写入后不修改：** 行和价格只 INSERT；更正 = 作废相关行（或整次导入的全部行）后重新导入。可更新列仅行上的 `voided_at`、`void_reason`（列级 GRANT）。作废放在行上，使 `one_quote_per_key_day` 能在数据库层保证「同一 Route + ZIP 同一生效日期最多一条有效报价」（RQ-D13）。
- **不加 `active` 布尔、不维护 `effective_to`：** 当前价格由日期规则推导（4.2），避免两套状态不一致。
- **不改任何现有表。** DMS snapshot / Route Detail 完全独立。

### 4.2 当前价格的推导规则

对某个 `route_id + postal_code`，在洛杉矶自然日 `D`（`(now() AT TIME ZONE 'America/Los_Angeles')::date`）：

1. 候选 = 未作废、`effective_from <= D`、且 `end_date` 为空或 `D <= end_date` 的行（结束日当天有效，RQ-D12）。
2. 当前行 = 候选中 `effective_from` 最大者。`one_quote_per_key_day` 保证不会并列，不需要其他排序依据。
3. 没有候选 → 无价格，显示 `—`。
4. `quotation_date`、`imported_at` 不参与判断（RQ-D11）。

效果：

- 新报价到生效日自动取代旧报价（RQ-D4），旧行保留为历史。
- 未来生效的行在到日前不显示，到日自动生效。
- 临时报价（较晚生效、较早结束）在有效期内生效；结束后，原长期报价若仍在有效期内自动恢复显示（RQ-D12）。
- 某报价已过结束日且没有其他有效行 → `—`。

### 4.3 视图与权限

- `v_route_quotation_current`：按 4.2 用 `DISTINCT ON (route_id, postal_code)` 输出当前行 + 14 个价格（透视后）+ `effective_from`、`end_date`、`quotation_date`、`fleet_name`、`imported_at`。
- `v_route_quotation_first_0_1lb`：只有 `route_id, postal_code, price`，供主界面查询。
- `v_route_quotation_upcoming`：每个键最早的未来生效行（详情中提示「下次生效」）。
- `v_quotation_weight_bands`。
- reader 只读上述视图；新增写入角色 `nc_quotation`（与 `nc_warehouse` / `nc_district` 同模式：仅 INSERT 和指定列 UPDATE，读取 `v_active_routes` 以解析 Route）。新增角色和执行 migration 需 Product Owner 批准（`AGENTS.md` 第 2.5 节）。

## 5. Join 与汇总规则

| 场景 | 规则 |
|---|---|
| 地图 ZIP | 用 DMS 当前 snapshot 的 `(route_id, postal_code)` 匹配 `v_route_quotation_first_0_1lb` |
| 线路档案 Route | 对该 Route 在 DMS 当前 snapshot 的全部 ZIP 取 0–1 lb 首票价格：全部相同 → 单值；不同 → `min–max`；部分 ZIP 无价格 → 仍按有价格的 ZIP 显示，并在详情列出缺价 ZIP；全部无价格 → `—` |
| ZIP 已被切到另一 Route（DMS 已更新） | 按新 Route + ZIP 匹配；旧 Route 的报价行不会显示到新 Route 上 |
| 切线报价已生效但 DMS 尚未更新 | 新 Route + ZIP 匹配不到 → 该 ZIP 在 DMS 所属 Route 下显示旧报价（若仍有效）或 `—`；不猜测 |
| 报价有、DMS 当前 Route 不含该 ZIP | 不在主界面显示；详情中列为「报价中有、DMS 当前不在此 Route 的 ZIP」 |
| 一个 ZIP 属于多个 Station（ZIP 查询 owners） | 每个 owner 各自按 Route + ZIP 匹配，不合并 |

价格新鲜度与 DMS `fetched_at` 分开：报价有自己的 `effective_from` / `imported_at`，不影响 Station 的 Last Updated。

## 6. API 设计

### 6.1 现有接口新增字段（主界面）

| 接口 | 新增字段 |
|---|---|
| `GET /api/route-profiles` 每行 | `current_first_0_1lb_price`（全部 ZIP 一致时为数值，否则 null）、`current_first_0_1lb_price_min`、`current_first_0_1lb_price_max`、`quoted_zip_count`、`unquoted_zip_count` |
| `GET /api/route-map`、`/api/route-map/district` 的 feature properties | `current_first_0_1lb_price`（ZIP 自己的价格或 null） |
| `GET /api/route-map/zip` 每个 owner | `current_first_0_1lb_price` |
| `GET /api/capabilities` | `route_quotation: true \| false`（json 模式为 false） |

金额以 JSON number 返回（两位小数精度），格式化只在前端做。

### 6.2 新增价格详情接口

```text
GET /api/route-quotations/:route_id
200 {
  route_id, route_name, station,
  weight_bands: [{ code, label_zh, label_en }],           // 按 ordinal
  groups: [{                                              // 当前报价完全相同的 ZIP 合成一组
    postal_codes: ["94601", ...],
    fleet_name, effective_from, end_date, quotation_date, remarks,
    first:      { "0_1": 1.75, "1_5": ..., "40_plus": ... },
    additional: { "0_1": ..., ... }
  }],
  unquoted_postal_codes: [...],     // DMS 当前 Route 有、无当前报价
  extra_quoted_postal_codes: [...], // 有当前报价、DMS 当前 Route 不含
  upcoming: [{ postal_codes, effective_from }],          // 未来生效（只提示日期）
  updated_at                                             // 最近一次相关导入时间
}
404 route_not_found     Route 不在任何 active snapshot
503 data_source_unavailable / json 模式
```

分组键 = 14 个价格 + `effective_from` + `end_date` + `fleet_name` 全部相同。历史查询（`?as_of=`、`/history`）不在本阶段。

### 6.3 分层

```text
PostgreSQL 视图 → db-data-source（listCurrentFirstPrices / getRouteQuotation）
               → server/src/quotations/（汇总、分组、join 规则，纯函数）
               → route-map.js / profile 投影只调用 quotations 模块
               → API
```

json 数据源实现同一接口并返回空结果。不把汇总逻辑写进 `route-map.js`。

## 7. UI 设计

### 7.1 线路档案（3000 `/`）

- 新增列「首票价格」，位置在 DSP 之后或末尾（实现时按截图 `线路档案.png` 布局确定，预览时由 Product Owner 确认）。表头 `title` 显示完整名称「首票价格 0–1(lb) / Quotation for the First Parcel 0–1(lb)」。
- 单元格：`$1.75` / `$1.75–$1.95` / `—`。有价格时为按钮，点击打开价格详情；`—` 不可点击。
- 可排序：按最低价排序，无价格排最后。
- 不显示其他重量段或续票价格。

### 7.2 地图（`/map`）

- ZIP tooltip（`zipDetails`）在 ZIP / Route / DSP 之后增加一行「首票价格  $1.75」，取该 ZIP 自己的价格，无价格 `—`。
- 选中 Route 的面板显示 Route 级价格（单值或区间）和「价格详情」按钮。
- ZIP 查询结果的每个 owner 显示该 owner 的 ZIP 价格。

### 7.3 价格详情（共享组件，抽屉）

```text
┌ SFO01-001 · 价格详情 ─────────────────── ✕ ┐
│ Station SFO01                               │
│                                             │
│ 适用 ZIP：94601, 94602, 94605（+3）          │
│ Fleet SFO01-XXX                             │
│ Effective Date 2026-11-01 · End 2027-11-01  │
│ Quotation Date —                            │
│ 重量段            首票        续票          │
│ 0-1(lb)          $x.xx       $x.xx          │
│ 1-5(lb)           …           …             │
│ 5-10 / 10-20 / 20-30 / 30-40 / 40(lb)以上   │
│ 备注：…                                      │
│                                             │
│ （价格不同的另一组 ZIP 显示第二张表）        │
│ 无当前报价的 ZIP：94603                      │
│ 下次生效：2026-12-01（2 个 ZIP）             │
└─────────────────────────────────────────────┘
```

- 从地图 ZIP 打开时高亮该 ZIP 所在组。
- 状态：加载中、错误（可重试）、无报价（「该 Route 暂无报价」）、json 模式（不显示入口）。
- 重量段标签取自 `weight_bands`，前端不硬编码边界。

## 8. 导入校验（为后续 Lark / 文件导入定义，本阶段不实现）

### 8.1 部分导入还是整批拒绝（评估结论：行级部分导入）

现有「整批」语义来自 DMS snapshot：一个 Station 的 Route 列表互相关联（同站 ZIP 唯一归属），缺一行就是不完整的快照，所以 snapshot 必须整批生效。报价数据不同：

- 每行是独立的 `Route + ZIP` 键，展示时也逐键 join DMS 当前数据。少导入一行，只是该 ZIP 继续显示旧报价或 `—`，不会显示错误价格。
- 来源文件本身就是增量变更，不存在「整站完整性」要求。
- 切线文件涉及多条 Route，部分导入时可能出现「新 Route 的行已生效、另一条 Route 的行被拒」。由于 join 同时要求 Route 和 ZIP 匹配 DMS，结果仍是旧价或 `—`，不会把价格挂到错误的 Route 上。

因此采用 **行级部分导入**，并配套三条规则：

1. **两阶段：** 先校验全部行，再在**一个事务**中写入全部通过的行和导入记录。数据库中不会出现写了一半的行；被拒行和原因写入导入记录的 `errors`。
2. **文件级错误仍整份拒绝：** 表头与模板不匹配、无法读取、没有数据行。此时没有可信的逐行结果。
3. **幂等重导：** 与已有有效行键相同、生效日期相同、且全部内容（14 个价格、结束日期、Fleet、Route 名称）完全一致的行，视为已导入，计入 `duplicate_count` 并跳过，不算冲突。这样修正错误后可以把整份文件重新导入，已成功的行不会被报冲突。内容不同才按 RQ-D13 报冲突。

导入串行执行（事务内加 advisory lock），避免两次导入同时通过同一冲突检查。将来 Lark Bot 可以先校验、回复错误清单，再写入；规则不变。

### 8.2 逐项检查

| 检查 | 级别 | 结果 |
|---|---|---|
| 表头与模板 22 列逐列匹配（忽略换行 / 空白） | 文件 | 不匹配 → 整份拒绝（模板变更需更新参考表） |
| 没有数据行 / 无法读取 | 文件 | 整份拒绝 |
| `route_name` 在 DMS active snapshot 中精确解析出唯一 `route_id` + Station | 行 | 找不到 → 拒绝该行（RQ-D14），不模糊匹配 |
| ZIP 为 5 位字符串 | 行 | 否则拒绝该行 |
| 同一文件内 `route_id + postal_code` 重复 | 行 | 重复的各行**全部**拒绝（不挑选） |
| 14 个价格齐全、数值 ≥ 0、最多两位小数 | 行 | 否则拒绝该行（不四舍五入） |
| 生效 / 结束日期为合法日期，结束 ≥ 生效；结束日期可为空 | 行 | 否则拒绝该行（如 `11/1/20217`），不自动修正 |
| 与已有有效行键相同、生效日期相同、内容完全一致 | 行 | 跳过，计入 `duplicate_count` |
| 与已有有效行键相同、生效日期相同、内容不同 | 行 | 冲突，拒绝该行（RQ-D13）；如需更正，先作废旧行再导入 |
| ZIP 不在该 Route 的 DMS 当前 ZIP 中 | 行 | 警告，照常写入（切线报价可能先于 DMS 更新） |
| Fleet 与 DMS `dsp_name` 不一致 | 行 | 警告，照常写入（RQ-Q4） |
| Station 列与解析出的 Station 不一致 | — | 只保存原值，不校验（RQ-Q3） |

导入结果：全部通过 → `completed`；有拒绝行但至少写入一行（或全部为重复跳过） → `partial`；没有可写入的行或文件级错误 → `rejected`。报告列出每个被拒行的行号、Route、ZIP 和原因。

## 9. 影响的模块（实现时）

| 层 | 文件 |
|---|---|
| DB | 新 `server/db/migrations/005_route_quotations.sql`；`docs/deployment.md` 增加角色和连接串 `NC_DB_QUOTATION_URL` |
| 数据源 | `server/src/db/db-data-source.js`、`server/src/store/data-source.js` |
| 业务 | 新 `server/src/quotations/`；`server/src/route-map/route-map.js`、profile 投影只做调用 |
| API | `server/src/api/app.js`（详情路由、capabilities） |
| 前端 | `web/app.js`、`web/index.html`、`web/format.js`、`web/map-view.js`、`web/map-panel.js`、`web/map-text.js`、新 `web/price-detail.js`、`web/styles.css` |
| 工具 | `server/src/db/parity.js`：比较时排除报价字段（json 恒为 null） |

**对现有功能的影响（`AGENTS.md` 第 5 节）：** 线路档案、地图、ZIP 查询、Route Detail、刷新流程行为不变，只增加字段和一个入口；legacy `nc-ops-console-main/`（含 ZIP 价格表 `price_adjustments.csv`）不动。

## 10. 验收标准（实现阶段）

- **AC1** migration 只新增 4 张表、4 个视图和 `nc_quotation` 角色，不修改现有表；reader 只能读视图。
- **AC2** 当前价格按 4.2 推导：用固定日期的测试覆盖正常替换、未来生效、临时报价覆盖与结束后恢复、结束日当天仍有效、`end_date` 为空长期有效、过期无后继、作废行；数据库拒绝同键同生效日期的第二条有效行。
- **AC3** 日期以 `America/Los_Angeles` 自然日计算（测试覆盖 UTC 跨日时刻）。
- **AC4** `/api/route-profiles` 返回单值 / 区间 / 部分缺价 / 全部缺价四种情况的字段正确。
- **AC5** 地图 feature 的价格为 ZIP 自己的价格；ZIP 切到另一 Route 时不显示旧 Route 价格。
- **AC6** `/api/route-quotations/:route_id` 按完全相同的价格分组，返回 14 个价格、日期、Fleet、备注、缺价 ZIP、额外 ZIP、未来生效提示；未知 Route 返回 404。
- **AC7** json 模式下所有价格字段为 null，`route_quotation=false`，UI 显示 `—` 且无详情入口。
- **AC8** 线路档案显示「首票价格」列（`$1.75` / `$1.75–$1.95` / `—`），可排序，点击打开详情；主表不出现其他重量段。
- **AC9** 地图 tooltip 显示「首票价格」行；Route 面板有详情入口；详情组件两个页面共用。
- **AC10** 金额统一两位小数加 `$`；重量段标签来自 API。
- **AC11** `npm test` 通过；`db:parity` 忽略报价字段后仍通过。
- **AC12** Product Owner 本地预览签字。

## 11. 未决问题

RQ-Q1、Q2、Q7、Q9 已由 Product Owner 回答（RQ-D11 至 RQ-D15）。其余 RQ-Q3 至 Q6、Q8、Q10 不阻塞 RQ-T1 至 T3，按本文当前设计（只存原值 / 只警告 / 拒绝坏数据 / 不做电子围栏 / 标签照原表）执行，在 RQ-T4 导入实现前确认。见 `docs/open-questions.md`「Route Quotation」。

## 12. Codex 任务拆分（授权后）

| 任务 | 内容 | 依赖 |
|---|---|---|
| RQ-T1 | migration 005 + 视图 + 角色定义 + DB 测试（仅测试库），不在正式库执行、不创建正式角色 | 实现授权 |
| RQ-T2 | `server/src/quotations/` 纯函数 + 数据源 + API 字段 + 详情接口 + parity 调整，fixture 测试 | RQ-T1 |
| RQ-T3 | 线路档案列、地图 tooltip / 面板、价格详情组件 | RQ-T2 |
| RQ-T4 | 导入入口（Lark 或正式报价文件，RQ-D15），按第 8 节行级部分导入；如需 xlsx 解析依赖另行批准 | 数据源准备好后另行授权 |

正式库执行 migration、创建角色、导入真实报价均需 Product Owner 单独批准。
