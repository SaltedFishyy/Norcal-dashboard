# 线路地图：按价格着色 / Map Price Coloring

- 状态：**Approved**（需求已确认，Product Owner 2026-11-17），**Awaiting preview sign-off**（实现授权 2026-11-17）
- 关联：`docs/features/route-map.md`、`docs/features/map-visual-refresh.md`、`docs/features/route-quotation.md`、`docs/data-schema.md`（Route Quotation 节）
- 编号前缀：MPC

## 1. 目标

在线路地图的颜色模式里加“按价格”：每个 ZIP 按自己的首票价格着色，越贵越深，一眼看出价格高低的分布。

## 2. 已确认的规则（Product Owner 2026-11-17）

| 编号 | 规则 |
|---|---|
| MPC-D1 | 只用**首票 0–1 lb 价格**（`current_first_0_1lb_price`）。续票和其他重量段不参与，也不在这个模式里显示。 |
| MPC-D2 | 分档范围按**当前片区**：取当前片区地图数据里所有有价 ZIP 的最低价到最高价，平均分成 **5 档**。切换站点 / DSP 筛选时分档不变；切换片区或日期时重新计算。 |
| MPC-D3 | 单一色相，**越贵越深**。 |
| MPC-D4 | 没有报价的 ZIP 用中性灰，图例单独一行“无报价”；整个片区都没有报价时（例如目前的 south-cal），全部为灰，图例写“该片区暂无报价”。暂时这样，后续再看。 |
| MPC-D5 | 选中线路时沿用现有的高亮、外框和淡化规则，ZIP 仍按自己的价格着色。 |
| MPC-D6 | 只改前端：不改数据、API、store、schema。 |

Claude 暂定、PO 看 spec 时可改：

| 编号 | 规则 |
|---|---|
| MPC-D7 | 左侧线路列表的色块用该线路的**最高首票价**（`current_first_0_1lb_price_max`）按同一分档着色；没有价格时为灰。（MPC-Q1） |

## 3. 现状（2026-11-17，3200 只读核对）

| 片区 | 有价 ZIP / 全部 | 首票范围 | 不同价格数 |
|---|---|---|---|
| north-cal | 423 / 445 | 1.55 – 2.20 | 14 |
| denver | 291 / 309 | 1.65 – 2.15 | 11 |
| seattle | 253 / 269 | 1.70 – 2.05 | 8 |
| phoenix | 152 / 240 | 1.75 – 2.05 | 7 |
| south-cal | 0 / 742 | — | 0 |

价格都是 0.05 一档、范围很窄，所以用 5 个离散档而不是连续渐变。

现有代码：

- 颜色模式按钮：`web/map-view.js` 约第 121 行（`route / dsp / station / difficulty`），文案在 `web/map-text.js`。
- 着色：`web/map-state.js` 的 `modeColor()`（约第 348 行）和 `polygonStyle()`（约第 54 行）。“按难易度”是最接近的先例：直接用等级颜色、不做路线色变换，常态不透明度用 `difficultyFillOpacity`（0.55），淡化 / 范围外沿用 `dimmed` / `outside`。
- 颜色上下文：`assignAllColors()`（`web/map-state.js` 约第 363 行）返回 `{ routeColors, groupColors: { dsp, station } }`，由 `web/map.js` 约第 278 行在片区数据加载时计算一次，再传给 view 和 panel。
- 图例：`web/map-view.js` 的 `updateLegend()`（约第 139 行），难易度分支是先例。
- 列表色块：`web/map-panel.js` 约第 80 行，调用 `modeColor(route, …)`。
- ZIP 属性已有 `current_first_0_1lb_price`；线路已有 `current_first_0_1lb_price_min / _max`。

## 4. 设计

### 4.1 价格分档（纯函数）

新建 `web/price-scale.js`（与 `web/difficulty.js` 并列，CH-T4 后新文件不需要重启服务）：

