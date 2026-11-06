# Route Detail / ZIP Profile（路区 ZIP 画像）— Spec

- Status: **Approved**（Product Owner 2026-10-02 确认方向并授权实现第一版）
- 更新：2026-10-02
- 相关：`docs/features/dms-refresh.md`（T3 scraper、T6 API、T7 前端）；`docs/data-schema.md` 第 9 节；`docs/open-questions.md`「Route Detail」

---

## 1. 目标

在 T7 的 Route Profile 表格里，点击 Route Name 打开 Route Detail modal，显示该 Route 下每个 ZIP 的画像数据（DMS「标签详情」）。

数据通过**按 Route 手动运行的抓取命令**写入本地缓存。页面只读缓存，**不在点击时访问 DMS**。

## 2. 已确认的决定（Product Owner 2026-10-02）

| # | 决定 |
|---|---|
| R1 | 获取方式：按 Route 抓取 + 本地缓存。不做点击时实时访问 DMS；不批量预抓全部 Route；不直接调用 DMS 接口（继续用页面操作 + 截获响应，与 T3 一致） |
| R2 | 第一版只支持单 Route：`npm run dms:scrape-route-detail -- --route SFO01-001`。真实验证只做 SFO01-001 |
| R3 | 输出独立文件 `runtime-data/route-details.json`，按 `route_id` 保存；**不修改 `route-profiles.json`** |
| R4 | ZIP 逻辑唯一标识：`route_id + postal_code` |
| R5 | `postalCodeTag` 只保存原值（`postal_code_tag`），**不解释**为 NEW，等更多样本确认 |
| R6 | First-mile Distance 保留并显示，但它是 Route 级的「所属路区首单里程」，只是在每个 ZIP 行重复显示，不是 ZIP 独立指标 |
| R7 | 百分比字段保存 DMS 原始小数；前端显示时 ×100 加 `%`，不修改原始数据 |
| R8 | （**2026-10-05 起由 RM-Q1 改为五色**，见 `route-map.md` RM5-6；RM5 实现时生效）难易度颜色（Route 主表和 modal 共用）：`D级 极易` / `C级 易` → 绿；`B级 中` → 黄；`A级 难` / `S级 极难` → 红；null 或其他未知值 → 灰。显示文字仍是 DMS 原值，不改名 |
| R9 | 没抓过的 Route：modal 显示 “No detail yet”，不自动访问 DMS |

## 3. DMS 数据来源（2026-10-01 / 10-02 Claude 本机受控探索）

页面路径：路区画像列表 → Route 行右侧「画像详情」→「路区画像详情」弹窗 →「路区难易度 … 详情 >」→「标签详情」弹窗。

**访问量（SFO01-001，一次完整路径）：** 页面启动约 18 个 `/prod-api/` 请求（含 1 次列表请求）；点「画像详情」+8；点「路区难易度 详情 >」+3；在「标签详情」内滚到底 +0。没有 429 / 5xx。

点「路区难易度 详情 >」后新增的请求（都是 `POST`，前缀 `/prod-api/dlvs-dataApi/roadAreaPortrait/home/roadAreaPortraitDetails/`）：

| 接口 | 请求体 | 返回 |
|---|---|---|
| **`details/getRoadAreaContent`** | `{"roadAreaId": <route_id>}` | `data[]`，一个 ZIP 一条；SFO01-001 一次返回全部 21 条，无分页 |
| `details/getRoadAreaHeader` | `{"roadAreaId": <route_id>}` | `roadAreaName`、`postalCodeNum`、`postalCodeList`（逗号分隔字符串）、`roadAreaDifficulty`、`roadAreaDifficultyCode` |
| `labelDetails/getContent/indicatorWeight` | `{"roadAreaId": <route_id>, "siteHandleType": "ALL"}` | 5 个指标权重（字符串，如 `"20%"`）。第一版不保存 |

- 只需要 `roadAreaId`（= 现有 `route_id`）。页面显示顺序 = 接口返回顺序。
- 百分比：接口为小数，页面 ×100 显示（`0.0047` → 0.47%，`0.5` → 50%，`0` → 0%）。
- ZIP 难易度只有文字，**没有 code**；安全度只有文字（Route 级才有 `safetyLevelCode`）。
- 响应里没有 ZIP id、station、route_id 字段；没有 ZIP 难易度分数。
- 样本中有 4 个 ZIP 的指标全为 null（安全度仍有值），3 个 ZIP 的难易度为 null。

## 4. 架构

沿用 T3 / T6 / T7 的分层，各层新增独立模块，不改动现有 Route Profile 的数据结构：

```text
server/bin/dms-scrape-route-detail.js     CLI：参数、配置、session 检查、调用各层、失败记录
server/src/dms/route-detail-page.js       Playwright：页面操作 + 截获响应（不解析字段）
server/src/transform/route-detail.js      纯函数：DMS 响应 → 标准化 Route Detail
server/src/store/route-details-file.js    route-details.json 读写（原子写，按 route_id upsert）
server/src/api/                           新增 GET /api/route-details
web/route-detail.js                       modal 展示（独立于主表渲染逻辑）
web/format.js                             共用：百分比格式、难易度颜色映射
```

### 4.1 抓取流程（`npm run dms:scrape-route-detail -- --route <route_name>`）

1. 与 T3 相同：用 storageState 打开页面，检查登录；展开 → 转运站点选 SFO01 → 每页 100 条 → 查询，截获列表响应。
2. 在列表响应里按 `roadAreaName` 精确匹配 `--route`，取得 `roadAreaId`；找不到或不唯一 → 停止。
3. 在表格中找到该 Route 的行，点该行「画像详情」；在「路区画像详情」弹窗内只点「路区难易度」旁唯一的「详情 >」。
4. 截获 `getRoadAreaContent`（必须）和 `getRoadAreaHeader`（用于校验），两者请求体的 `roadAreaId` 都必须等于第 2 步的值；header 的 `roadAreaName` 必须等于 `--route`。
5. 关闭浏览器 → transform → 写入 `route-details.json`。

- Station 只取抓取时选择的 SFO01，**不从 Route Name 推断**。第一版只支持 `--station SFO01`（默认值），与 T3 一致。
- 保护措施：列表请求沿用 `MAX_PAGE_LOADS_PER_STATION`（默认 3）；「画像详情」+「标签详情」阶段的 `roadAreaPortraitDetails` 请求上限默认 20（`MAX_ROUTE_DETAIL_REQUESTS`，可配置）；任何 `/prod-api/` 429 / 5xx 立即停止；session 过期立即停止并提示 `npm run dms:login`；不点击任何其他按钮或链接，不做写操作。
- 失败时复用 `last-failure.json`（`writeLastFailure`），不写入 `route-details.json`，保留旧数据。

### 4.2 `route-details.json`

见 `docs/data-schema.md` 第 9 节。

### 4.3 API

`GET /api/route-details?route_id=<数字>`（只读，与 T6 相同的响应头、loopback、无 CORS）：

| 情况 | 响应 |
|---|---|
| 已缓存 | 200 `{ route_id, station, route_name, route_difficulty, fetched_at, zip_count, zips }`（`zips` 不含 `raw`） |
| `route_id` 缺失、重复或不是正整数 | 400 `invalid_route_id` |
| 文件不存在，或文件中没有该 Route | 404 `route_detail_not_found` |
| 文件损坏或结构不合法 | 500 `route_detail_invalid` |

### 4.4 前端

- 主表 Route Name 变成可点击（`<button>` 样式的链接，键盘可操作）。点击后用该行的 `route_id` 请求 `/api/route-details`。
- modal 顶部：Route Name、Route Difficulty（带颜色）、ZIP Count、DSP / Fleet（取自主表已加载的 Route Profile 行）、Last Updated（Route Detail 自己的 `fetched_at`，与 Station snapshot 的时间分开显示）。
- modal ZIP 表格列：ZIP、ZIP Difficulty（带颜色）、First-mile Distance (mi)、熟手 PPH（列名 `Experienced PPH`）、派送异常率（`Delivery Exception Rate`）、`DNR Rate`、`Safety Level`。**按 `postal_code` 升序显示**（Product Owner 2026-10-02：DMS 每次返回的 ZIP 顺序不固定，为了让同一 Route 重新抓取后 UI 顺序稳定）。排序只在前端展示时进行；`route-details.json`、transform、store、API 保持 DMS 原始顺序，不写回缓存。`postal_code` 为 null 或非法的行排在最后，保持相对顺序。不筛选。First-mile 列名旁注明它是 Route 级数值（例如 tooltip 或表下说明 “Route-level first-mile distance, repeated per ZIP”）。
- 格式：数字固定 2 位小数；百分比 ×100、固定 2 位小数加 `%`；空值显示普通 `—`（不加标签）；`postal_code_tag` 第一版不显示。
- 状态：Loading / 成功 / No detail yet（404）/ Error（其他错误、server 不可达）。
- modal 内表格自己滚动，modal 高度不超过视口；Esc、关闭按钮、点击遮罩可关闭；关闭后回到主表，不重新请求主表数据。
- 主表的 Route Difficulty 标签同步使用 R8 的颜色映射。

## 5. 不做

T5 多 Station、Refresh from DMS 按钮、点击时访问 DMS、批量抓取多条 Route、直接调用 DMS 接口、地图、ZIP 点击后的二级详情、搜索 / 高级筛选、UI 大改版、保存指标权重、解释 `postalCodeTag`。

## 6. 验收标准

- **RD-AC1** `npm run dms:scrape-route-detail -- --route SFO01-001` 按第 4.1 节路径运行，只点击规定的控件；请求数受上限保护，429 / 5xx / session 过期时停止；成功后输出 route_id、ZIP 数和请求计数。
- **RD-AC2** `route-details.json` 符合 `docs/data-schema.md` 第 9 节；百分比为原始小数；`postal_code_tag` 为原值；原子写；写入一条 Route 不影响其他 Route；`route-profiles.json` 未被修改。
- **RD-AC3** 校验失败（Route 未找到 / 不唯一、`roadAreaId` 不一致、Route 名不一致、响应结构不合法）时停止，不写入缓存，写入 `last-failure.json`。
- **RD-AC4** `GET /api/route-details` 符合第 4.3 节；现有 API 和静态路由行为不变。
- **RD-AC5** 点击 Route Name 打开 modal，显示第 4.4 节的顶部信息和 ZIP 表；未缓存时显示 “No detail yet”，页面不访问 DMS。
- **RD-AC6** 难易度颜色按 R8，主表和 modal 共用同一个映射函数；显示文字为 DMS 原值；没有难易度计算逻辑。
- **RD-AC7** 百分比 ×100 显示；空值显示 `—`；不从 Route Name 推断 Station。
- **RD-AC8** 分层：Playwright 层不解析字段；transform 为纯函数，有 fixture 单元测试；handler 不直接读文件；modal 逻辑独立于主表行渲染。
- **RD-AC9** `npm test` 全部通过；没有新增依赖；仓库里没有真实 DMS 数据、session 或 runtime 文件。
- **RD-AC10** Product Owner 本机预览签字（`AGENTS.md` 第 9 节）。

## 实现记录（Implementation Notes）

### RD1 — 2026-10-02

