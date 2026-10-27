# District（片区）层级 — Spec

- Status: **Approved**（Product Owner 2026-10-06 提出需求并授权实现；标注“Claude 设计”的条目是实现细节，Product Owner 可调整）
- 更新：2026-10-06
- 相关：`docs/features/multi-station.md`（第 11 / 11.1 节，Station 顺序与记忆）、`docs/features/route-map.md`（RM5 / RM5b）、`docs/features/route-detail.md`

---

## 1. 目标

把多站点结构升级为 **District → Station → Route → ZIP**：

- 线路画像页面改名为 **美西线路画像 / West Region Route Profile**。
- District 由配置文件定义，新增片区主要改配置，不改页面逻辑。
- Route Profile 和 Map 都使用“片区 → 站点”两级筛选。
- 地图支持“片区总览”和“片区内站点细看”两种状态，Route 颜色含义不变。
- 两个页面共用“上一次的 District + Station”。

## 2. Product Owner 要求（2026-10-06）

| # | 要求 |
|---|---|
| D1 | 页面标题：中文“美西线路画像”，英文“West Region Route Profile” |
| D2 | District 用可扩展配置定义，不写死在 UI 逻辑中。当前只有 **North Cal District / 北加州片区** |
| D3 | 北加州片区的 Station 及其**固定顺序**：SFO01 → OAR01 → SMF01 → SCK01 → RNO01 → RDG01 → RDG02 → MOD01 → MFR01 → SFO02（2026-10-26 经 Product Owner 授权追加 SFO02；Route Profile 和 Map 一致，不按字母排序；见 `sfo02-station.md`） |
| D4 | Route Profile 顶部改为“片区 → 站点”两级。Station 下拉框只显示当前片区的 Station |
| D5 | District 配置只决定 Station 属于哪个片区；Station 有哪些 active Route 仍以 DMS 当前列表（snapshot）为准 |
| D6 | 地图选择片区 → 同时显示该片区所有 Station 的 Route，每条 Route 保持自己的 route color；片区只决定显示范围，不是给整个片区一个统一颜色 |
| D7 | 地图在片区下再选择 Station → 当前 Station 的 Route 重点显示，同片区其他 Station 的 Route 淡化；仍然可以点 Route / ZIP |
| D8 | 记住上一次的 District 和该 District 下的 Station；Route Profile 和 Map 共用；只用 localStorage |
| D9 | 切换 District 时，如果当前 Station 不属于新片区 → 自动切到新片区的第一个有效 Station。保存的 District / Station 不存在时 → 第一个 District（北加州），Station 为该片区第一个（SFO01） |
| D10 | RM5 / RM5b 规则全部保留；District 只控制显示范围，不改变颜色含义 |
| D11 | 现有功能不能破坏（搜索、筛选、Fit、Coverage、Missing ZIP、难度模式、双层描边、hover / click / tap、1440 / 390、0 第三方请求） |

## 3. District 配置（Claude 设计）

- 文件：仓库内 `config/districts.json`。这是业务配置，不是运行数据，**进 Git**。

  ```json
  {
    "schema_version": 1,
    "districts": [
      {
        "id": "north-cal",
        "name_zh": "北加州片区",
        "name_en": "North Cal District",
        "stations": ["SFO01", "OAR01", "SMF01", "SCK01", "RNO01", "RDG01", "RDG02", "MOD01", "MFR01"]
      }
    ]
  }
  ```

- 顺序即含义：`districts` 的顺序就是 District 下拉框的顺序（第一个为默认）；`stations` 的顺序就是该片区 Station 下拉框的顺序（第一个为默认）。
- 校验（server 启动 / 读取时，失败时 API 返回 500 `district_config_invalid`）：
  - `id` 唯一，且匹配 `^[a-z0-9-]{1,32}$`；
  - 名称为非空字符串；
  - Station 代码匹配 `^[A-Z]{3}\d{2}$`，同一 Station 不能出现在两个 District 中；
  - 至少有一个 District。
- 新增片区：在 `districts` 中追加一项即可，不需要改页面代码。
- **未归属的 Station**：有 snapshot、但不在任何 District 中的 Station，统一放进一个自动生成的 District `unassigned`（“未分配站点 / Unassigned Stations”），排在最后，Station 按字母排序，不隐藏数据。目前没有这种情况，因此不会显示。
- **配置中有、但没有 snapshot 的 Station**：仍然出现在下拉框中，但禁用，并标注“（暂无数据）”；不能被选为当前 Station。
- 批处理命令 `dms:scrape-stations` 的默认抓取顺序**不变**（它是抓取顺序，和展示顺序是两回事）。之前 MS-T2b 用 `defaultStationOrder` 给下拉框排序的做法改为使用 District 配置。