- `PRICE_COLORS`：5 档颜色从浅到深，加 `none`（无报价，用与难易度 `unknown` 相同的 `#9ca3af`）。Product Owner 2026-11-17 选择方案 A，以黄→橙→红替换原紫色：`#fed976`、`#feb24c`、`#fd8d3c`、`#e31a1c`、`#800026`。
- `priceScale(features)`：从片区 features 中取有效的首票价格（有限数字，`null` / 非数字视为无报价），返回 `{ min, max, bins }`；没有任何价格时返回空分档。
- `priceBin(price, scale)`：返回 0–4 或 `null`（无报价 / 空分档）。按**整数美分**计算，避免浮点误差；档宽 = (max − min) / 5，`bin = floor((price − min) / 档宽)`，结果钳制到 0–4（max 落在第 4 档，片区外的价格钳制到两端）。min = max 时全部归中间档（第 2 档）。
- `priceColor(price, scale)`：返回颜色。
- 图例数据：每个非空档返回该档**实际出现的**最低价和最高价（例如 `$1.75–$1.80`；只有一个价格时显示 `$1.85`）。空档不出现在图例里。

### 4.2 接入地图

- `assignAllColors()` 的返回值增加 `groupColors.price = priceScale(features)`，随片区数据一起计算一次，不在每个多边形上重复计算。
- `modeColor(p, 'price', …)`：ZIP 多边形（属性里有 `postal_code`）按 `current_first_0_1lb_price` 着色；线路摘要（没有 `postal_code`）按 `current_first_0_1lb_price_max` 着色（MPC-D7）。线路摘要也带 `current_first_0_1lb_price`（只有全部 ZIP 同价时非 null），所以不能用这个字段是否存在来区分。（2026-11-17 Claude 修正：原文写成按价格字段是否存在区分。）
- `polygonStyle()`：`price` 模式直接用档位颜色，常态不透明度用 `priceFillOpacity`（0.75）；`difficulty` 常态仍用 `difficultyFillOpacity`（0.55）。淡化 / 范围外 / 选中沿用现有状态。实现时把“难易度式着色”抽成一个判断（如 `mode === 'difficulty' || mode === 'price'`），不复制两份分支。
- 按钮：在“按难易度”后加“按价格”（`t.byPrice`）。
- 图例：标题“按价格（首票 0–1 lb）”，按档位由浅到深列出价格区间，最后一行“无报价”（灰色，只在存在无报价 ZIP 时显示）。整个片区都没有报价时只显示“该片区暂无报价”。
- 悬停提示和侧栏详情已经显示首票价格，不改。

## 5. 边界情况

- 无报价 ZIP（phoenix 有 88 个）：灰色，图例“无报价”。
- 全片区无报价（south-cal）：全部灰色，图例“该片区暂无报价”，不报错。
- 片区只有一个价格：一档，图例一行。
- 档位里没有价格：图例不显示该档。
- ZIP 搜索显示的 ZIP 不在当前片区价格范围内：钳制到两端档位。
- 价格为 0 或负数：按普通数字处理（目前数据里没有；不做特殊规则）。
- 按日期查看：用该日期加载的片区数据计算分档。

## 6. 验收标准

- AC1：颜色模式里有“按价格”，位于“按难易度”之后；点击后按下状态正确，其他模式行为不变。
- AC2：每个 ZIP 按首票 0–1 lb 价格着色，5 档单一色相，越贵越深；分档按当前片区最低价到最高价平均分，计算用整数美分。
- AC3：切换站点或 DSP 筛选时分档和颜色不变；切换片区或日期时重新计算。
- AC4：无报价 ZIP 为灰色，图例有“无报价”；south-cal 全部为灰，图例显示“该片区暂无报价”，控制台没有错误。
- AC5：图例按档位列出实际价格区间，空档不显示；左侧列表色块按线路最高首票价着色。
- AC6：选中线路、淡化、范围外、悬停的外框和不透明度规则与“按难易度”一致。
- AC7：`npm test` 全部通过，`git diff --check` 通过；不改 API / store / schema，不新增 dependency。
- AC8：Claude 在 3200 用 north-cal、phoenix、south-cal 检查实际效果（颜色能分清、浅档在米色底图上看得出），截图给 Product Owner；Product Owner 预览签字。

