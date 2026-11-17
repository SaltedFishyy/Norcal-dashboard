# 线路地图：按价格着色 / Map Price Coloring

- 状态：**Approved**（需求已确认，Product Owner 2026-11-17），**待实现授权**
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

- `PRICE_COLORS`：5 档颜色从浅到深，加 `none`（无报价，用与难易度 `unknown` 相同的 `#9ca3af`）。初始值：`#c4b5fd`、`#a78bfa`、`#8b5cf6`、`#6d28d9`、`#4c1d95`（紫色，避开底图水面的蓝色和“未覆盖 ZIP”的粉色）。在 3200 上看过实际效果后可以调整色值，但必须保持单一色相、由浅到深。
- `priceScale(features)`：从片区 features 中取有效的首票价格（有限数字，`null` / 非数字视为无报价），返回 `{ min, max, bins }`；没有任何价格时返回空分档。
- `priceBin(price, scale)`：返回 0–4 或 `null`（无报价 / 空分档）。按**整数美分**计算，避免浮点误差；档宽 = (max − min) / 5，`bin = floor((price − min) / 档宽)`，结果钳制到 0–4（max 落在第 4 档，片区外的价格钳制到两端）。min = max 时全部归中间档（第 2 档）。
- `priceColor(price, scale)`：返回颜色。
- 图例数据：每个非空档返回该档**实际出现的**最低价和最高价（例如 `$1.75–$1.80`；只有一个价格时显示 `$1.85`）。空档不出现在图例里。

### 4.2 接入地图

- `assignAllColors()` 的返回值增加 `groupColors.price = priceScale(features)`，随片区数据一起计算一次，不在每个多边形上重复计算。
- `modeColor(p, 'price', …)`：有 `current_first_0_1lb_price` 字段时（ZIP 多边形）按它着色；否则（线路列表项）按 `current_first_0_1lb_price_max` 着色（MPC-D7）。
- `polygonStyle()`：`price` 模式的样式规则与 `difficulty` 完全相同（直接用档位颜色、常态用 `difficultyFillOpacity`、淡化 / 范围外 / 选中沿用现有状态）。实现时把“难易度式着色”抽成一个判断（如 `mode === 'difficulty' || mode === 'price'`），不复制两份分支。
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
| MPC-T1 | `web/price-scale.js` 分档纯函数 + 单元测试（4.1） | `web/price-scale.js`、测试 | 待授权 |
| MPC-T2 | 接入地图：颜色上下文、`modeColor` / `polygonStyle`、按钮、图例、列表色块 + 测试（4.2） | `web/map-state.js`、`web/map-view.js`、`web/map-text.js`（`web/map-panel.js` 预计不用改） | 待授权，依赖 T1 |

## 10. 实现记录

（待实现）