## 4. API（Claude 设计）

- `GET /api/districts` →
  ```text
  { districts: [ { id, name_zh, name_en, stations: [ { code, has_snapshot } ] } ] }
  ```
  按配置顺序返回，包括自动生成的 `unassigned`（仅在存在时）。只读本地配置和 snapshot，不访问 DMS。
- `GET /api/route-map/district?district=<id>` → 片区总览地图数据：
  - 对该片区每个有 snapshot 的 Station 调用现有的 `buildRouteMap`；
  - 合并 `features`（每个 feature 的 `properties.station` 已经存在）、`routes`（每条带 `station`）、`missing`；
  - 汇总 `coverage`；
  - 返回 `stations: [{ code, fetched_at, route_count }]`、`cross_station_conflicts`（片区内的跨站重叠）、`details_status`。
  - 同站冲突仍然报错；跨站重叠只提示（MS-T2 规则）。
  - District 不存在 → 404 `district_not_found`；片区内没有任何 snapshot → 200，内容为空，页面显示“暂无数据”。
- 现有的 `GET /api/route-map?station=`、`/api/route-map/zip`、`/api/route-profiles?station=` **不变**。`/api/route-map/stations` 保留（兼容），顺序改为按 District 配置展开后的顺序。

## 5. Route Profile 页面

- 标题 `<title>` 和 `<h1>`：`美西线路画像`，旁边用小字写英文 `West Region Route Profile`。
- 顶部筛选：`片区` 下拉框（选项为 `name_zh`，title 或小字显示 `name_en`）→ `站点` 下拉框（当前片区的 Station，按配置顺序，没有 snapshot 的 Station 禁用）。
- Route Profile 始终显示**一个 Station** 的表格（与现在一样），没有“全部站点”选项。
- 表格、modal、五色、5 列 ZIP 表都不变。

## 6. 地图

### 6.1 筛选和状态

- 顶部：`片区` 下拉框 → `站点` 下拉框。站点下拉框的第一个选项是 **“全部站点（片区总览）”**，后面是该片区的 Station。
- 地图有两种范围（`scope`）：
  - **片区总览**（`station = null`）：请求 `/api/route-map/district`，显示该片区所有 Station 的 Route。
  - **站点细看**（`station = 代码`）：请求整个片区的数据（同一个接口），把当前 Station 的 Route 正常显示，同片区其他 Station 的 Route **淡化**（沿用现有“未选中线路”的淡化样式：`fillOpacity` 0.12、描边透明度 0.35），仍然可以 hover / click。
  - Claude 设计说明：站点细看时选择“淡化”而不是“隐藏”，是为了和现有“选中 Route 时其他 Route 淡化”的视觉语言一致，也能看到相邻 Station 的边界。
- 颜色：
  - 按线路模式：每条 Route 用自己的 `routeColor(route_id)`；
  - 难易度模式：RM5 规则不变。
  - District / Station 只影响透明度（淡化与否），不改变 `fillColor`。
- 淡化的叠加规则：
  - 选中了 Route → 沿用现有逻辑（只有该 Route 不淡化）；
  - 没有选中 Route，但处于站点细看 → 只有当前 Station 的 Route 不淡化；
  - 片区总览且没有选中 Route → 全部正常显示。
- 在站点细看中点击其他 Station 的 ZIP：照常选中该 ZIP / Route 并显示详情，**不自动切换** Station 下拉框（避免意外改变已保存的选择）。
- 搜索：
  - Route 搜索在当前片区所有 Route 中进行，列表显示 `Station · Route`；
  - ZIP 搜索沿用 `/api/route-map/zip`。结果 Station 在当前片区内 → 定位并选中，不切换 Station；不在当前片区内 → 提示“该 ZIP 属于 <District>/<Station>”，不自动切换。
- `定位站点` 按钮：
  - 片区总览时文字为“定位片区”，缩放到整个片区；
  - 站点细看时缩放到当前 Station（现有行为）。
  - 首次加载和切换范围时自动定位。