## 7. 测试要求

- `price-scale.js` 单元测试：美分计算（1.55–2.20 的边界值）、max 归第 4 档、min = max、全部无报价、非数字 / `null`、范围外钳制、图例区间（实际最低 / 最高、空档省略）。
- `modeColor` / `polygonStyle` 在 `price` 模式下的颜色与不透明度（常态、选中、淡化、范围外），以及线路项用 `_max`。
- 图例渲染：正常片区、有无报价 ZIP、全片区无报价。
- 按钮列表包含“按价格”。现有断言如果写死了按钮数量，允许只为此更新。

## 8. 影响与风险

- 只影响线路地图页的颜色模式，线路档案页不受影响。
- 首票价格来自报价数据（`docs/features/route-quotation.md`）；报价未同步的片区（south-cal）看不到差别，这是数据问题，不在本功能里处理。
- 不涉及权限、secret、数据迁移。

## 9. Codex 任务拆分

| 任务 | 内容 | 主要文件 | 状态 |
|---|---|---|---|
| MPC-T1 | `web/price-scale.js` 分档纯函数 + 单元测试（4.1） | `web/price-scale.js`、测试 | Awaiting preview sign-off |
| MPC-T2 | 接入地图：颜色上下文、`modeColor` / `polygonStyle`、按钮、图例、列表色块 + 测试（4.2） | `web/map-state.js`、`web/map-view.js`、`web/map-text.js`（`web/map-panel.js` 预计不用改） | Awaiting preview sign-off |
| MPC-T3 | 按方案 A 调整价格配色和常态不透明度 | `web/price-scale.js`、`web/map-state.js`、测试 | Awaiting preview sign-off |

## 10. 实现记录

### MPC-T4

- 价格按整数美分每 5 美分分档，使用九个锚点插值；空档保留计数但不显示在图例中。
- 价格模式常态不透明度调整为 0.85，价格图例改为两列；实际片区预览及签字仍待完成。
- 第 1 轮修复：价格图例解除通用高度限制，切换其他模式时恢复通用限制，并增加模式切换测试。
- 第 2 轮修复：切换价格图例类时保留 Leaflet 等已有类，并增加模式切换回归测试。

### MPC-T3

- 价格色表改为方案 A 的黄→橙→红，价格模式常态不透明度改为 0.75；难易度模式常态及其他状态保持原值。
- 更新价格色表和不透明度测试；实际视觉效果仍待 Product Owner 预览签字。

### MPC-T1

- 新增 `web/price-scale.js`，导出 `PRICE_COLORS`、`PRICE_BIN_COUNT`、`priceCents`、`priceScale`、`priceBin`、`priceColor` 和 `priceLegend`；分档结果及其嵌套数组和对象冻结。
- 新增 `server/test/price-scale.test.js`，5 项测试全部通过。
- `npm.cmd test`：939 项中 938 项通过、1 项失败；既有 `freshness.test.js:44` 的 AR-T3 测试读取 null 的 `district_count` 时抛出 TypeError，该测试单独重跑通过。`git diff --check` 通过。
- 本任务未接入地图；地图集成和预览属于后续任务。

### MPC-T2

- 将片区价格分档接入地图、线路列表色块、颜色模式按钮及图例；缺少分档时使用无报价颜色。
- 增加价格模式、图例和缺失分档测试；`npm.cmd test` 941 项通过，`git diff --check` 通过。
- 实际片区视觉检查和 Product Owner 预览签字待后续完成。
- 第 0 轮第一次运行时 Codex 停下指出 spec 4.2 用“价格字段是否存在”区分 ZIP / 线路有误（线路摘要也有该字段），Claude 改为按 `postal_code` 区分后重跑，一次通过。

### Claude 验收（2026-11-17）