- 新增独立的 Route Detail CLI、Playwright capture、纯 transform、文件 store 和 modal 模块。CLI 默认使用 SFO01，严格校验 `--route`；`MAX_ROUTE_DETAIL_REQUESTS` 默认 20，列表仍使用既有配置。复用 T3 的错误类、配置检查及 `writeLastFailure`，未改变 `captureRoutePortrait`。
- 行定位按主体单元格精确文本获取 `rowid`，在固定列对应行中只点击唯一可见的「画像详情」。虚拟滚动和弹窗加载都有有限等待；详情按钮限定在最内层画像弹窗的「路区难易度」区域。列表/详情请求分别计数，429 / 5xx 熔断；401 立即按登录过期停止。两个详情请求体和 header 名称都校验后才进入 transform。
- `route-details.json` 按 Route ID upsert，临时文件 + rename 原子替换；既有文件结构损坏或 rename 失败保留旧数据。API 通过注入 store 只读缓存，明确选择返回字段，ZIP 原始记录不返回；没有读写 Route Profile 缓存。
- 主表 Route Name 改为键盘可操作的按钮；主表系统难易度与 modal 共用 `difficultyTone`。modal 使用原生 dialog 和文本 DOM 渲染；支持关闭按钮、Esc、遮罩关闭、焦点恢复、独立表格滚动，并忽略关闭或重新打开后过期的异步响应。前端只请求本机 API，不触发 DMS 抓取。
- 新增 36 项 RD1 测试，fixture 全部为合成数据。页面 doubles 执行实际选择器回调，覆盖固定列可见性、虚拟滚动、弹窗加载、Route 校验、请求上限、熔断及登录过期；DOM doubles 验证按钮、modal、格式化、安全文本渲染及焦点恢复。临时目录/本地 HTTP server 验证文件和 API。
- `npm.cmd test`：132 项全部通过；项目未配置 lint / build 命令，没有新增依赖。T7 仅调整新增静态模块、Route Name 按钮结构及系统难易度颜色相关断言。
- 未访问真实 DMS，未读取真实 session / runtime 数据，未启动浏览器，未写入凭据，未 commit / push / 部署。RD-AC1 和 RD-AC5 的浏览器部分按 brief 用 doubles 验证；SFO01-001 真实抓取由 Claude 在 Product Owner 本机验证，视觉效果、390px 窄屏和 RD-AC10 预览签字仍待本机完成。

### RD1 第 1 轮修复 — 2026-10-02

- 抽出 `server/src/dms/portrait-page.js`，共用浏览器生命周期、guarded / stop / control、请求计数、熔断、登录检查、列表控件操作、响应截获、错误归一和清理；列表响应及计数通过回调供两个 capture 使用。错误类由原 `route-profile-page.js` 重新导出，现有 import 和 instanceof 保持有效。
- `captureRoutePortrait` 保留原函数参数、默认值、返回字段和计数规则（所有请求计入 requestCount，路径含 `/roadAreaPortrait/` 计入 listRequestCount）；detail 仍只统计 `/roadAreaPortrait/home/frontPage/` 列表请求，另统计详情请求。401 → NeedsLogin 作为选项仅对 detail 启用，T3 行为不变。未改 CLI、store 或 transform。
- 主表系统和人工难易度都用既有 `difficultyTone` 五级映射；空值仍显示普通 `—`，不生成标签。仅扩展 T7 DOM 断言，验证两列五级颜色和未知值；原空值断言保留。
- 画像弹窗轮询从 100 × 50ms 改为 100 × 200ms（约 20 秒）；虚拟表格滚动等待不变，超时仍为 SelectorError。RD1 新增两项测试：共用生命周期的计数、401 选项及监听清理；8 秒延迟成功与 20 秒超时、等待期间无额外点击、成功路径请求计数不增加。
- `npm.cmd test`：134/134 通过；`git diff --check` 通过。`server/test/t3.test.js` 和 `cli.test.js` 未修改，原有测试覆盖返回值、规定操作顺序、响应筛选、登录检查、请求上限、429 / 5xx 熔断、错误归一及 CLI 行为。未新增依赖，项目无 lint / build 命令。
- 本轮仅用合成数据、页面 / DOM doubles 和测试内临时目录、本地 HTTP server 验证；未访问真实 DMS、未读取真实 session / runtime 数据、未启动浏览器、未修改 CLAUDE.md、未 commit / push / 部署。真实页面和视觉预览仍需本机确认，RD-AC10 待 Product Owner 签字。

### RD1 第 2 轮修复 — 2026-10-02

- 根因：画像弹窗先渲染「路区难易度」标签，数据返回后才渲染其「详情 >」。旧逻辑沿祖先向上查找，越过区块到包含「基础属性」和其他四个「详情」的 modal-body，将加载中误判为不唯一；共用 `control()` 又把内部 SelectorError 的具体原因替换为外层阶段名称。
- `clickDifficultyDetail` 在遇到包含「基础属性」的祖先时返回 null，继续等待，不选择其他区块的链接；区块内多于一个详情叶子仍立即报不唯一。保留 100 × 200ms 的约 20 秒上限、超时 `SelectorError('路区画像详情未加载')` 和只点击唯一目标的行为。
- `control()` 原样重新抛出内部 SelectorError；其他控件错误仍转换为当前阶段的 SelectorError，既有熔断 / 请求上限失败优先级不变。
- RD1 新增三项测试，DOM / page doubles 执行真实选择器回调，覆盖真实祖先结构下标签先出现、四个其他详情已就绪、8 秒后自身详情出现并只点击它；区块内两个详情立即失败；始终缺少详情约 20 秒超时且无额外点击；SelectorError 对象及原因保留、其他异常归一。
- `npm.cmd test`：137/137 通过；`git diff --check` 通过。`server/test/t3.test.js`、`server/test/cli.test.js` 未修改且全部通过。未新增依赖，项目无 lint / build 命令，数据结构未变化。
- 未访问真实 DMS、未读取真实 session / runtime 数据、未启动浏览器、未写入凭据、未 commit / push / 部署。RD-AC1 本轮用 doubles 验证，真实 SFO01-001 抓取待 Claude 本机重新验证；RD-AC10 仍待 Product Owner 预览签字。

### 本机真实验证（2026-10-02，Claude 在 Product Owner 本机运行）

- **第 1 轮代码第一次真实运行失败**（`SelectorError：路区难易度详情`），未写缓存，`last-failure.json` 已记录。Claude 把 `clickDifficultyDetail` 源码原样放进只读诊断脚本，在真实页面复现：点「画像详情」后 36ms 就判定为「不唯一」。根因与修复见上方第 2 轮记录。为诊断额外访问 DMS 2 次（其中第 1 次诊断脚本的正则写错，结论作废），每次约 30 个请求，无 429 / 5xx，无写操作。
- **第 2 轮代码：`npm run dms:scrape-route-detail -- --route SFO01-001` 成功。** route_id 831，21 个 ZIP，列表请求 3 个（= 上限），详情请求 10 个（画像详情 7 + 标签详情 3），无 429 / 5xx。
- `route-details.json`：schema_version 1，只有 `"831"` 一条；`zip_count` 21 = `zips.length`；Route 和 ZIP 的 `parse_errors` 都为空。按 `postal_code` 与探索时保存的原始响应逐字段比对：21 个 ZIP 全部一致，`raw` 一致。`route-profiles.json` 未被修改（时间戳仍为 2026-09-30）。
- **发现：DMS 两次返回的 ZIP 顺序不同**（同一数据集，顺序不稳定）。页面按缓存中的顺序显示，因此每次重新抓取后顺序可能变化。
- API：`GET /api/route-details?route_id=831` 返回 21 个 ZIP，不含 `raw`。
- 无界面 Chromium（1440 宽和 390 宽）：主表 Route Name 为按钮；点 SFO01-001 打开 modal，顶部显示 Route Name / Route Difficulty（A级 难，红色）/ ZIP Count 21 / DSP SFO-AAS / Last Updated `2026-10-02 11:24 PDT`；ZIP 表 7 列 21 行，五级颜色正确（易 = 绿、中 = 黄、难 / 极难 = 红），空值为普通 `—`，百分比为 ×100 两位小数（如 66.67%、0.06%）；modal 高度不超过视口，表格在 modal 内滚动，页面无横向滚动；Esc 关闭后焦点回到 SFO01-001 按钮。点 SFO01-002 显示 “No detail yet …”，页面只请求本地 `/api/route-details`，没有访问 DMS。主表 Route Difficulty 也使用同一颜色映射。console 唯一的记录是 SFO01-002 预期的 404 资源日志，没有 JS 错误。

### RD1b — 2026-10-02

- modal 渲染前复制 `data.zips`，按非空字符串 `postal_code` 升序稳定排序；非法 / 空值置后并保留相对顺序，相同 ZIP 保留相对顺序。ZIP 不转为数字，不修改输入数组或对象，不写回缓存；表格无障碍 caption 同步说明升序。
- RD1 DOM doubles 新增乱序、前导零、字符串比较、重复值、null / undefined / 空字符串 / 非字符串和冻结输入验证；既有空值断言按新的显示位置调整。未修改数据层、格式或交互。
- `npm.cmd test`：138/138 通过；`git diff --check` 通过。项目未配置 lint / build 命令。仅使用合成数据和 doubles / 测试内本地 HTTP server，未访问 DMS、真实 session 或 runtime 数据；未运行真实浏览器，视觉预览待 Product Owner 确认。未 commit / push / 部署。

---

## RD2 — 收口：Route Profile 页面中文化 + Route Detail 信息补全（**Approved**，Product Owner 2026-10-02）

范围：只展示已有数据并中文化；不新增 DMS 抓取、不改 API 架构、不改 cache。

- **Route Profile 页面（`/`）中文化**：轻量字符串表（不引入 i18n 框架），`lang="zh-CN"`。标题 “北加州线路画像”；列名：线路名称、DSP、Pickup Volume、PPH、首公里距离 (mi)、线路难度、人工难度；状态 / 错误 / 重试 / 链接等文字改中文。ZIP、DSP、PPH、Pickup Volume、线路 / 站点编号保持原样；不改数据含义。 2026-11-05 起主表列为：线路名称 / DSP / Pickup Volume / PPH / 首票价格 / 首公里距离 (mi) / 线路难度，人工难度仅在线路详情弹窗显示（见 route-quotation spec 7.1）。
- **Route Detail modal 补全**（数据：基础信息来自已加载的 Route Profile 行，ZIP 表来自现有 `/api/route-details`）：
  - 基础信息：线路名称、Route ID、站点、DSP、Pickup Volume、PPH、首公里距离、线路难度、人工难度、ZIP 数、线路数据更新时间（Route Profile snapshot 的 `fetched_at`）、ZIP 详情更新时间（Route Detail 的 `fetched_at`，有详情时显示）。
  - ZIP 表：ZIP、ZIP 难度、首公里距离 (mi)、熟手 PPH、派送异常率、DNR 率、安全等级；百分比沿用现有 ×100 两位小数；缺失值 `—`；按 `postal_code` 升序（只在展示时排序，不改 cache）；不解释 `postalCodeTag`。
  - 没有 Route Detail cache 时：基础信息照常显示，ZIP 区域显示 “该线路暂无详细数据”，并提示可运行 `npm run dms:scrape-route-detail -- --route <线路>` 获取。不报错、不空白。
  - modal 标题和字段中文化；保留 Esc / 关闭按钮 / 点击遮罩关闭、关闭后焦点回到线路名；390 宽时 modal 本身无横向溢出（ZIP 表在 modal 内横向滚动）。