- 线路列表：
  - 片区总览时按 Station 分组（组标题为 Station 代码，按配置顺序），组内按 Route 名称排序；
  - 站点细看时只列出当前 Station 的 Route（与现在一样）。
- 覆盖率 / 缺少边界的邮编：显示当前范围的汇总（片区总览 = 片区汇总；站点细看 = 该 Station），清单中增加 Station 列。
- 跨站重叠提示（MS-T2）在片区总览中照常显示。
- RM5 legend、模式切换、双层描边、hover / click / tap 全部不变。

### 6.2 性能

北加州片区约 365 个 polygon（现有单站最多 166 个），同一个 Leaflet SVG 图层可以承受，不需要额外优化。边界数据由 server 端按需组装，不新增前端依赖。

## 7. 共用状态（localStorage）

- 新的 key：`nc-ops-console.selection` = `{"district": "<id>", "station": "<code>"}`（JSON），两个页面共用。旧 key `nc-ops-console.station` 读取一次用于迁移（如果其中的 Station 属于某个 District，就作为初始值），之后不再写入。
- 地图专用 key：`nc-ops-console.map-scope` = `"district"` | `"station"`，记住地图上次是片区总览还是站点细看。Route Profile 不读取它。地图处于片区总览时，共享状态中的 Station 保持为上一次具体选择的 Station，不写 null，所以 Route Profile 始终有有效的 Station。
- 启动时的选择：
  1. District：URL `?district=` → 已保存的值 → 第一个 District。不存在的值跳到下一项。
  2. Station：URL `?station=` → 已保存的值 → 该 District 的第一个**有 snapshot** 的 Station。必须属于已选 District 且有 snapshot，否则跳到下一项。
  3. 只有 URL `?station=`、没有 `?district=` 时，District 取包含该 Station 的 District。
- 无记录时：北加州片区 + SFO01；地图默认为站点细看（`map-scope` 默认 `station`）。
- **只在用户手动修改下拉框时保存**。地图 ZIP 搜索不会改变选择。
- 切换 District：当前 Station 不在新片区中 → 自动选新片区的第一个有效 Station，并保存。
- 所有读写都用 try / catch；localStorage 不可用时页面照常工作。

## 8. 文件（建议）

| 层 | 文件 | 改动 |
|---|---|---|
| 配置 | `config/districts.json`（新增） | 第 3 节 |
| store | `server/src/store/districts-file.js`（新增） | 读取和校验；与 snapshot 合并出 `has_snapshot` 和 `unassigned` |
| route-map | `server/src/route-map/route-map.js` | 新增 `buildDistrictMap`（复用 `buildRouteMap`，不复制 join 逻辑） |
| API | `server/src/api/app.js`、`server.js` | `/api/districts`、`/api/route-map/district`；`/api/route-map/stations` 改用 District 顺序 |
| 前端共用 | `web/station-preference.js` → 升级为 District + Station 选择（或新增 `web/selection.js`，删除旧模块的导出使用） | 第 7 节 |
| Route Profile | `web/index.html`、`web/app.js`、`web/format.js` | 标题、两级筛选 |
| Map | `web/map.html`、`web/map.js`、`web/map-state.js`、`web/map-view.js`、`web/map-panel.js`、`web/map-text.js`、`web/styles.css` | 第 6 节 |
| 文档 | `docs/data-schema.md` | 增加 District 配置说明 |

不新增依赖，不改 cache schema，不访问 DMS。

## 9. 验收标准

- **DS-AC1** Route Profile 的 `<title>` / `<h1>` 为“美西线路画像”，并显示英文 “West Region Route Profile”。
- **DS-AC2** District 来自 `config/districts.json`。新增一个测试用的 District（只改 fixture 配置）后，两个页面无需改代码即可显示和切换。
- **DS-AC3** District → Station 联动正确。北加州片区只显示配置中的 9 个 Station，顺序为 D3；没有 snapshot 的 Station 被禁用；`unassigned` 规则正确。
- **DS-AC4** 地图片区总览同时显示 9 个 Station 的 Route，每条 Route 用自己的 route color；覆盖率和缺少边界的邮编为片区汇总。
- **DS-AC5** 地图站点细看：当前 Station 正常显示，同片区其他 Station 淡化，颜色不变；Route / ZIP 仍然可以点击和搜索；选中 Route 的淡化规则和双层描边不变。
- **DS-AC6** RM5 难易度模式在两种范围下规则不变。
- **DS-AC7** 共享选择：Route Profile ↔ Map 双向同步；刷新后保留；无记录时为北加州 + SFO01；无效值回退；切换片区时 Station 自动修正；ZIP 搜索不修改选择；旧 key 能迁移。
- **DS-AC8** `npm test` 和 `git diff --check` 通过；没有新增依赖；不访问 DMS。
- **DS-AC9**（Claude 本机真实验证）1440 / 390；没有第三方请求；console 没有 error；提供截图。