- 代码审查：T1 分档公式按整数美分实现，phoenix / north-cal 边界手算一致；T2 价格模式与难易度共用 `scaleMode` 判断，没有复制分支；线路色块按 `_max`；未改 API / store / 依赖。
- 3200 浏览器检查（Playwright，1600×900）：
  - north-cal：图例 `$1.55–$1.60 / $1.68–$1.80 / $1.85–$1.90 / $1.95–$2.05 / $2.10–$2.20 / 无报价`，五档颜色都能分清，最浅档在米色底图上可见；列表色块 6 种颜色（含灰）。
  - phoenix：图例 `$1.75–$1.80 / $1.85 / $1.90 / $1.95 / $2.00–$2.05 / 无报价`。
  - south-cal：全部灰色，图例只有“该片区暂无报价”。
  - 切换到站点 SFO01 后图例不变（AC3）；选中线路沿用现有高亮和外框（AC6）；控制台 0 个错误。
- 小问题（未改）：图例标题沿用现有 CSS 大写样式，显示为 “0–1 LB”。
- AC1–AC7 通过；AC8 待 Product Owner 预览签字。

## 11. 每 $0.05 一色（MPC-P2，Product Owner 2026-11-17）

### 11.1 背景与决定

5 档等宽分档把多个价格合进一档（如 north-cal 的 `$1.68–$1.80`），Product Owner 希望“按每 0.05 换颜色”。Claude 在 3200 用浏览器临时替换做了 5 套预览（黄橙红、彩虹、蓝↔红、黄→紫、每 $0.10 一档），Product Owner 2026-11-17 选**黄 → 橙 → 红、每 $0.05 一色**（“用黄橙红”），已知代价：相邻两档颜色接近，需要靠图例 / 悬停看具体价格。

| 编号 | 决定（替代 MPC-D2 的“平均分 5 档”） |
|---|---|
| MPC-D8 | 分档单位 = **$0.05**：`step = floor(美分 / 5)`。不在 0.05 整数倍上的价格向下归档（$1.62 → $1.60 档，$1.68 → $1.65 档）。档位范围从当前片区最低价所在档到最高价所在档（仍按当前片区，MPC-D2 的范围规则不变）。 |
| MPC-D9 | 颜色：沿 9 个锚点 `#ffffcc, #ffeda0, #fed976, #feb24c, #fd8d3c, #fc4e2a, #e31a1c, #bd0026, #800026`（黄 → 橙 → 红 → 深红）线性插值；第 i 档（共 n 档）取位置 `i / (n − 1)`，只有 1 档时取中间。越贵越深不变。 |
| MPC-D10 | 价格模式常态不透明度 **0.85**（原 0.75）；其他状态不变。 |
| MPC-D11 | 图例完整显示所有非空档（最多约 15 行 + “无报价”），不出现滚动截断：价格档位用两列排列。label 仍为档内实际最低–最高价（如 `$1.60–$1.62`），只有一个价格时显示单价。 |

### 11.2 验收标准

- MPC-AC9：north-cal 14 档、south-cal 14 档、phoenix 7 档；$1.62 与 $1.60 同色，$1.68 与 $1.65 同色（如两者都存在）。
- MPC-AC10：颜色由浅黄到深红单调变深；最低档 = 第一个锚点、最高档 = 最后一个锚点。
- MPC-AC11：价格模式常态不透明度 0.85，难易度仍 0.55。
- MPC-AC12：1600×900 下图例所有档位和“无报价”都可见，不需要滚动。
- MPC-AC13：`npm test`、`git diff --check` 通过；其他模式行为不变。
- MPC-AC14：Claude 在 3200 截图 north-cal、south-cal（LAX02）、phoenix；Product Owner 预览签字。

### 11.3 任务

| 任务 | 内容 | 主要文件 | 状态 |
|---|---|---|---|
| MPC-T4 | 每 $0.05 分档 + 插值配色 + 不透明度 0.85 + 两列图例 + 测试 | `web/price-scale.js`、`web/map-state.js`、`web/map-view.js`、`web/styles.css`、测试 | Awaiting preview sign-off（Claude 验收：npm test 947/947；3200 实测 north-cal 14 档、south-cal 14 档、phoenix 7 档，1600×900 图例无滚动；修复 2 轮：r1 价格图例去掉 250px 限制；r2 改用 classList.toggle，保留 leaflet-control 类） |