- 验收：SFO01 51 条线路正常；SFO01-001（有详情）显示完整基础信息 + 21 行 ZIP 表；其他线路显示中文 “该线路暂无详细数据”；1440 / 390；`npm test` 通过。

### RD2 实现记录（Implementation Notes，2026-10-02）

- Route Profile 页面、状态及 modal 中文化；轻量 `profileText` 字符串表放在已提供的 `web/format.js`，避免增加 server 静态资源白名单。数字、时间及难度格式化规则保持不变。
- `app.js` 将 snapshot `fetched_at` 传给 modal。基础信息的 12 个字段取自主表行和 snapshot，详情仅提供 ZIP 表、`zip_count` 和详情更新时间；加载、无详情及错误状态保留基础信息。ZIP 数无详情时回退到 `postal_codes.length`，缺失显示 `—`。
- ZIP 表继续排序副本；关闭、Esc、遮罩、焦点恢复及 `sequence` 隔离保持不变。窄屏基础信息为单列，ZIP 表内部横向滚动。
- `npm.cmd test` 244/244 通过；T7 更新中文页面及状态断言，RD1 更新中文 ZIP 表和状态断言并验证完整字段，新增 ZIP 数回退和两种更新时间回归测试。静态检查无 HTML 注入或外部资源 URL，未新增依赖、API 或抓取。
- 临时注入合成数据的本地 server + Playwright Chromium 检查 1440 / 390：modal 无横向溢出（390 时左右边界 12 / 378 px，内部 ZIP 表 980 px / 可视 336 px）；三种关闭方式和焦点恢复、无详情状态及 ZIP 升序通过，无 JavaScript 错误或外部请求。初始临时脚本曾因 PowerShell 编码及按钮名称匹配失败，修正脚本后通过。
- 未读取真实 runtime / session 或访问 DMS；真实 SFO01 数据验证及 Product Owner 预览签字仍由 Claude / Product Owner 完成。

### RD2 本机验证（2026-10-02，Claude）

- Route Profile（`/`）：`lang="zh-CN"`，标题 “北加州线路画像”，表头 `线路名称 / DSP / Pickup Volume / PPH / 首公里距离 (mi) / 线路难度 / 人工难度`，51 行，1440 / 390 无页面横向滚动。
- `SFO01-001`（有详情）：基础信息 12 项（线路名称、Route ID 831、站点、DSP SFO-AAS、Pickup Volume 950、PPH 21.50、首公里距离 24.53、线路难度 A级 难、人工难度 —、ZIP 数 21、线路数据更新时间、ZIP 详情更新时间）；中文 ZIP 表 21 行，按 ZIP 升序（94604 起）。
- `SFO01-002`（无详情）：基础信息照常显示，ZIP 区域显示 “该线路暂无详细数据”；console 中唯一记录是该请求预期的 404 资源日志。
- modal：标题为线路名、关闭按钮 “关闭”；Esc 关闭后焦点回到线路名；390 宽时 modal 宽 366px，无横向溢出。没有外部请求。

---

## RD3 — SFO01 全部 Route 的 Route Detail 受控批量抓取（**Approved**，Product Owner 2026-10-05）

> Product Owner 2026-10-05 决定：设计通过；任意一条 Route 失败都停止整个批次，不记录后继续（RD-Q5）；Route 间隔 4 秒。**真实 DMS 只授权 `--max-routes 3` 试跑**，报告试跑结果后由 Product Owner 另行授权全量。全量完成后再实现 RM5。

> 本节取代 R1 中“不批量预抓全部 Route”、R2“只支持单 Route”以及第 5 节“批量抓取多条 Route”这三项（Product Owner 2026-10-05 要求）。其余决定（R3–R9）不变；单条命令 `dms:scrape-route-detail` 保留。

### RD3-1 目标与范围

- 手动运行**一次**命令，把 SFO01 全部 Route 的 ZIP 详情写入现有 `route-details.json`。之后 Route Profile modal 和 Route Map 只读本地 cache。
- 只支持 SFO01。不并发，不做后台轮询或定时任务，不在点击时访问 DMS，不直接调用 DMS 接口（继续通过页面操作并截获响应）。
- `route-details.json` 的 schema 不变（`docs/data-schema.md` 第 9 节，schema_version 1），只是写入的 Route 变多。

### RD3-2 命令

```text
npm run dms:scrape-route-details -- --station SFO01 [--refresh] [--max-routes N] [--headless]
```

| 参数 | 含义 |
|---|---|
| `--station` | 必填，第一版只接受 `SFO01` |
| `--refresh` | 已有 cache 的 Route 也重新抓取。不传时跳过已缓存的 Route |
| `--max-routes N` | 本次最多**实际抓取** N 条（已跳过的不计入）。用于首次试跑（建议 `--max-routes 3`）；不传时抓取全部 |
| `--headless` | 与现有命令一致 |

### RD3-3 安全流程（一次浏览器会话）

1. 检查配置和 session（与 RD1 相同）；session 文件不存在时提示 `npm run dms:login` 并退出。
2. 读取现有 `route-details.json`（不存在视为空；**结构损坏时直接停止**，不覆盖）。
3. 打开**一个**浏览器，按 T3 流程（展开 → 转运站点 SFO01 → 100 条/页 → 查询）**只加载一次**列表。目标 Route 集合 = 本次列表响应中 `transitStationName === 'SFO01'` 的全部记录（按 `roadAreaName` 排序）。`roadAreaName` 或 `roadAreaId` 重复、不合法时停止。
4. 计算本次要抓的 Route：不传 `--refresh` 时排除 `route-details.json` 中已有该 `route_id` 的 Route；再按 `--max-routes` 截断。开始前打印计划：`目标 51 条；已缓存跳过 1 条；本次抓取 50 条；预计请求约 X 个`。
5. **串行**处理每条 Route：
   1. 在列表中定位该行并点「画像详情」；**确认「路区画像详情」弹窗中的文本包含 `路区名称：<route_name>`**（防止弹窗还在显示上一条 Route 的旧内容），再点「路区难易度 … 详情 >」。复用 RD1 的 `clickPortraitRow` / `clickDifficultyDetail`，不新写选择器逻辑。
   2. 截获 `getRoadAreaContent` 和 `getRoadAreaHeader`，按 RD1 规则校验（请求体 `roadAreaId` 一致、header `roadAreaName` 一致）。
   3. transform 后**立刻**写入这一条（`saveRouteDetail`：原子写，按 `route_id` upsert）。
   4. 关闭「标签详情」和「路区画像详情」两个弹窗，回到列表。**这是新增的页面操作**：只点当前最内层弹窗自己的关闭按钮（必须恰好有 1 个可见的），不按 Esc、不点遮罩，绝不点弹窗内的「反馈记录」「提交反馈」；关闭后必须确认弹窗已消失，否则停止（SelectorError）。关闭弹窗是否会触发请求要在试跑中实测。
   5. 等待间隔 `ROUTE_DETAIL_BATCH_DELAY_MS`（默认 4000，下限 2000，可配置），再处理下一条。
6. 全部完成后关闭浏览器，打印汇总并写运行记录（RD3-6）。

保护措施：

| 条件 | 行为 |
|---|---|
| 任意 `/prod-api/` 返回 429 或 5xx | 立即停止整个批次（CircuitBreakerError），不重试 |
| 401、跳转到登录页、出现密码框 | 立即停止，提示 `npm run dms:login` |
| 列表请求超过 `MAX_PAGE_LOADS_PER_STATION`（默认 3，全程只加载一次列表） | 停止（LoadLimitError） |
| 单条 Route 的 `roadAreaPortraitDetails` 请求超过 `MAX_ROUTE_DETAIL_REQUESTS`（默认 20，**每条 Route 单独计数**） | 停止 |
| 整个批次的 `roadAreaPortraitDetails` 请求超过 `MAX_ROUTE_DETAIL_BATCH_REQUESTS`（新增，默认 700） | 停止 |
| 整个批次的 `/prod-api/` 请求超过 `MAX_ROUTE_DETAIL_BATCH_PROD_API_REQUESTS`（新增，默认 900，兜底） | 停止 |
| 任意一条 Route 校验失败（选择器、`roadAreaId` / 名称不一致、响应结构不合法） | **停止整个批次**（不跳过这条继续抓），以免在页面状态不明时继续点击 |
| Ctrl+C | 立即停止，关闭浏览器；当前这条如果还没写入就不写，已写入的保留（见 RD3-5 的“成功”定义） |

- **不做任何 retry**：任何失败都只停止一次，由人决定是否重新运行。重跑时默认跳过已成功的 Route，相当于断点续抓。
- 只点击 RD1 规定的控件和弹窗关闭控件，不做写操作。

### RD3-4 预计请求量

依据 RD1 真实运行（SFO01-001）：页面启动约 18 个 `/prod-api/`（含列表）；每条 Route 的「画像详情」7–8 个，加「标签详情」3 个，合计约 10–11 个 `roadAreaPortraitDetails`。

| 场景 | 抓取条数 | 预计 `/prod-api/` 总数 | 预计用时（4 s 间隔） |
|---|---|---|---|
| 试跑 `--max-routes 3` | 3 | 约 20 + 33 ≈ **55** | 约 1 分钟 |
| 首次全量（831 已缓存，跳过） | 50 | 约 20 + 550 ≈ **570** | 约 8–10 分钟 |
| `--refresh` 全量 | 51 | 约 **580** | 约 8–10 分钟 |
| 对比：逐条重开浏览器（现有单条命令 × 51） | 51 | 约 51 × 30 ≈ 1500 | — |

关闭弹窗本身预计不产生请求，以试跑实测为准。如果实测每条 Route 超过 15 个请求，先停下来向 Product Owner 汇报，再决定是否全量运行。

### RD3-5 Cache 更新策略

- **“一条 Route 成功”的定义**：两个响应都截获、通过校验、transform 成功，并且 `saveRouteDetail` 写入成功（RD3-3 第 5 步的 i–iii）。写入后关闭弹窗、等待间隔都属于“为下一条做准备”，不影响这条 Route 的数据是否有效。
- 每条 Route 成功后立刻单独写入，不等整批结束。写入**之前**失败或中断：这条不写。写入**之后**（关闭弹窗或等待间隔时）失败或中断：这条保留，记为 `written`，批次停止；运行记录中 `stop_reason` 写明是关闭弹窗失败或中断，`stopped_at_route` 为这条 Route。其他 Route 的旧数据都不受影响。（Claude 2026-10-05 澄清措辞，依据 Product Owner 的“每条成功立即写 cache、中断后保留已成功结果”）
- 默认跳过已缓存的 Route，**不看新旧**（日志里会显示其 `fetched_at`）。需要更新时用 `--refresh`。
- `--refresh` 时只有新数据抓取并校验成功才覆盖；失败时该 Route 的旧数据保留。
- cache 中有、但当前 DMS 列表里没有的 `route_id`：**不删除**，在汇总中列出，由 Product Owner 决定。
- 不修改 `route-profiles.json`。
- 不加文件锁：同一时间只能运行一个抓取命令（批量或单条），文档和启动提示里都写明。两个命令同时运行可能丢失其中一方的写入。