## DS 实现记录（Implementation Notes，2026-10-06，Codex）

- 新增 `config/districts.json` 与 `server/src/store/districts-file.js`；读取时校验配置，保留配置顺序，合并 snapshot 的 `has_snapshot`，额外站点按字母排序加入末尾 `unassigned`。配置路径通过 `createApiServer({ districtsPath })` 注入。`unassigned` 保留给自动分组，禁止配置占用，避免自动分组与业务片区 ID 冲突；同一片区重复 Station 也拒绝。Station 列表可为空，用于尚无站点的新片区。
- 新增 `/api/districts`、`/api/route-map/district?district=`；`buildDistrictMap` 逐站调用 `buildRouteMap`，不复制 join / ZIP 冲突 / 难度逻辑。missing 行增加 Station，coverage 为各站 Station–Route–ZIP 行计数相加（跨站重叠不会伪造唯一归属），跨站提示只计算片区成员。片区无 snapshot 返回空数据；本地 snapshot 文件不存在时，District API 仍返回配置及禁用站点。已有单站接口字段与含义不变；兼容 stations API 改为 District 展开顺序，批处理抓取顺序不动。
- 原 `web/station-preference.js` 升级为共用 District / Station 选择与选择框填充模块。新 key 按 spec；启动、URL 链接、ZIP 搜索均不写入；旧 key 只用于启动时的只读迁移，第一次手动选择后写新 JSON key，永不再写旧 key。所有 storage 访问捕获异常。空片区在内存中可无 Station，不将 null 写入共享选择，保留最后一个可用选择；地图仍保存独立 scope。
- Route Profile 标题与英文小字按 spec，两级选择框来自 API；没有 snapshot 的 Station 禁用，空片区显示暂无数据。主表、modal、ZIP 五列及难度颜色保留。
- 地图两种范围均请求整个片区，`polygonStyle` 新增默认 null 的 `focusStation`，只改变未选中状态下的透明度，选中 Route 的淡化规则优先。两种颜色模式、legend、描边常量与非交互 pane 未改。搜索片区所有 Route，显示 Station · Route；片区总览按配置 Station 顺序分组，站点细看默认只列当前站点。跨站 ZIP 点击 / 搜索不改下拉框或保存值，片区外单归属 ZIP 提示所属片区 / Station；多归属 ZIP 继续列出所有 owners，不判断归属。
- Fit 依据 scope 定位片区或站点，初次加载与范围切换自动定位；覆盖率 / missing 根据当前范围汇总，missing 表增加 Station 列；更新时间按当前范围逐站展示真实 snapshot fetched_at，不生成统一时间。窄屏缺失清单列宽随四列布局调整。
- 文件：新增上述配置 / store、`server/test/districts-file.test.js`、`server/test/district-map.test.js`；修改 `server/src/api/{app,server}.js`、`server/src/route-map/route-map.js`、`web/{station-preference,app,format,map,map-state,map-view,map-panel}.js`、`web/{index,map}.html`、`web/styles.css`、`docs/data-schema.md`。测试索引及已有 `station-preference` / `route-map-api` / `route-map-web` / `map-state` / `t7` / `rd1` 测试相应扩展或适配。
- 测试调整范围：旧前端 fixture 改为 District wire shape；旧跨站 ZIP 自动切站和旧 key 写入断言改为本 spec 明确要求的不切站 / 新 key；顺序断言改用 District 配置；保留颜色、交互、modal、安全响应头及同站 API 的回归检查。新增配置校验 / fixture 扩展、聚合 / 冲突、空结果、9 站配置、API 注入与错误码、优先级 / 迁移 / storage 异常、focus 叠加、两页两级联动与手动保存测试。
- 最终检查：Node v24.19.0，`npm.cmd test`（即 npm test）397/397 通过，0 failed / skipped，日志 `.handoff/DS-tests.log`；`git diff --check` 通过（仅 LF/CRLF 提示）。没有 lint / build scripts，没有运行 lint / build。中间检查曾因旧接口测试预期、PowerShell 管道编码及临时检查脚本语法问题失败，均已修复，最终检查通过。
- 实际运行检查：临时合成 9 站 snapshot / 边界，loopback HTTP server + 已安装 Playwright / Chromium，1440 / 390 检查标题、两页选择恢复、总览 / focus、定位按钮、难度切换、真实 SVG 双层描边、Esc、ZIP 搜索不保存、无横向溢出、0 第三方请求、0 pageerror / console error。底图缺失用模拟响应检查降级，不读取真实 archive；日志 `.handoff/DS-browser.log`，脚本 `.handoff/DS-browser-check.mjs`，截图 `.handoff/DS-profile-1440.png`、`DS-profile-390.png`、`DS-map-1440.png`、`DS-map-390.png`。server / browser 已关闭，临时合成数据目录已清理。
- 验收映射：DS-AC1 标题 / 英文；AC2 配置驱动与两个页面 fixture 新片区；AC3 顺序 / 联动 / 禁用 / unassigned；AC4 合成 9 站 / route color / 汇总；AC5 focus / 搜索 / 选中优先 / 双层描边；AC6 原 RM5 回归与两范围模式；AC7 共用选择 / 恢复 / 默认 / 回退 / 修正 / 迁移；AC8 测试与 diff / 无新依赖 / 无 DMS：在自动化与合成浏览器范围内满足。DS-AC9 的真实数据 / 真实底图本机验证仍由 Claude 完成，Product Owner 预览签字未完成，不宣称 UI 最终验收完成。
- 没有读取真实 runtime、访问 DMS 或任何凭据；没有改 cache schema、抓取 / 批处理代码、CSP、RM5 颜色或 legend；没有新增依赖、commit、push、部署。legacy 页面未修改，本轮未对其做浏览器回归。原有 `.claude/` 和原有 District spec 内容均保留，仅追加本实现记录。

