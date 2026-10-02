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
| R8 | 难易度颜色（Route 主表和 modal 共用）：`D级 极易` / `C级 易` → 绿；`B级 中` → 黄；`A级 难` / `S级 极难` → 红；null 或其他未知值 → 灰。显示文字仍是 DMS 原值，不改名 |
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