### RD3-6 进度与日志

- 每条 Route 输出一行：`[12/50] SFO01-013  route_id=844  ZIP 18  详情请求 11  ✓ 已写入`。跳过时输出：`[—] SFO01-001 已缓存（2026-10-02 11:24 PDT），跳过`。
- 结束（成功或失败）都打印汇总：目标数、成功、跳过、失败、未处理；`/prod-api/` 总请求数、列表请求数、详情请求数（总数和每条最大值）；总用时；停止原因和停止时所在的 Route。
- 运行记录写入 runtime 目录下的 `route-details-batch-last-run.json`（不进 Git，每次覆盖）：`started_at`、`finished_at`、`station`、`refresh`、`max_routes`、`status`（`completed` / `stopped`）、`stop_reason`、`stopped_at_route`、各项计数、`routes: [{ route_id, route_name, result: 'written' | 'skipped' | 'failed' | 'not_run', zip_count, detail_requests }]`。失败时同时写入现有的 `last-failure.json`。
- 日志不打印 cookie、token、完整 URL 或响应正文（与 T3 一致）。

### RD3-7 失败与中断后的行为

| 情况 | 结果 |
|---|---|
| 第 k 条在写入前失败或被 Ctrl+C 中断 | 前面已写入的 k−1 条保留；第 k 条不写；退出码非 0；汇总和运行记录写明停在哪一条 |
| 第 k 条写入后，关闭弹窗失败或在等待间隔时被中断 | 前 k 条全部保留（第 k 条为 `written`）；批次停止，退出码非 0；运行记录写明原因 |
| 再次运行（不带 `--refresh`） | 自动跳过已写入的 Route，从未完成的继续 |
| 429 / 5xx | 停止，不重试；建议等一段时间（例如 30 分钟以上）再人工重跑 |
| session 失效 | 停止；运行 `npm run dms:login` 后重跑 |
| `route-details.json` 损坏 | 运行前检测到即停止，不覆盖；需要人工处理 |

### RD3-8 分层与文件（建议）

| 文件 | 改动 |
|---|---|
| `server/bin/dms-scrape-route-details.js`（新增） | CLI：参数、配置、session 检查、计划 / 跳过、串行循环、间隔、汇总、运行记录 |
| `server/src/dms/route-detail-page.js` | 把“点画像详情 → 点难易度详情 → 截获 → 校验”抽成按 Route 调用的函数，供单条和批量两种命令共用；新增“关闭两个弹窗并确认消失”。`captureRouteDetail` 的单条行为不变 |
| `server/src/dms/portrait-page.js` | 支持单条 Route 计数（每条单独计、可清零）、批次总上限、`/prod-api/` 总上限；T3 / RD1 默认行为不变 |
| `server/src/config.js` | 新增 `ROUTE_DETAIL_BATCH_DELAY_MS`、`MAX_ROUTE_DETAIL_BATCH_REQUESTS`、`MAX_ROUTE_DETAIL_BATCH_PROD_API_REQUESTS` 的解析和校验 |
| `server/src/store/route-details-file.js` | 新增只读函数列出已缓存的 `route_id`（供跳过判断）；运行记录写入函数（原子写）。`saveRouteDetail` 不变 |
| `package.json` | 新增 script `dms:scrape-route-details`（不新增依赖） |
| `web/format.js` | modal“暂无详细数据”提示改为批量命令 |
| `server/test/route-detail-batch.test.js`（新增） | 按模块组织：跳过 / 刷新 / 上限 / 熔断 / 中断 / 部分写入 / 运行记录 |

### RD3-9 验收标准

- **RD3-AC1** 命令只接受 `--station SFO01`；加载一个浏览器、只加载一次列表；严格串行，每两条之间至少间隔 `ROUTE_DETAIL_BATCH_DELAY_MS`。
- **RD3-AC2** 默认跳过已缓存的 Route，`--refresh` 时重抓；`--max-routes N` 最多实际抓取 N 条。
- **RD3-AC3** 每条成功（RD3-5 定义）后立刻原子写入；第 k 条在写入前失败时，前 k−1 条保留、第 k 条不写；写入后关闭弹窗失败或中断时，前 k 条保留、批次停止；其他 Route 不变；`route-profiles.json` 不变。
- **RD3-AC4** 遇到 429 / 5xx / 401 / 登录页、单条或批次请求超上限、任意校验失败、Ctrl+C 时立即停止，没有 retry；浏览器关闭。
- **RD3-AC5** 进度行、结束汇总、`route-details-batch-last-run.json` 符合 RD3-6；日志中没有敏感信息。
- **RD3-AC6** 单条命令 `dms:scrape-route-detail`、T3 `dms:scrape` 的行为和测试不变。
- **RD3-AC7** `npm test` 全部通过；doubles 覆盖 RD3-AC1–AC5；没有新增依赖；仓库里没有真实数据或 session。
- **RD3-AC8**（本机真实验证，需要 Product Owner 对每次真实运行明确授权）：① 先运行 `--max-routes 3` 试跑（已授权 2026-10-05），报告 3 条是否全部成功、总请求量和每条请求量、两个弹窗关闭是否稳定、有无 429 / 5xx / session 问题、cache 是否正确写入；② Product Owner 确认后全量运行（**未授权**）；③ `route-details.json` 中 SFO01 的 51 条 Route 全部有记录，与 `route-profiles.json` 的 `route_id` 一一对应；④ Route Profile 中任意线路都能直接看到 ZIP 表，页面不访问 DMS；⑤ 汇总中请求数不超过 RD3-4 的估算上限。

### RD3-10 未决问题

见 `docs/open-questions.md`「Route Detail」RD-Q3。RD-Q5 已决定：停止整个批次。

### RD3-11 失败诊断（Product Owner 2026-10-05 批准，第 3 轮修复）

背景：第二次试跑中，SFO01-003 成功、两个弹窗正常关闭，但第 2 条 SFO01-004 点「画像详情」后没有任何请求，约 30 秒后报 SelectorError。日志按设计不记录原始错误，因此无法确认原因（推测是残留遮罩挡住了点击）。Product Owner 批准一轮诊断修复，**不改为每条重新加载列表页**。

- 批量命令的**页面阶段**（列表加载之后的抓取 / 关闭弹窗 / 确认列表 / 等待）失败时，在关闭浏览器**之前**保存诊断信息，写入 runtime 目录（不进 Git，每次覆盖）：
  - `route-details-batch-failure.json`：`at`、`route_name`、`route_id`、`phase`、`error_type`、`step`（SelectorError 的阶段文字）、`message_first_line`（原始错误的**第一行**，去掉 `http(s)://…`，以及任何 `?` / `#` 后的查询串，最多 300 字符）。
  - `route-details-batch-failure.png`：当前视口截图（不截整页）。
- 为此，`control()` 把 SelectorError 包装时**保留原始错误为 `cause`**；诊断信息使用最内层 `cause` 的第一行。
- 不记录 cookie、token、storageState、请求 / 响应正文、完整 URL，以及调用日志（call log）的其他行。
- 熔断 / 登录失效（浏览器已被 `stop()` 关闭）时截图可能无法保存：跳过截图，只写 json，不能因此改变停止行为。截图或 json 写入失败不影响退出码和停止原因，只在 stderr 提示一行。
- 运行记录 `route-details-batch-last-run.json` 增加 `diagnostic`（诊断文件名，或 null）。
- 不新增重试、不改变任何停止条件、不改变请求流程。
- 之后试跑：最多 3 条（已授权）；3 条成功则继续抓当前 DMS 列表中剩余的全部线路（已授权，按当前列表条数，不再对比旧的 51 条）。

### RD3-12 分页处理 + 按钮渲染等待（Product Owner 2026-10-05 批准，第 4 轮修复）

背景：全量批次在第 1 条 SFO01-008 停止，诊断为 `画像详情不唯一`（实际是候选数 ≠ 1），这一条 0 个详情请求。Product Owner 确认：路区画像线路较多时会分页，需要点击底部“下一页”才能看到后面的线路。（Claude 注：失败截图显示 `100条/页`、`共 36 条记录`、只有第 1 页，所以 SFO01 当前在同一页内；这次失败更可能是同一页内滚动后右侧固定操作列还没渲染出按钮。按 Product Owner 要求，分页作为主流程，滚动 / 渲染等待作为兼容处理，两者都实现。）

**分页（主流程）**

- 列表加载后，用列表响应的总数（如 `data.total`）和每页条数（100）计算页数。目标集合 = 所有页的记录；目标数按总数打印，计划阶段的跳过 / 抓取数按已加载页逐页更新。
- **按页面顺序抓取**：当前页需要抓的 Route（未缓存、未超过 `--max-routes`）按该页的**显示顺序**（列表响应 `records` 的顺序）逐条处理，处理完再点底部“下一页”，加载下一页后继续。不再按名称排序，**不会每条 Route 都从第一页重新开始**，也不会回到前面的页。
- 翻页：只点击分页器的“下一页”按钮（必须恰好有 1 个可见且可用的），截获该页的列表响应（同一个 Station 筛选、`pageSize` 100、页码为当前页 + 1），并校验返回记录不为空、与之前各页没有重复的 `roadAreaName` / `roadAreaId`。每次翻页前确认没有打开的弹窗。
- 列表请求上限：批次模式下 = `MAX_PAGE_LOADS_PER_STATION` +（页数 − 1）× 每次翻页允许的列表请求数（实现时按首次加载实测的路径计数确定，写进实现记录），并设绝对上限 10 页；超过即停止（LoadLimitError）。
- 当前页没有需要抓的 Route 时，直接翻到下一页（每次翻页同样受 4 秒间隔约束）。所有页处理完、或达到 `--max-routes` 时结束；**达到 `--max-routes` 后不再翻页**。
- `total` ≤ 100（如 SFO01 当前 36 条）时只有 1 页，不发生翻页，请求量与之前相同。

**按钮定位与渲染等待（兼容处理）**

- 在当前页找到目标 Route 所在行（保留现有的有限滚动查找，用于虚拟滚动）。找到后，将该行滚动到可见区域，然后在该行（同一 `rowid`）的右侧固定操作列中查找可见的「画像详情」按钮：
  - 恰好 1 个 → 点击；
  - 0 个 → 每 200ms 检查一次，最多等待约 5 秒；超时报 `SelectorError('画像详情按钮未渲染')`；
  - 多于 1 个 → 立即报 `SelectorError('画像详情按钮不唯一')`。
- 当前页找不到目标行时报 `SelectorError('Route 行未找到')`（逐页处理时，目标一定属于当前页）。
- 等待只是等待 DOM 渲染，不重复点击、不重发请求、不算重试。

**其他保持不变**：严格串行、4 秒间隔、不并发、不重试、429 / 5xx / session / 校验失败立即停止、每条成功立即写入、已有 cache 自动跳过、诊断文件（RD3-11）。