---

## DS2 — 丹佛片区接入（**Approved**，Product Owner 2026-10-06）

### DS2-1 配置

- `config/districts.json` 新增 `denver`（丹佛片区 / Denver District）。Station 顺序按 Product Owner 给出的顺序。
- **Station ID 核对**（2026-10-06，Claude 实时读取 DMS 页头 Station 菜单，共 52 个 Station，只读）：
  - **PIHO1** 不在 DMS 中（DMS 中是 **PIH01**，数字 0）。Product Owner 2026-10-07 确认使用 **PIH01**，已按原顺序（SLC01 之后）加入配置。尚未抓取，抓取前显示为禁用的“暂无数据”。
  - **GJT01**、**BZN01** 不在 DMS 菜单中（可能尚未开站或账号无权限；Product Owner 2026-10-07：暂时保留“暂无数据”状态，不视为错误）。按原样写入配置（没有 snapshot 时显示为禁用的“暂无数据”），**不加入批处理**（切站会找不到菜单项，从而触发安全停止）。
- 其余 10 个 Station 在 DMS 中存在，已按 `dms:scrape-stations` 抓取（见 DS2-4）。

### DS2-2 边界库支持多个区域文件（Claude 设计）

- 丹佛片区 10 个 Station 共 299 个 ZIP，分布在 CO 159 / UT 86 / NM 37 / ID 9 / MT 5 / WY 3，原来全部超出 CA / NV / OR 边界库的范围（`not_checked`）。
- 新增 `geo/zcta2020_mountain.geojson` 和 `.meta.json`：数据源和生成方式与 `zcta2020_ca_nv_or` 完全相同（Census 2020 ZCTA 1:500k，mapshaper 截取，不做简化），范围规则为 `^(80|81|82|83[0-8]|84[0-7]|87|88[0-4]|59)`（CO / WY / ID / UT / NM / MT），共 2,023 个 polygon，约 14.9 MB。与现有文件没有重复的 ZIP。它覆盖丹佛片区 299 个 ZIP 中的 296 个；剩下 3 个（83303、87131、87158）在 Census 中没有 ZCTA，按 `no_zcta` 处理，不生成 polygon。
- **boundary store 改为加载 `geo/` 下所有 `*.meta.json`**（按文件名排序）：
  - 每个 meta 的 `boundary_file` 必须存在，并且各自通过现有校验；
  - 所有文件的 `dataset` / `vintage` 必须相同；
  - 不同文件之间不能有重复的 `postal_code`；
  - `byZip` 合并所有文件；`inScope(zip)` = 任一文件的范围规则匹配；
  - 任何一项失败 → `boundary_invalid`；`geo/` 下没有任何 meta → `boundary_not_found`。
  - API 的 `boundary_source` 字段不变（dataset、vintage）。
  - 以后新增区域时，只需要添加一对文件，不改代码。