### RD3-13 「画像详情」行定位修正（Product Owner 2026-10-05 批准；依据 Claude 只读探索）

**探索（2026-10-05，Claude 在 Product Owner 本机，SFO01-008 一条，约 34 个 `/prod-api/` 请求，无 429 / 5xx / 401，无写操作；结果在 runtime 目录 `rd4-exploration/`，不进 Git）结论：**

- vxe 表格的主体（`.vxe-table--main-wrapper`）、左固定列（`.vxe-table--fixed-left-wrapper`）、右固定列（`.vxe-table--fixed-right-wrapper`）分开渲染，同一行在三处的 `tr[rowid]` 相同。主体中的「画像详情」是 `visibility: hidden` 的占位，真正可点的是右固定列中的那一个。
- 表格主体可视高度约 300px（约 4 行）。SFO01-008 是第 5 行（列表响应 index 4），已在 DOM 中，但位于表格可视区下方，被分页栏遮挡：右固定列按钮存在且 `isVisible()` 为真，但点击会落到分页栏上。
- **`rowid` 不是稳定标识**：设置主体滚动位置后虚拟滚动重新渲染，同一行的 `rowid` 从 `row_45` 变为 `row_81`。RD3-12 的实现先取 `rowid`、再滚动、再用旧 `rowid` 找按钮，因此报“按钮未渲染”。
- 设置 `.vxe-table--main-wrapper .vxe-table--body-wrapper` 的 `scrollTop` 后，固定列跟随滚动，按钮可正常点击。

**修正后的定位流程（单条和批量共用）：**

1. 在主体中按 Route Name（单元格文本完全匹配）找到目标行；找不到时按现有方式有限滚动查找（兼容虚拟滚动）。
2. 设置主体 body-wrapper 的 `scrollTop`，使目标行完整位于主体可视区内（例如 `row.offsetTop − 少量边距`）。等待渲染（有限轮询）。
3. **滚动后重新按 Route Name 取 `rowid`**（不复用旧值）。
4. 在**右固定列** body-wrapper 中查找 `rowid` 相同的行：必须恰好 1 行，其中可见的「画像详情」必须恰好 1 个。还需确认按钮中心点位于右固定列 body-wrapper 的可视矩形内，并且 `document.elementFromPoint(中心点)` 命中该按钮（或其子元素）。
5. 满足后点击。0 个按钮或未通过可视 / 命中检查时，每 200ms 轮询一次，最多约 5 秒，超时报 `画像详情按钮未渲染`；多于 1 个报 `画像详情按钮不唯一`，立即停止。
6. 弹窗中仍确认 `路区名称：<route>`（RD3-3）。

分页（RD3-12）保留：当前页没有目标 Route 时才点“下一页”。SFO01 当前 36 条都在第 1 页（`total` 36、`pages` 1）。

### RD3-14 「画像详情」定位 fallback 顺序（Product Owner 2026-10-05 批准）

背景：RD4 验证通过（5 条，包括第 5、6 行）后，全量批次在第 1 条 SFO01-010 失败，报 `画像详情按钮未渲染`。截图显示表格完全没有滚动。区别在于：这次第一条需要滚动的 Route 是在列表刚加载完时处理的；探索时表格带 `is--loading` 类，推测初始布局把设置的 `scrollTop` 重置了，而现有代码只设置一次滚动位置。

Product Owner 要求：目标是只要人工能在当前 DMS 页面打开这条 Route 的详情，程序就尽量通过以下 fallback 抓到。按低风险顺序**逐个**尝试，每次只用一种方法，严格串行，不并发，不无限重试。

**每条 Route 的定位顺序（每一级最多尝试 1 次，每一级都有时间上限；某一级成功就点击并停止往下）：**

| 级 | 方法 | 说明 |
|---|---|---|
| L0 | 等待表格就绪 | 处理每条 Route 前，等待 `.vxe-table` 没有 `is--loading` 类、主体 body-wrapper 可见且有行（200ms 轮询，最多约 10 秒；超时报 `SelectorError('表格未就绪')`）。L0 是前置条件，不算 fallback |
| L1 | 标准滚动 | 设置主体 body-wrapper 的 `scrollTop` 让目标行进入可视区，滚动后重新按 Route Name 取 `rowid`，在右固定列找按钮，并做可视 / 命中检查（RD3-13）。**等待按钮期间，每次轮询先检查目标行是否仍在主体可视区内；被弹回时重新设置 `scrollTop`**（重新定位，不算重新点击）。最多约 5 秒 |
| L2 | 实际滚动容器 | 在该 `.vxe-table` 内查找实际可纵向滚动的可见元素（`scrollHeight > clientHeight` 且 `overflow-y` 为 auto / scroll，包括 vxe 的虚拟滚动条容器，例如类名含 `scroll-y` 的元素）。按目标行在列表中的 index 和行高设置它的 `scrollTop`，然后按 L1 的方式重新取 `rowid` 并检查按钮。最多约 5 秒 |
| L3 | 鼠标滚轮 | 把鼠标移到主体 body-wrapper 中心，用 `page.mouse.wheel` 逐步滚动（每步约一行高，最多约 `index + 2` 步，每步间隔约 150ms），直到目标行进入可视区，然后按 L1 的方式检查按钮。与人工滚动方式相同 |
| L4 | 分页 | 当前页的列表响应中没有该 Route 时，按 RD3-12 点“下一页”（逐页处理时，正常情况下不会走到这一级） |
| L5 | 按名称筛选 | **仅当**查询区中存在标签恰好为 `路区名称` 的筛选输入框时可用：只在该输入框中填入 Route Name，点「查询」，截获列表响应（必须只有这一条 Route 且 `roadAreaId` 一致），然后在第 1 行打开「画像详情」。抓取完成后清空该输入框并重新查询，恢复全量列表（或在下一条 Route 时再筛选）。每次筛选 / 恢复都计入列表请求；批量时列表请求上限相应提高（每用一次 L5 加 2）。**页面上没有“路区名称”筛选框时，这一级不可用，记录 `L5:unavailable`，不要使用其他筛选框代替** |

- 所有级都失败 → 报 `SelectorError('画像详情定位失败')`，批次停止（RD-Q5），同时写诊断文件。
- 在 L1–L3 之间切换不会重新点击任何按钮，只改变滚动位置；同一条 Route 的定位总时间上限约 30 秒。
- **记录**：每条 Route 在日志进度行和运行记录 `routes[]` 中记录 `locate_method`（`L1` / `L2` / `L3` / `L5`）以及失败时尝试过的级（例如 `attempts: ["L1", "L2", "L3", "L5:unavailable"]`）。汇总中统计各方法的使用次数，用来判断哪种方法最稳定。
- 其他规则不变：429 / 5xx / session 失效 / 校验失败立即停止；成功一条立即写入；已有 cache 跳过；4 秒间隔。

### RD3-15 「画像详情」点击稳定性 + 一次有限重试（Product Owner 2026-10-29 批准）

背景：2026-10-29 西雅图片区刷新在 SEA01 的 `SEA01-008`（route_id 857）停止：`capture:SelectorError`，步骤「画像详情」，`locator.click: Timeout 1000ms exceeded`。失败截图显示：表格已加载、没有遮罩或弹窗，SEA01-008 已经滚到主体可视区的第一行，右固定列中的「画像详情」可见。也就是说，预检查（可视矩形和 `elementFromPoint` 命中）已经通过，但 Playwright 在 1 秒内没有完成点击。推测是滚动后虚拟渲染或右固定列同步还没稳定：按钮位置在移动，或者被标记的元素已经被重新渲染替换。日志只记录了错误第一行，无法确认具体原因。与 SC-Q4（SFV01-006）属于同一类问题。

Product Owner 要求：不直接改为“失败就跳过”；先处理定位 / 等待问题；可以增加**一次**有限重试；第二次仍失败时按现有安全规则停止并记录。

修改（单条和批量共用 `clickPortraitRow` / `clickLocatedRow`）：

1. **点击前稳定性检查**：标记按钮后，间隔约 150ms 重新执行同一套检查（重新按 Route Name 取 `rowid`、右固定列唯一按钮、可视矩形、`elementFromPoint` 命中），并且两次按钮中心坐标差 ≤ 1px，才点击。不满足时按现有 L1–L3 的轮询继续等待，不点击，也不计入重试。
2. 点击 timeout 从 1000ms 改为 3000ms。
3. **一次有限重试（每条 Route 最多 1 次）**：点击报错后，观察约 1.5 秒。如果同时满足以下条件，判定这次点击没有到达 DMS，重新从 L0 / L1 开始定位并再点击一次：
   - 从点击前开始，没有任何新的 `/prod-api/` 请求（`prodApiRequestCount` 没有变化）；
   - 页面上没有出现「路区画像详情」/「标签详情」弹窗。

   否则（有请求或有弹窗，即点击可能已经生效），按现有规则立即停止，不重试。
4. 重试仍失败 → 按现有规则抛出 `SelectorError`（步骤「画像详情」），批次停止，写诊断文件。不增加其他重试，也不跳过。
5. **诊断增强**（`station-batch-failure.json` / `route-details-batch-failure.json`）：
   - 增加 `click_retry`（0 / 1）。
   - 增加 `click_wait_reason`：从 Playwright 错误的 call log 中分类得到，取值 `intercepted`（intercepts pointer events）/ `not_stable` / `not_visible` / `detached`（not attached / detached）/ `not_enabled` / `unknown`。只记录分类，不记录原文和 URL。
   - 运行记录 `routes[]` 中，重试过的 Route 记录 `click_retry: 1`。
6. 其他规则不变：429 / 5xx / session 失效 / 校验失败立即停止；请求上限不变（重试的点击仍计入同一条 Route 的上限）；间隔不变。

验收标准：
- RD3-15-AC1：按钮位置在两次检查之间移动时，不点击，继续轮询；稳定后只点击一次。
- RD3-15-AC2：第一次点击超时，且观察期间没有请求、没有弹窗 → 重新定位并点击一次；成功后继续抓取，记录 `click_retry: 1`。
- RD3-15-AC3：第一次点击超时，但观察期间有 `/prod-api/` 请求或出现弹窗 → 立即停止，不重试。
- RD3-15-AC4：重试后仍失败 → 停止，抛出 `SelectorError`，诊断中 `click_retry: 1`，并有 `click_wait_reason`。每条 Route 的点击次数不超过 2。
- RD3-15-AC5：`click_wait_reason` 分类正确，没有原始文本和 URL；现有 RD3 / RD4 / 多站点测试全部通过。
- RD3-15-AC6：真实验证（需要 Product Owner 同意后才访问 DMS）：只对 SEA01 运行必要范围的批次，确认 SEA01-008 能抓取，或者在新的诊断中得到具体的 `click_wait_reason`。

#### RD3-15 实现记录（Implementation Notes，2026-10-29）

- 共用按钮检查返回中心坐标，150ms 后重新按完整 Route Name 获取 rowid，重新验证右固定列行 / 按钮唯一性、可视区域和命中。两次中心的 x、y 差均不超过 1px 才调用 click，timeout 为 3000ms；移动或检查失败仍交回原定位轮询。
- 点击前通过 context.counts 保存 prodApiRequestCount。点击异常后在同一 guarded 安全机制下最多观察 1500ms，期间出现请求或可见画像 / 标签弹窗立即原样抛出；无请求和弹窗时只允许从 L0 重定位一次。弹窗判断提取复用原分页检查；L5 首次点击失败后的列表恢复回调保留，避免重试成功后遗留名称筛选。请求预算、间隔、分页顺序和其他停止规则未改。
- click_wait_reason 只输出六类枚举；失败包装为 SelectorError 后仍保留 click_retry / click_wait_reason。两个批次诊断调用通过 fields 写入有值的字段，路区批次 routes[] 保留重试次数。缓存 / 数据 schema、API、前端和依赖均未修改。
- 新增六项测试：按钮移动后恢复；无请求和弹窗时重试成功及有请求 / 有弹窗 / 观察期间出现请求时禁止重试；第二次点击失败及六类原因；L5 重试后的列表恢复；路区批次运行记录和诊断；多站点诊断。DOM doubles 继续执行实际检查回调。原 doubles 的渲染时钟按 200ms 等待次数驱动，新增 150ms 等待使原 L0、按钮等待、RD4 标签 / tab 和 RD1 弹窗时序断言偏移；现将稳定性 / 观察等待单独记录在 stabilityWaits，保留原断言，并单独验证新等待次数与 3000ms click timeout。
- 定向 `node --test server/test/rd1.test.js server/test/route-detail-batch.test.js server/test/multi-station-batch.test.js`：152/152 通过。最终 `npm.cmd test`：628/629 通过，唯一失败是未修改的 `server/test/boundaries-file.test.js:67`，Census features 期望 4542、实际 5147。本次代码 / 测试文件的 `git diff --check` 通过；全工作区检查发现本任务开始前 RD3-15 spec 第 411 行已有尾随空格，遵守保留要求未改动。无 lint / build scripts。
- AC1–AC5 在 doubles、合成诊断及相关回归范围内通过；AC6 未执行，待后续授权真实验证。未访问 DMS、运行 dms:* / 刷新命令、修改数据库、写入凭据、commit、push 或部署。保留现有 RM12 修改及原 RD3-15 需求 / 验收标准；工作期间新出现的两个 WA geo 文件未作改动。

- RD3-15-AC6 真实验证（2026-10-29，Product Owner 同意后由 Claude 执行）：`dms-scrape-stations --stations SEA01 --new-run`，run `f46835e1-57b2-4421-bee0-9a0f687be801`。SEA01 completed，23 条 Route（新抓 2 条：SEA01-008、SEA01-014；cache 跳过 21 条），完整性检查通过，定位全部是 L1，没有用到重试，没有安全停止。批次共 92 个请求，已恢复原 Station，scrape lock 已释放。SEA01-008 这次第一次点击就成功了，所以无法单独证明是稳定性检查起的作用（原来的失败也可能是偶发的）。如果以后再失败，诊断中的 `click_wait_reason` 会给出具体原因。

---

## RD4 — ZIP 日均领件量 + ZIP 表字段调整（**Approved**，Product Owner 2026-10-05）

### RD4-1 Product Owner 要求

- 在 RD3 抓取中同时抓取每个 ZIP 的**领件量（日均）**，写入 `route-details.json`。
- Route Detail modal 的 ZIP 表格只显示以下字段，顺序为：**ZIP、领件量（日均）、熟手 PPH、ZIP 难度、首公里距离**。
- 不再展示：派送异常率、DNR 率、安全等级。
- 保持：ZIP 升序显示（只在展示时排序）、缺失值显示 `—`、cache 原始顺序不改、不推算、不加无依据的字段解释。
- 先用少量 Route 验证（定位稳定、产能详情能打开、领件量正确、新表格显示正确），通过后继续 SFO01 剩余 Route 的全量抓取。RM5 等 RD3 / RD4 完成后再开始。

### RD4-2 DMS 来源（2026-10-05 探索，SFO01-008）

路径：「画像详情」→「路区画像详情」中「业务属性-产能（日均）」区块的「详情>」→ 弹窗「业务属性（产能）- 详情」→ 「产能（件量）报表」中的「按邮编」。

| 接口（POST，前缀 `/prod-api/dlvs-dataApi/roadAreaPortrait/home/roadAreaPortraitDetails/details/`） | 触发 | 请求体 | 用途 |
|---|---|---|---|
| `businessPropertiesProductionCapacity/header` | 打开产能详情 | `{roadAreaId}` | 校验 `roadAreaName` |
| `businessPropertiesProductionCapacity/details/dayDimension`、`…/taskCouriersReport`、`…/parcelVolumeReport` | 打开产能详情（页面自动请求） | `{roadAreaId}` | 不保存 |
| **`businessPropertiesProductionCapacity/details/postalCodeDimension`** | 点「按邮编」 | `{roadAreaId}` | **`data[]`：`postalCode`、`postalCodeTag`、`receiptQty`（= 页面“领件量日均”）、`deliverySuccessQty`、`deliveryFailQty`、`deliveryDensity`** |

- 样本：SFO01-008 三个 ZIP 的 `receiptQty` 分别为 662 / 132 / 805，合计 1599，等于该 Route 的“领件量（日均）”。
- 页面注明“以上数据为统计时间段的日均值”“邮编变动前的数据不参与统计”“路区画像由近 30 天的数据生成”。统计窗口与 RD-Q4 相同，仍未确认。
- 每条 Route 新增约 5 个详情请求（产能详情 4 个 + 按邮编 1 个），合计约 15–17 个 `roadAreaPortraitDetails` 请求。

### RD4-3 抓取流程变化（单条和批量共用）

在 RD3-3 第 5 步中，「标签详情」截获并校验之后：

1. 关闭「标签详情」，回到「路区画像详情」（同 RD3 的关闭规则）。
2. 在「路区画像详情」中，找到上下文文本以 `业务属性-产能` 开头的区块，点击该区块中唯一可见的「详情>」（与 `clickDifficultyDetail` 相同的“最小区块内唯一链接”规则；不唯一或缺失时报 SelectorError）。
3. 等待标题为 `业务属性（产能）- 详情` 的弹窗出现，并确认其中有 `路区名称：<route>`（规则同 RD3-3）。截获 `…/businessPropertiesProductionCapacity/header`，校验请求体 `roadAreaId` 和 `roadAreaName`。
4. 在该弹窗中点击唯一可见的「按邮编」，截获 `postalCodeDimension`，校验请求体 `roadAreaId`。
5. transform 后**一次写入**该 Route（难度详情和领件量一起写，不分两次写）。
6. 依次关闭「业务属性（产能）- 详情」和「路区画像详情」，确认列表可见，然后等待间隔。

单条 Route 的详情请求上限 `MAX_ROUTE_DETAIL_REQUESTS` 默认值从 20 调为 **30**；批次上限 `MAX_ROUTE_DETAIL_BATCH_REQUESTS` 从 700 调为 **800**，`MAX_ROUTE_DETAIL_BATCH_PROD_API_REQUESTS` 从 900 调为 **1000**。其他安全规则不变。

### RD4-4 数据（`route-details.json`，schema_version 仍为 1）

- ZIP 级新增字段 **`pickup_volume_daily`**：number | null，来自 `postalCodeDimension.data[].receiptQty`，按 `postalCode` 字符串精确匹配合并到难度详情的 ZIP 行。原值保存，不计算、不取整。
- 产能列表中没有的 ZIP：`pickup_volume_daily` 为 null，并在该 ZIP 的 `parse_errors` 中记录 `{ field: 'pickup_volume_daily' }`。产能列表中有、但难度详情中没有的 ZIP：不新增 ZIP 行，在 Route 级 `parse_errors` 中记录 `{ field: 'capacity_postal_code_extra', value: <postalCode> }`。
- Route 级新增 `capacity_raw`（`postalCodeDimension` 的 `data` 原始数组，调试用，API 不返回）。
- 派送异常率 / DNR 率 / 安全等级相关字段（`delivery_fail_rate`、`dnr_rate`、`safety_level`）继续按原样保存在 cache 中，不删除、不迁移（Product Owner 只要求不展示、不再作为核心字段）。
- 旧记录（没有 `pickup_volume_daily`）仍然可读：store 校验时把该字段视为可选；API 返回时缺失为 null。
- **跳过规则调整**：批量命令不带 `--refresh` 时，只跳过“已缓存**且**每个 ZIP 都有 `pickup_volume_daily` 这个键（值可以为 null）”的 Route。RD4 之前抓取的 7 条会因此自动重抓，不需要 `--refresh`。

### RD4-5 API / 前端

- `GET /api/route-details` 的 `zips[]` 增加 `pickup_volume_daily`，其他字段不变（兼容）。
- Route Detail modal ZIP 表列：`ZIP`、`领件量（日均）`、`熟手 PPH`、`ZIP 难度`、`首公里距离 (mi)`。领件量按整数显示（原值为整数；如果出现小数，最多保留 2 位，不取整），熟手 PPH 保留 2 位小数。删除派送异常率、DNR 率、安全等级三列。首公里为线路级数值的说明保留。ZIP 难度颜色维持现状（五色统一属于 RM5）。

### RD4-6 预计请求量

每条约 15–17 个详情请求，加启动约 20 个。SFO01 当前 36 条全部需要抓（7 条旧记录缺领件量，自动重抓）：约 20 + 36 × 17 ≈ **630** 个 `/prod-api/`，用时约 12–15 分钟。小规模验证（`--max-routes 3`）约 70 个。

### RD4-7 验收标准

- **RD4-AC1** 「画像详情」按 RD3-13 定位：滚动后重新取 `rowid`，在右固定列点击，并通过可视和命中检查；表格中第 5 行及以后的线路（如 SFO01-008）可以稳定打开。
- **RD4-AC2** 产能详情和「按邮编」只点击规定控件；`header` / `postalCodeDimension` 的 `roadAreaId` 和名称校验失败时停止，不写入。
- **RD4-AC3** `pickup_volume_daily` 按 RD4-4 合并；缺失和多出的 ZIP 按规则记录；一条 Route 只写一次；旧记录仍可读；跳过规则按 RD4-4。
- **RD4-AC4** API 返回 `pickup_volume_daily`；modal ZIP 表恰好为 5 列，顺序正确，ZIP 升序显示，缺失值为 `—`，不显示已删除的三列。
- **RD4-AC5** 请求上限按 RD4-3 调整，其他 RD3 安全规则和测试不变；`npm test` 和 `git diff --check` 通过；没有新增依赖。
- **RD4-AC6**（本机真实验证）`--max-routes 3` 验证定位、产能详情、领件量（与页面“按邮编”一致，合计与线路日均领件量一致）、新表格显示；通过后全量运行，SFO01 当前 36 条全部有包含领件量的详情。

### RD3 实现记录（Implementation Notes）