### DS2-3 区域底图

- 原来的底图只有 `us`（z0–6）、`norcal`（z0–10）、`ops`（z0–14），丹佛片区放大后只能看到 z6 的低精度底图。
- 新增 `mountain.pmtiles`：与 RM2 同样的方式（`pmtiles extract`，Protomaps 构建 `20261002`），bbox `-116.5,34.0,-103.0,47.0`，z0–10，33.8 MB，放在 runtime `basemap/` 目录，不进 Git。
- 前端 `basemaps` 列表新增 `{ name: 'mountain', maxDataZoom: 10, bounds: [[34.0, -116.5], [47.0, -103.0]] }`；server 端的 basemap 白名单新增 `mountain`。文件缺失时沿用现有的底图缺失提示，不影响 polygon。
- `docs/features/route-map.md` RM2 底图表增加一行。

### DS2-4 抓取记录（2026-10-06，Claude 在 Product Owner 本机执行）

- 小规模验证：`--stations CYS01,LGU01 --max-routes-per-station 1 --new-run`，然后不加限制再运行一次。两站各 2 条 Route；续跑正确；Station 间隔 15 秒；双重验证、summary 正常；没有 429 / 5xx / session 问题；已恢复原 Station。
- 全量：`--stations DEN01,CYS01,ABQ01,FMN01,SAF01,SLC01,TWF01,IDA01,LGU01,BIL01 --new-run`。10 个 Station 全部 `completed`，完整性检查全部通过；共 73 条 Route（新抓 69 条，cache 跳过 4 条）；1,426 个 `/prod-api/` 请求（上限 2,406）；用时 548 秒；定位全部为 L1；没有缺失的 Route；没有 429 / 5xx / session 问题；已恢复 SFO01。

### DS2-5 验收标准

- **DS2-AC1** 两个 District 同时存在，切换正确，各自只显示自己的 Station，顺序为配置顺序。
- **DS2-AC2** 边界库加载两个区域文件；合并、重复检测、范围规则、错误码符合 DS2-2；北加州片区的结果不变（355 / 366）。
- **DS2-AC3** 丹佛片区地图：片区总览和站点细看与北加州一致；296 个 ZIP 上图，3 个 `no_zcta`；`mountain` 底图可以显示。
- **DS2-AC4** Route Profile / Map 记住 District + Station（例如 丹佛片区 + SLC01）。
- **DS2-AC5** `npm test` 和 `git diff --check` 通过；1440 / 390；没有第三方请求。

## DS2 实现记录（Implementation Notes，2026-10-06，Codex）