- 2026-10-05：新增 `dms:scrape-route-details` CLI 和可注入的 `runRouteDetailsBatch`。必填 SFO01，严格校验重复 / 未知参数；缓存结构在打开浏览器前验证。单会话、单次列表查询，校验完整目标集合后按名称排序、默认跳过缓存、refresh 重抓、max-routes 只限制实际抓取；串行逐条写入后关闭两层弹窗，只有两条之间等待配置间隔。启动提示同一时间只能运行一个抓取命令。
- 打开浏览器前尚无当前 DMS 列表，计划明确显示目标 / 跳过数待确认；有 max-routes 时显示预计请求上界，无限制时显示 `20 + 11 × 条数` 公式。列表加载后输出准确目标、跳过、本次抓取数及请求估算。缓存缺席 ID 仅报告，不删除。
- 抽取 `captureRouteDetailOnPage` 供单条和批量共用，保留单条参数和返回值；新增有限名称确认，防止旧弹窗内容。关闭仅定位标题匹配的可见最内层 modal-content 自有唯一关闭按钮，先标签再画像，约 10 秒内确认消失，之后确认列表可见；不点击反馈、遮罩或 Esc。
- `withPortraitPage` 新增批次选项：每条重置详情计数，批次详情和 prod-api 总上限；保留 T3 / RD1 默认计数规则。429 / 5xx / 401、主框架登录跳转、密码框出现、SIGINT 立即停止并关闭浏览器；间隔等待受 guarded 保护，无 retry。新增三个配置严格校验，默认间隔 4000 ms，下限 2000 ms。
- 逐条 transform 后原子 upsert；原子 rename 前再次检查中断和会话失败，未提交的临时文件被清理。写入后关闭 / 间隔失败仍记 written，已提交数据保留。运行记录使用原子写，失败同时调用 writeLastFailure；日志只报告已校验的名称、ID、计数和错误类型，不输出 URL、响应正文或原始错误。cache schema、API、地图和 Route Profile 数据读写均未改变，无新增依赖。
- 暂无详情提示改为批量命令，使用行的 station，缺失回退 SFO01。RD1 仅调整提示断言和共用函数所需的 page double：补充路区名称节点；拆分名称 / 难度加载计数，保留原加载时长断言。`t3.test.js` / `cli.test.js` 未修改。
- 新增 `server/test/route-detail-batch.test.js`，在 index 注册，共 22 项：参数 / 配置、单会话串行顺序、skip / refresh / max-routes、损坏缓存预检、写入前后失败、四种请求上限、429 / 5xx / 401、登录跳转和动态密码框、SIGINT、原子提交前取消、实际文件部分写入及旧数据保留、运行记录失败、真实选择器回调的名称轮询 / 安全关闭。RD1 共用捕获测试继续覆盖请求 ID / header 名称校验。
- 最终 `npm.cmd test`：266/266 通过；`git diff --check` 通过。项目未配置 lint / build。首轮一个 RD1 double 因新增名称检查推进了难度加载计数而失败，拆分计数后原断言通过；本机 Python 别名不可执行，未用于修改文件。
- 验收映射：RD3-AC1 → arguments / one browser / serial / delay；AC2 → skip / refresh / max-routes；AC3 → pre-write versus post-write / store atomic upserts / interruption before rename；AC4 → ceilings / HTTP errors / login detection / SIGINT / actual selector；AC5 → record fields / summaries / sanitized logs / runtime record failure；AC6 → 原 T3、CLI、RD1 回归测试；AC7 → 全套 266 项。AC1–AC7 通过 doubles / 合成文件验证，AC8 未执行，按 brief 留给 Claude / Product Owner 本机真实验证及预览签字。
- 未访问真实 DMS、未启动真实浏览器、未读取真实 session 或 runtime 数据、未写入凭据，未 commit / push / 部署。保留任务开始前工作区已有的文档和 .gitignore 修改；本次仅在本 spec 追加实现记录，不修改需求或验收标准。

- **RD3 第 1 轮修复（2026-10-05）**：`confirmPortraitRoute` 接受以 `路区名称：` 开头、冒号后可有空白、完整 Route Name 后为文本结束或非 `[A-Za-z0-9._-]` 字符的文本；支持紧跟状态标签以及 label / name / tag 拆分节点的父元素，避免将 `MOCK-0010` 误匹配为 `MOCK-001`。弹窗不唯一立即失败、名称缺失有限轮询约 20 秒后超时的行为不变。batch DOM doubles 新增同元素状态标签、拆分节点、较长名称超时（覆盖六类名称字符）、旧名称带标签延迟更新四项测试；未修改 RD1 / T3 / CLI 测试。`npm.cmd test` 最终 270/270 通过，`git diff --check` 通过；首次新增超时断言遗漏 SelectorError 固定前缀，修正断言后复跑通过。未新增依赖，项目无 lint / build 命令；数据与 schema 不变。未访问 DMS、启动真实浏览器、读取真实 session / runtime、写入凭据或 commit / push / 部署；RD3-AC8 仍待本机真实验证。

- **RD3 第 2 轮修复（2026-10-05）**：关闭两层弹窗后的列表确认改用 `evaluateAll` 和 `getClientRects().length` 可见过滤，与 `clickPortraitRow` 共用 `inspectVisibleTableBody`，保留原有滚动逻辑。恰好 1 个可见列表通过；0 个可见时最多等待 50 次、每次 200 ms，超时报 `SelectorError('列表不可见')`；多个可见列表立即报 `SelectorError('列表不唯一')`。确认流程置于 `control('确认列表', …)` 内，意外异常归一为该阶段的 SelectorError。检查 `closeRouteDetailModals` / `confirmPortraitRoute`：除唯一打标的关闭按钮 `click()` 外，均使用多元素安全的 `evaluateAll`，没有其他单元素 locator 调用。
- 第 2 轮 DOM double 模拟 3 个表格匹配，并让单元素方法在匹配不唯一时抛 strict mode 错误。新增 3 项测试覆盖仅 1 个可见、0 个可见超时、2 个可见立即停止、列表延迟出现，以及意外列表检查异常归一；验证名称确认和关闭流程仅对唯一打标的关闭按钮调用单元素方法。`npm.cmd test`（Windows 下的 npm test）：273/273 通过；`git diff --check` 通过（仅有既存 LF/CRLF 提示）。未配置 lint / build，未新增依赖或修改数据 / schema；未修改 RD1 / T3 / CLI 测试。RD3-AC1–AC7 的 doubles / 合成文件回归通过，RD3-AC4 补充上述选择器停止覆盖；RD3-AC8 尚待 Claude / Product Owner 本机重新试跑，本轮未访问 DMS、启动真实浏览器、读取真实 session / runtime、写入凭据或 commit / push / 部署。

- **RD3 第 3 轮（诊断，2026-10-05）**：`SelectorError` 接受 Error options，`control()` 包装意外控件错误时保留 `cause`，已有 SelectorError 原样抛出，错误类型和消息不变。`withPortraitPage` 仅在 batch 且列表加载后的失败路径调用可选 `onPageFailure`，在 finally 关闭浏览器前执行，回调默认最多等待 5 秒；已被 stop 关闭的浏览器仍按既有停止行为处理。
- batch 仅对 capture / close_modals（含确认列表）/ delay 阶段保存诊断；JSON 复用原子写函数，截图为当前视口且 timeout 4000 ms，路径使用 runtime 目录与固定 basename。整个诊断最多等待 4500 ms，超时或文件操作失败只向 stderr 输出一行固定提示，不替换原错误、停止原因或退出码。JSON 消息沿 cause 到最内层，防循环，只保留第一行，删除 HTTP(S) URL、截去问号或井号后内容，并限制为 300 字符。运行记录新增 diagnostic 对象（JSON basename、截图 basename 或 null）；无诊断时为 null，汇总仅显示文件名。
- 新增 6 项诊断测试，覆盖 cause 与原 SelectorError 保留、URL / 查询串 / 多行 / 长度清理、临时 runtime 原子覆盖、截图先于关闭、熔断后截图失败但 JSON 保存、mkdir / writeFile / rename 失败不改变结果、成功和非页面阶段无诊断、回调异常与有限超时。既有 RD1 / T3 / CLI 测试及断言未修改。
- `npm.cmd test`：279/279 通过；`git diff --check` 通过（既存 LF/CRLF 提示）。无 lint / build scripts，无新增依赖，数据与 cache schema 不变。本轮仅修改 batch CLI、portrait-page、batch 测试和本实现记录；保留任务开始前工作区已有修改。RD3-AC1–AC7 由 doubles / 合成文件回归验证；RD3-AC8 真实试跑和预览仍待 Claude / Product Owner 本机完成，本轮按 brief 未访问 DMS、未启动真实浏览器、未读取真实 session 或 runtime、未写入凭据，未 commit / push / 部署。

#### RD3 第 4 轮（分页 + 按钮渲染等待）— 2026-10-05

- 首页 fixture 和 T3 transform 确认总数字段为 `data.total`；既有 DMS 接口说明确认请求页码为 `pageNum`，响应页码与每页条数为 `data.current` / `data.size`。批量按 `ceil(total / 100)` 逐页处理；超过 10 页立即 LoadLimitError。只首次查询，随后只点唯一可见且可用的 `.vxe-pager--next-btn`；翻页前确认没有可见画像 / 标签弹窗，校验 Station 筛选数组与首次查询完全一致、pageSize 100、请求及响应页码递增。空页、跨页重复名称或 ID 立即停止。
- 每页保留 `records` 顺序；本页处理完再翻页，缓存跳过、refresh、串行、逐条原子写和无 retry 保持原有规则。翻页前沿用配置间隔（默认 4000 ms），达到 max-routes 后不翻页。目标按 total 打印，计划逐页更新。`routes` 只包含已接受加载页的 Route，按页面处理顺序保存；运行记录新增 `total` 和 `pages_loaded`。未访问所有页时，无法确定缓存 ID 是否不在完整列表，因此不报告这些 ID 为缺席。
- 列表请求上限为 `MAX_PAGE_LOADS_PER_STATION + (页数 - 1) × 1`。依据现有代码路径和 doubles：每次下一页只执行一次 click，产生一个 pagination 请求，计入 `/roadAreaPortrait/home/frontPage/` 一次；不会重新设置筛选或每页条数。真实 DMS 请求数本轮未实测，若另有列表请求仍由该上限停止，不自动重试。首次加载预算不变；total 36 的测试仍为原来的一个列表请求。
- 单条和批量共用行定位：找到 rowid 后先 scrollIntoView，再仅检查同 rowid 的可见按钮。一个立即点击；零个每 200 ms 轮询，最多 25 次等待（5000 ms）；多个立即停止。原错误 `画像详情不唯一` 分为 `画像详情按钮未渲染` 和 `画像详情按钮不唯一`，SelectorError 固定前缀不变；Route 行未找到和有限虚拟滚动规则不变。RD1 原有错误消息断言未调整，新增断言逐项验证这两个具体消息；double 补充滚动方法并验证先滚动再点击。
- 新增 6 项测试覆盖按钮立即 / 延迟 / 超时 / 重复、页面顺序、total 36 / 150、缓存整页跳过、跨页 max-routes、下一页缺失 / 重复 / 禁用、残留弹窗、空页 / 重复名称 / 重复 ID、筛选 / 页码 / 条数校验、累计列表上限、10 页边界及永不回到第一页。首次新增测试中 double 将下一页参数误用于首次查询，修正为只影响后续页后通过。
- 最终 `npm.cmd test`：285/285 通过（包含 T3 / CLI / RD1 / batch 回归）；`git diff --check` 通过，仅既存 LF/CRLF 提示。无 lint / build scripts，无新增依赖；cache、API、前端和数据 schema 未改。RD3-AC1–AC7 在 RD3-12 扩展范围内通过 doubles 验证；RD3-AC8 真实 DMS 验证和预览签字未执行。未访问 DMS、启动真实浏览器、读取真实 session / runtime、写入凭据、commit、push 或部署；保留本轮开始前已有改动。