- 本轮仅实现 DS2-2 / DS2-3 和 brief 指定文档、测试。边界 store 按文件名排序扫描全部 meta，逐文件复用 `validateBoundaries`，拒绝跨文件重复 ZIP 和 dataset / vintage 不一致；范围取并集。meta 引用文件缺失返回 `boundary_invalid`，没有 meta（包括目录不存在）返回 `boundary_not_found`。
- 保留成功默认读取的 Promise 缓存、失败后重试和注入 fileOps 时不缓存；fileOps 增加 `readdir` 操作。`meta` 保留排序后首个文件的元数据，调用方使用的 dataset / vintage 不变；`geojson` 合并 features，`byZip` 合并几何索引。保守限制 `boundary_file` 为 geo 目录内的 GeoJSON 文件名，禁止路径跳出。
- server API / store 白名单加入 `mountain`；前端顺序为 us → norcal → mountain → ops，mountain 使用 spec 的 z10 / bounds，保持高精度 ops 在上。缺失降级、CSP、RM5 / District 前端行为未改。
- 修改文件：`server/src/store/{boundaries-file,basemap-file}.js`、`server/src/api/basemap.js`、`web/map-view.js`、`server/test/{boundaries-file,basemap-file,route-map-api,route-map-web}.test.js`、`geo/README.md`、`docs/features/route-map.md` 和本实现记录。保留已有未提交 District 工作，没有修改边界数据或 District 配置。
- Node v24.19.0，`npm.cmd test` 406/406 通过，0 failed / skipped，日志 `.handoff/DS2-tests.log`。新增合成多区域合并、排序、范围并集、重复、来源一致性、文件缺失、错误码、缓存测试；mountain 合成 archive Range 206 / 内容验证；前端图层顺序 / zoom / bounds 断言。原公开 Census 文件校验随合并更新为 4,542 个 ZIP。中间测试失败为新增 fixture 引用文件名、测试标识符和旧错误码断言，已修复。没有 lint / build scripts，没有运行 lint / build。
- 使用已有 Playwright / Chromium 与临时合成 9 站数据运行 1440 / 390 回归：两页选择、地图总览 / focus、搜索、难度模式和描边检查通过；0 console / page error、0 第三方请求。底图缺失用模拟响应，未读取真实 runtime / archive。日志 `.handoff/DS2-browser.log`，脚本 `.handoff/DS2-browser-check.mjs`，截图 `.handoff/DS2-{profile,map}-{1440,390}.png`。临时 server / browser 已关闭，合成目录已清理。
- 验收边界：DS2-AC2 多文件合并 / 错误码 / 范围通过；真实北加 355 / 366 未读取验证。AC3 mountain 接入及降级通过，丹佛真实 296 / 3 与真实道路显示待本机验证。AC5 自动测试与合成 1440 / 390 / 无第三方请求通过。AC1 / AC4 为已有 District 功能，本轮不改，丹佛真实切换 / 保存留待 Claude 本机复核。Product Owner 预览签字未完成。
- 无新增依赖、DMS 访问、凭据写入、cache schema 变化、commit、push 或部署。legacy 页面未修改，本轮未做其浏览器回归。

### CD-T5 实现补充（2026-10-08）

District 可带可选的 `scrape_disabled` 对象：key 必须是本片区 Station，reason 仅支持 `not_in_dms_menu`、`no_permission`、`disabled`。配置不改变 Station 的归属、`schema_version: 1` 或 `/api/districts` 的现有输出。Denver 的 GJT01、BZN01 配置为 `not_in_dms_menu`；刷新范围会跳过它们。设计详见 [central-db 第 22.3 节](central-db.md#223-scrape_disabled-与刷新范围)。

### 南加州片区（2026-10-09）

- SC1 在配置末尾追加 `south-cal`：南加州片区 / Southern California District，保持 `schema_version: 1` 及已有两个片区的内容。
- Station 固定顺序：CNO01 → LAX01 → LAX02 → LAX03 → SFV01 → SFV02 → VTC01 → SMX01 → BKD01 → FAT01 → PLM01 → SAN01 → YUM02 → YUM01 → HNL01。
- 沿用配置驱动的 API、刷新范围、地图、仓库过滤和前端选择器，没有新增代码分支，也没有修改 `server/src/`、`server/bin/` 或 `web/` 产品代码。
- 按 brief 中 Claude 已确认的当前状态，15 个 Station 都没有快照，继续显示现有“暂无数据”状态。本次没有读取正式运行数据核验，也没有抓取数据。
- 没有配置 `scrape_disabled`；DMS 菜单待核对，见 [open questions](../open-questions.md)。
- 新增 `server/test/district-config.test.js`，在测试索引注册。使用真实配置和合成 snapshot / mock 边界 / fake 仓库数据，覆盖 brief 的 11 组断言；Worker 只请求 GET 预览，注入禁止 spawn 的替身。Route Profile 依现有页面没有 DSP 选择器，地图测试覆盖空 DSP 状态。
- 未修改现有测试断言或 fixture 配置；`server/test/index.js` 仅新增模块注册。未新增依赖，未运行 DMS、写正式库、重启服务、提交、推送或部署。
- 验证：`npm.cmd test`（同一 `npm test` script）565 项通过，0 失败、0 跳过；针对性测试 34 项通过（包含复用地图测试模块的 22 项），日志为 `.handoff/SC1-tests.log` 和 `.handoff/SC1-targeted-tests.log`。`git diff --check` 通过；没有配置 lint / build scripts。未进行真实数据浏览器预览，Product Owner 预览签字仍待后续完成。