### RD3-13 实现记录（Implementation Notes，2026-10-05）

- 共用行定位设置主体 `.vxe-table--body-wrapper` 的 `scrollTop`，按目标行相对主体可视区的位置留 8px 边距；滚动后每次轮询重新按 Route Name 精确读取 `rowid`。只在右固定列 body-wrapper 内检查同 ID 的唯一行和唯一可见按钮，不选主体隐藏副本。
- 按钮中心必须在固定列 body-wrapper 矩形内，且 `elementFromPoint` 命中按钮或其子节点，才标记并点击。零候选或未通过几何 / 命中检查每 200ms 等待，累计最多 5000ms；重复行或按钮立即报“画像详情按钮不唯一”。保留既有分页、有限虚拟滚动查找及停止规则。
- DOM doubles 执行实际回调，覆盖目标在第五行、滚动重建 rowid、主体隐藏副本、分页栏区域遮挡、命中失败后恢复 / 超时及按钮重复。真实 DMS 稳定性仍待 RD4-AC6 本机验证。

### RD3-14 实现记录（Implementation Notes，2026-10-05）

- 共用画像定位拆为 L0 / L1 / L2 / L3 / L5，L4 继续由既有逐页批量流程负责。L0 每 200ms 检查真实 `.vxe-table` 的 loading 状态、可见主体和已渲染行，最多 10 秒；L1 / L2 各最多约 5 秒；L3 每步实测一行高、间隔 150ms，最多 index + 2 步，并设 10 秒阶段边界。定位共享约 30 秒 deadline；L5 查询和按钮定位使用剩余预算。按钮实际点击失败立即停止，避免已经送达页面的点击被 fallback 重复执行。
- L1 每次轮询重新检查主体目标行是否完整可见，被布局弹回时重新设置主体 scrollTop。L2 在主体所属表格内筛选可见、overflow-y 为 auto / scroll、scrollHeight 大于 clientHeight 的容器，使用列表 index × 已渲染行实测高度定位。L3 移动鼠标到主体中心后逐步滚轮。所有方法重新按完整 Route Name 读取 rowid，沿用右固定列唯一性、可视矩形和 elementFromPoint 命中检查；Route 行或按钮重复立即停止。
- L5 只使用标签文本恰好为“路区名称”的可见 form-item 内唯一可见 input，不替代其他筛选控件。过滤响应要求 records 恰好一条、total 为 1、ID / 名称一致；每次 L5 为列表预算增加 2，过滤和恢复均由原请求监听计数。批量保持成功即写入，随后关闭弹窗、清空输入并查询恢复；单条在会话关闭前恢复列表。单条关闭 / 恢复的 SelectorError 作为 restorationError 返回，让已校验详情仍沿原路径写入后停止；安全失败仍立即停止。
- 返回 locateMethod / attempts；批量进度行和 routes[] 新增 locate_method / attempts，运行记录新增 locate_method_counts，并输出各方法汇总。失败保留已经尝试的级及 L5:unavailable；后续详情校验或关闭失败也保留定位方法。单条成功日志新增 locate_method。缓存、数据 schema、API、前端、分页主流程、间隔、跳过规则及产能流程未修改。
- 新增 8 项测试，DOM / page doubles 模拟主体、右固定列、虚拟滚动容器、动态 rowid 和 is--loading。覆盖 2 秒 loading 消退 / 10 秒超时、布局重置、L2 / L3 成功、约 30 秒总 deadline、按钮最多点击一次、重复立即停止、精确筛选标签、单条 ID / 名称 / 数量校验、列表请求预算 +2 及超限、写入后恢复、失败诊断和方法统计。原超时断言按 RD3-14 改为最终“画像详情定位失败”。
- `npm.cmd test`（Windows 下的 npm test）310/310 通过；`git diff --check` 通过，仅已有 LF/CRLF 提示。无 lint / build scripts，无新增依赖。REQUIREMENTS.md 当前不存在，未编造其内容；按本 brief 和 approved RD3-14 实施。保留任务开始前已有改动；本轮仅改共用定位 / 列表查询、两个 CLI、两个测试文件和本实现记录，不改需求和验收标准。未访问 DMS、启动真实浏览器、读取真实 session / runtime、写入凭据、commit、push 或部署；真实 DMS 稳定性和页面预览仍待本机验证。

### RD4 实现记录（Implementation Notes，2026-10-05）

- 难度与产能详情共用最小区块唯一链接选择函数；复用按标题确认 Route Name 和关闭单个弹窗的逻辑。关闭标签详情后捕获产能 header，再点击产能弹窗内唯一“按邮编”捕获 postalCodeDimension；监听在点击前安装。校验两次请求 ID、header 名称和产能弹窗精确标题 / Route Name，失败时单条和批量均不写入。批量最终关闭顺序为产能详情 → 画像详情 → 确认列表。
- transform 以字符串 ZIP 精确合并 `receiptQty`，不改变原值或 ZIP 顺序；缺失 ZIP 写 null 和 ZIP 级错误，多出 ZIP 仅写 Route 级错误；原数组保存为 `capacity_raw`。store 的新增字段可选，旧记录可读，API 缺失领件量返回 null，明确排除 `capacity_raw`。兼容既有难度 transform 输入；生产共用 capture 始终返回产能响应，批量仍一次原子 upsert 完整 Route。
- `listCachedRouteIds` 保持 Set 返回接口，以非枚举 `missingPickup` Set 提供原始缓存中缺少字段键的 Route ID；批量只跳过完整记录，值为 null 也算完整。计划日志单列本页实际待抓取中“缺领件量重抓 N 条”；预计请求按 `20 + 17 × 条数`，默认请求上限为单条 30 / 批次详情 800 / 批次 prod-api 1000。
- modal ZIP 表改为 ZIP、领件量（日均）、熟手 PPH、ZIP 难度、首公里距离 (mi) 五列；领件量最多两位小数，PPH 固定两位。保留排序副本、普通缺失符号、caption、首公里说明及既有样式；旧异常率 / DNR / 安全字段仍存储和通过 API 兼容返回，但不再展示。
- 最终 `npm.cmd test`（Windows 下的 npm test）：291/291 通过；`git diff --check` 通过，仅已有 LF/CRLF 提示。新增 6 项测试并扩展已有 doubles，覆盖 RD4-AC1–AC5，包括校验失败零写入、部分旧缓存重抓、null 可跳过、每条 17 请求及一次写入；T3 / CLI / 中断 / 熔断 / 分页 / 本地 HTTP API / modal 状态回归通过。未配置 lint / build scripts，无新增依赖，schema_version 保持 1。
- RD4-AC1–AC5 在合成 fixtures、DOM / page doubles、临时目录和测试内本地 HTTP server 范围内通过；RD4-AC6 未执行，真实抓取、浏览器视觉和 console 检查及 Product Owner 预览签字待本机完成。遵守 brief，未访问 DMS、启动真实浏览器、读取真实 session / runtime、写入凭据、commit、push 或部署；保留任务开始前已有改动。

### RD4 第 1 轮修复（Implementation Notes，2026-10-05）

- 按本轮审查要求，在打开产能详情前同时安装 header / postalCodeDimension 监听，明确 30000ms 上限；两个监听只匹配 POST 且请求体 `roadAreaId` 等于当前 Route 的响应，其他 Route 的旧响应忽略。保留响应名称校验、失败零写入和现有诊断 cause 链。
- 产能弹窗标题 / Route Name 确认后，在该弹窗内唯一定位“按日期 / 按邮编”，通过标签及其祖先的 checked / active 类或 input.checked 判断选中状态。两个状态相同或控件不唯一时，报 `SelectorError('按邮编')`，不猜测。按日期选中时点击按邮编；按邮编选中时最多等待约 5 秒使用自动响应，未收到则按日期 → 按邮编各点击一次，继续等待原监听，不新增重试。
- 校验产能响应后、返回结果及关闭产能弹窗前，点击一次按日期恢复默认状态，不等待其响应。恢复操作产生的请求仍由既有统一计数器计入当前 Route；请求上限和其他 RD3 安全规则未改。
- 新增 6 项 DOM / page doubles 测试，模拟 antd radio-button 的 `-checked` 类和点击时响应，覆盖首次打开、记忆邮编且自动响应、记忆邮编但无响应、旧 Route 响应忽略、无法判断状态、超时 cause、恢复顺序 / 请求计数 / 上限。三个成功分支在合成计数 fixture 中分别为 17 / 17 / 18 个详情请求，均低于默认 30；超限停止测试通过。
- `npm.cmd test`（Windows 下的 npm test）297/297 通过；定向 `node --test server/test/rd1.test.js` 54/54 通过；`git diff --check` 通过，仅既有 LF/CRLF 提示。无 lint / build scripts，无新增依赖、数据或 schema 改动。RD4-AC1–AC5 回归通过，AC2 的本轮修复由 doubles 验证；RD4-AC6 仍待本机真实验证。本轮未访问 DMS、启动真实浏览器、读取真实 session / runtime、写入凭据、commit、push 或部署；保留开始前已有改动。

### RD4 ? 2 ????Implementation Notes?2026-10-05?

- ??????????? DOM?????????? closest('label.dbuMicroSysApp-radio-button-wrapper') ???? label??? label ????????????????? .dbuMicroSysApp-radio-group????????? label ? dbuMicroSysApp-radio-button-wrapper-checked ?????? input.checked????????????????????
- ?????????? 200ms ??????? 50 ????10000ms????? SelectorError('???????')??????????????? cause ?????????????? label??????????????????????????????????????????????????????????????5 ?????????????????????????????
- ????????????? SelectorError ?? capture ???? restorationError ????????????? transform / ??????????????? close_modals ??????? Route ?? written???? not_run????????? cache ? API??????????????????????????????????????
- ?? server/src/dms/route-detail-page.js?server/bin/dms-scrape-route-detail.js?server/bin/dms-scrape-route-details.js?server/test/rd1.test.js ???????????????????double ?? radio-group > ?? label > input / span??? label ???? checked ?? checked input??????????????? 5 ????????????? class / ? input?2 ???????????????? / ??????? group / ?? label???????? / ???????????????????????? Route?
- ?? node --test server/test/rd1.test.js?59/59 ???npm.cmd test?Windows ?? npm test??302/302 ???git diff --check ?????? LF/CRLF ????? lint / build scripts?????????? / schema / ?? / ???????Python ??????????? Node ???????????????? index ???????????????????
- RD4-AC1?AC3?AC4?AC5 ??????????AC2 ?? label ????????????? DOM / page doubles ???AC6 ?????? Claude / Product Owner ?????????? DMS????????????? session / runtime??????commit?push ????
