# Web Route Map（Station → Route → ZIP 地图）— Spec

- Status: **Approved**（Product Owner 2026-10-02 确认方案并授权实现 MVP；决定见第 2.1 节）
- 更新：2026-10-02
- 相关：`docs/features/tableau-route-map.md`（数据来源与边界决定、TBL1 / TBL1.5 / TBL2 记录；Tableau 路线已暂停）；`geo/README.md`；`docs/data-schema.md` 第 8、10 节；`docs/features/dms-refresh.md`（T7 前端、CSP）

---

## 1. 目标

在现有 NC Ops Console（`npm run server` → `http://127.0.0.1:3000/`）里直接提供 Route 地图，用户不需要安装或打开 Tableau。

- 选择 Station（第一版只有 SFO01）→ 显示该 Station 覆盖的 ZIP polygon（真实 ZCTA）。
- 同一 Route 同色，不同 Route 不同色（颜色只表示 Route）。
- Hover / click ZIP 显示 ZIP、Route、Station。
- 显示 “Mapped X / Total Y” 和 Missing Boundary ZIP 清单。
- 没有 polygon 的 ZIP 不伪造、不猜边界。

不做：Difficulty、PPH、Volume、自动刷新、SMF01 / D8、多 Station 批量抓取、Route label、point fallback、复杂颜色策略。

## 2. 复用（不作废）

| 已有 | 用途 |
|---|---|
| `route-profiles.json` 每行的 `postal_codes`（TBL2） | Route → ZIP 关系 |
| `server/src/transform/postal-codes.js`（格式 / 冲突校验） | 生成地图数据时复用，不复制规则 |
| `geo/zcta2020_sfo01.geojson` + `geo/README.md`（Census 2020 ZCTA 1:500k） | ZIP 边界 |
| TBL3 覆盖结果（254 / 269，15 个缺失） | 验收的预期值 |
| Route-ZIP CSV 导出 | 保留，供以后 Tableau / 其他分析使用；Web 地图不依赖它 |

## 2.1 已确认的决定（Product Owner 2026-10-02）

| # | 决定 |
|---|---|
| W1 | **不加外部底图**：深色背景 + ZCTA polygon + 清晰边界 + Route 颜色。不接 OpenStreetMap 或其他 tile。以后需要街道参考时单独设计 |
| W2 | **地图库 Leaflet，npm 依赖固定 `leaflet@1.9.4`**（`package.json` / `package-lock.json` 管理，不复制到 `web/vendor`）。所有 Leaflet 资源由本地 server 提供 |
| W3 | 数据流：DMS → transform → route-profiles store + boundary store → server 端 route-map 组装（join / coverage / missing / 冲突校验）→ `GET /api/route-map?station=` → `/map` |
| W4 | GeoJSON 由 store 模块读取和校验；前端不依赖 `geo/` 路径 |
| W5 | 前端只消费组装好的数据，不做 Route-ZIP / GeoJSON join 或 coverage 计算 |
| W6 | 独立页面 `/map`，地图逻辑不放进 `web/app.js` |
| W7 | `routeColor(route_id)` 稳定、不依赖数组顺序、不写回数据；允许重复；Tooltip 和 click 面板必须显示 Route Name |
| W8 | hover 临时显示 ZIP / Route / Station；click 固定选中并在侧边面板显示；触屏不依赖 hover |
| W9 | 显示 `Mapped X / Total Y` 和 Missing Boundary ZIP 清单 |
| W10 | 新增 boundary meta 文件，缺失分为 `no_zcta`（Census 确认没有）和 `not_checked`（边界还没覆盖到，需要重新生成）；新增 ZIP 不得误报为 `no_zcta` |
| W11 | CSP 不放宽；第一版页面不允许任何外部网络请求；浏览器真实验证时检查 Network 和 console |

## 3. 技术方案（已确认，以第 2.1 节为准）

### 3.1 地图库：Leaflet 1.9.x

| | Leaflet 1.9 | MapLibre GL | 手写 SVG（如 d3-geo） |
|---|---|---|---|
| 体积 | 约 150 KB（JS + CSS） | 约 800 KB+，WebGL | 小，但要自己写平移 / 缩放 / 命中测试 |
| 适合的数据量 | 几百到几千个 polygon，SVG / Canvas 足够（我们约 254 个） | 大量矢量瓦片 | — |
| GeoJSON | 内置 `L.geoJSON`，hover / click 事件现成 | 需要 style JSON 和 source / layer 配置 | 自己实现 |
| 无底图运行 | 可以（只显示 polygon） | 可以，但仍要写 style | 可以 |
| CSP（`default-src 'self'`） | 本地提供文件即可；内部只用 `element.style`（CSSOM），不需要 inline `<style>` | 默认用 blob worker，需要放宽 `worker-src blob:` | 无问题 |
| 团队熟悉度 | 旧 dashboard 已在用（1.9.4） | 无 | 无 |

**推荐 Leaflet 1.9.x。** MapLibre 对这个数据量是过度设计，还要放宽 CSP；手写地图引擎违背“不为零依赖自造轮子”的原则。

### 3.2 依赖与加载方式

- 新前端的 CSP 是 `default-src 'self'`，不能从 CDN 加载（旧 dashboard 用的 cdnjs 不可行）。
- **推荐：新增 npm 依赖 `leaflet`（固定 1.9.x），server 用静态白名单从 `node_modules/leaflet/dist/` 提供 3 个文件**（`leaflet-src.esm.js`、`leaflet.css`，以及需要时的图片）。不加 bundler，前端用原生 ES module `import`。
  - 这是新增永久依赖，按 `AGENTS.md` 需要 Product Owner 批准。
  - 备选：把 `dist` 文件复制到 `web/vendor/leaflet/`（附 BSD-2 license）。不改 `package.json`，但仓库里会多一份第三方代码，升级要手动做。

### 3.3 底图（需要 Product Owner 决定）

- **推荐第一版不加外部底图**：深色背景上只画 ZIP polygon，再加 Station 区域的缩放定位。
  - 原因：外部瓦片（例如 OpenStreetMap，旧 dashboard 在用）需要放宽 CSP 的 `img-src`，浏览器会向外部服务器发请求（暴露正在查看的区域），OSM 官方瓦片也有使用政策限制。
- 如果需要街道参考，作为单独决定：允许某一个瓦片服务（写进 CSP 白名单 + 署名），或以后再做离线底图。

### 3.4 数据流和分层

```text
DMS ──(T3 抓取)──> transform（postal_codes 校验）──> store: route-profiles.json
                                                     store: geo/*.geojson（边界）
                     ↓
       route-map 组装（纯函数：join、coverage、missing、冲突校验）
                     ↓
       API: GET /api/route-map?station=SFO01
                     ↓
       frontend: map.html + map.js（只负责渲染和交互）
```

- **join 放在 server 端的纯函数里**（新的 read-model 模块），不放在前端，也不放进 DMS / transform。
  - transform 只负责 DMS 原始数据 → normalized Route Profile。
  - Route Profile 和边界的 join 是“给地图用的视图”，属于 store 之后、API 之前的一层。
  - 校验（格式、Station 内 / 跨 Station 冲突）复用 `postal-codes.js`。
- **边界通过 API 提供，不作为静态资源。** 边界文件由新的 store 模块读取（校验每个 feature 有唯一的 5 位 `postal_code`），handler 不直接读文件，和现有分层一致。前端只拿到组装好的结果，不需要知道 `geo/` 目录。
- **一个接口返回一次渲染需要的全部内容**：

```text
GET /api/route-map?station=SFO01
200 {
  station, fetched_at,                       // Route Profile snapshot 的抓取时间
  boundary_source: { dataset: "cb_2020_us_zcta520_500k", vintage: 2020 },
  coverage: { total: 269, mapped: 254, missing: 15 },
  routes: [ { route_id, route_name, zip_count, mapped_count } ],
  missing: [ { postal_code, route_id, route_name } ],
  features: GeoJSON FeatureCollection，每个 feature 的 properties = { postal_code, route_id, route_name, station }
}
400 invalid_station；404 station_not_found / snapshot_not_found；
409 postal_codes_missing（旧 snapshot，提示重新运行 dms:scrape）；
500 route_zip_conflict / boundary_invalid / snapshot_invalid
```

- Station 下拉选项：第一版来自 `route-profiles.json` 里已有的 Station（目前只有 SFO01），可由同一接口或一个很小的 `GET /api/route-map/stations` 提供（实现时二选一）。
- 现有 `GET /api/route-profiles` 不改。

### 3.5 Route 颜色

- 由前端纯函数 `routeColor(route_id)` 决定：对 `String(route_id)` 做稳定 hash（例如 FNV-1a），再对一个固定的分类调色板（约 20 色，在深色背景上可辨识）取模。
  - 只依赖 `route_id`，不依赖数组顺序；刷新数据后同一 Route 颜色不变。
  - 颜色不写进任何数据文件或 API。
  - Route 多时颜色会重复，相邻 Route 也可能同色（第一版接受）；用清楚的 polygon 边界线和 tooltip / 信息面板里的 Route Name 来区分。

### 3.6 交互

- **Hover（桌面）**：高亮当前 ZIP 的边界，显示 tooltip：ZIP / Route / Station。
- **Click（桌面和触屏）**：选中 ZIP，侧边信息面板固定显示 ZIP / Route / Station，直到点别的 ZIP 或点空白处取消。保证不依赖 hover 也能看到信息。
- 可选（实现时简单就做）：选中 ZIP 后，同一 Route 的其他 ZIP 也加粗边界，便于在颜色重复时看出 Route 范围。
- 所有文字都通过 `textContent` / Leaflet tooltip 的文本内容设置，不把 API 字符串当 HTML 插入。

### 3.7 Coverage 和 Missing Boundary ZIP

- 页面侧边栏：`Mapped 254 / Total 269`（及百分比）；下面是 Missing Boundary ZIP 表（ZIP、Route），数据直接来自 API 的 `coverage` / `missing`，前端不重新计算。
- 说明文字：ZCTA ≠ USPS 投递边界；缺失的 ZIP 没有 Census ZCTA，因此不画 polygon。
- **区分两种“缺失”（W10）**：截取边界时同时写 `geo/zcta2020_sfo01.meta.json`：

  ```json
  {
    "dataset": "cb_2020_us_zcta520_500k", "vintage": 2020,
    "source_url": "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip",
    "generated_at": "…", "boundary_file": "zcta2020_sfo01.geojson",
    "input": { "station": "SFO01", "snapshot_fetched_at": "…" },
    "checked_postal_codes": [ "…269 个…" ],
    "no_zcta": [ "…15 个…" ],
    "feature_count": 254
  }
  ```

  - `checked_postal_codes`：生成时拿去和全国 Census 数据比对过的 ZIP。
  - `no_zcta`：其中在全国 Census 数据里找不到 ZCTA 的 ZIP。
  - 组装时，地图上缺 polygon 的 ZIP 按以下规则分类：在 `no_zcta` 中 → `no_zcta`；不在 `checked_postal_codes` 中 → `not_checked`（需要重新截取边界）。
  - 一致性：`checked_postal_codes` 减去 `no_zcta` 必须都在 GeoJSON 中、`feature_count` 等于 GeoJSON feature 数、GeoJSON 中没有 meta 之外的 ZIP；不一致时 `boundary_invalid`。
  - API 的 `missing[]` 每项带 `reason`（`no_zcta` / `not_checked`）；`coverage` 增加 `missing_no_zcta`、`missing_not_checked` 两个计数。页面在有 `not_checked` 时提示“边界文件需要重新生成”。

### 3.8 页面位置

- 新增独立页面 `web/map.html`（`GET /map`），在现有 Route Profile 页面的页头放一个链接，地图页也能链接回去。
- 不把地图塞进现有 `web/app.js`，避免一个页面脚本承担两种功能。

## 4. 推荐文件结构（实现时）

```text
server/src/store/boundaries-file.js     读取并校验 geo/*.geojson（和 meta）
server/src/route-map/route-map.js       纯函数：join、coverage、missing、冲突校验（复用 postal-codes.js）
server/src/api/app.js                   新增 /api/route-map；静态白名单新增 /map、/map.js、Leaflet 文件
web/map.html                            地图页面
web/map.js                              Leaflet 渲染、hover / click、侧边栏
web/route-colors.js（或放进 format.js）  routeColor 纯函数 + 调色板
geo/zcta2020_sfo01.geojson              保留（已存在）
geo/zcta2020_sfo01.meta.json            新增：生成时的输入 ZIP 和缺失 ZIP
server/test/route-map.test.js           组装逻辑、API、颜色函数、静态白名单
```

代码健康：`server/src/api/app.js` 目前在一个函数里处理静态文件和 3 个 API，新增第 4 个时，建议顺带做一次局部整理（每个 endpoint 一个小函数 / 路由表），行为不变、现有测试保留。

## 5. MVP 验收标准（草案）

- **RM-AC1** `npm run server` 后打开 `/map`（或从首页链接进入），选择 SFO01，地图显示 254 个 ZCTA polygon，并自动缩放到该 Station 范围。
- **RM-AC2** 同一 Route 的 ZIP 颜色相同；颜色由 `route_id` 决定，重新抓取后保持不变；颜色不出现在任何数据文件或 API 中。
- **RM-AC3** Hover 显示 ZIP / Route / Station；click 选中 ZIP 并在信息面板显示同样内容；触屏可用。
- **RM-AC4** 侧边栏显示 `Mapped 254 / Total 269`，Missing Boundary ZIP 清单 15 行（与 `geo/README.md` 一致）；没有任何伪造或猜测的 polygon。
- **RM-AC5** join、coverage、missing、冲突校验在 server 端纯函数中完成并有测试；前端不做 join 或校验。
- **RM-AC6** 页面只加载本地资源（CSP 不放宽），没有外部请求；API 字符串不经过 `innerHTML`。
- **RM-AC7** 旧 snapshot 没有 `postal_codes`、存在 ZIP 冲突、边界文件损坏时，API 返回稳定错误码，页面显示简洁说明。
- **RM-AC8** 现有页面和 API 行为不变；`npm test` 全部通过；新增依赖（如批准）只有 `leaflet`。
- **RM-AC9** Product Owner 本机预览签字。

## 6. 风险和未决问题

1. ~~底图~~ → 已决定：第一版不加（W1）。
2. ~~依赖~~ → 已决定：`leaflet@1.9.4` npm 依赖（W2）。
3. **边界文件按 Station 命名**：`zcta2020_sfo01.geojson` 只适合单个 Station。新增 Station 时，建议改成一个服务区边界文件（例如 `zcta2020_service_area.geojson`），按 ZIP 查找。第一版继续用现有文件，不改名。
4. **边界过期**：Route 新增 ZIP 后，如果没有重新截取边界，地图会把它误报为缺失 → 3.7 的元数据文件和 `not_checked` 分类。
5. **CSP 兼容**：Leaflet 是否完全不需要放宽 CSP，要在实现时用浏览器实测（console 无 CSP 报错）。
6. **颜色重复**：51 条 Route、约 20 色，相邻同色不可避免；第一版接受。
7. **ZCTA 局限**：同 `geo/README.md`——只表示大致覆盖，不判断地址归属。

## 实现记录（Implementation Notes）

### RM1 — 2026-10-02（Codex）

- 新增 boundary store（GeoJSON / meta 一致性、ZIP 唯一性及 polygon 坐标校验）、纯函数 `buildRouteMap`、`GET /api/route-map` 和 `/api/route-map/stations`。boundary store 不缓存，测试通过 `geoDir` / fileOps 注入；不读取真实 DMS 或真实 runtime 数据进行验证。
- `app.js` 使用 endpoint 小函数和路由表；保留各现有 endpoint 独立的错误映射、方法限制、响应头和仅状态码日志。跨 Station ZIP 冲突检查集中在 `postal-codes.js`，导出器与地图共用；现有测试未修改。
- 新增 `/map` 独立页面，Leaflet 从 npm 安装目录通过固定白名单提供；`webDir`、`leafletDir` 和 `geoDir` 可注入。不新增依赖、不改 geo 文件、不放宽 CSP、不加载 tile。首页仅添加地图链接。
- 前端使用稳定 FNV-1a Route 颜色、DOM 元素 tooltip、click / touch 选中、同 Route 边界高亮、空白取消选择、Coverage / Missing 表、边界重生成提示、snapshot Last Updated 和错误 / 空状态。ZIP join 与计数均来自 server；前端仅格式化 API 计数的百分比。Station 快速切换时忽略旧响应。
- 新增合成数据测试：boundary store、地图组装、API、静态白名单、颜色和注入 Leaflet 的 DOM doubles；公开 Census 文件合法性测试确认 254 features、269 checked ZIP、15 no_zcta。没有用真实运营 snapshot 核对 Route 与 ZIP 的关系。
- 检查：`npm.cmd test`（231 项通过）；`git diff --check` 通过。项目没有配置 lint / build 命令。
- 使用已安装的 Playwright / Chromium 进行临时本地浏览器检查（独立临时 mock runtime 和 mock 边界，结束后清理）：1440px / 390px 均无横向溢出；polygon 渲染、fitBounds、hover、click、Station 切换和移动触屏点击通过；Network 无外部请求，console / JavaScript / CSP 无报错。该检查没有添加永久工具或依赖。
- RM-AC2 / AC3 / AC5 / AC6 / AC7 / AC8、RM1-AC-A / B 已通过上述验证；RM-AC1 / AC4 的真实 SFO01 254 / 269 / 15 结果留给 Claude 本机验证；RM-AC9 仍待 Product Owner 预览签字。

### RM1 第 1 轮修复 — 2026-10-02（Codex）

- 仅修复 RM-AC3 hover tooltip：tooltip 专用 CSS 使用内容自适应宽度、标签和值横向排列、禁止折行，并覆盖全局 `dd` 的逐字折行样式；`bindTooltip` 设置 `direction: 'auto'` 和 `sticky: true`，跟随鼠标并自动选择左右方向，避免停留在 polygon 中心导致下缘裁切。内容仍为 `textContent` 构造的 DOM 元素，点击面板和其他地图行为未修改。
- DOM double 记录并断言 tooltip 选项。`npm.cmd test` 全部 231 项通过；项目没有 lint / build 命令。临时本地 HTTP mock 页面使用已安装的 Playwright / Chromium 检查：1440px / 390px 下三行 `ZIP 93901`、`Route SFO01-041`、`Station SFO01` 均完整且同一行显示，tooltip 宽约 124px；鼠标位于合成 polygon 下缘时 tooltip 位于地图容器内，无横向溢出、console / JavaScript / CSP 错误。未读取真实 runtime 数据或访问 DMS；真实数据复核与 Product Owner 预览签字仍由本机完成。

### 本机真实验证（2026-10-02，Claude 在 Product Owner 本机运行）

- `npm test` 231/231 通过；`git diff --check` 通过。依赖只新增 `leaflet` 1.9.4（Claude 安装，`package.json` / `package-lock.json`）。
- `GET /api/route-map?station=SFO01`：coverage `{ total 269, mapped 254, missing 15, missing_no_zcta 15, missing_not_checked 0 }`；254 个 feature，properties 只有 `postal_code / route_id / route_name / station`；51 条 Route。
- 无界面 Chromium（1440 宽、390 宽 + 触屏）打开 `/map`：
  - 254 个 polygon，51 条 Route 共用 19 种颜色；没有任何 tile；Station 下拉只有 SFO01。
  - 侧边栏 `Mapped 254 / Total 269 (94.42%)`；Missing Boundary ZIP 表 15 行，原因都是 “No Census ZCTA”，与 `geo/README.md` 一致。
  - **页面只有 9 个请求，全部是 `http://127.0.0.1:3000/`，没有外部请求**；console 没有 error / warning，没有 CSP violation。
  - hover：tooltip 显示 ZIP / Route / Station；click：侧边面板固定显示同样内容，并加粗同 Route 的边界；触屏 tap 同样可以选中。
  - 1440 和 390 都没有页面横向滚动；390 时侧边栏在地图下方。
- 第 1 轮修复后复核：tooltip 不再折行（约 124px 宽，`Route SFO01-041` 一行显示）；在最靠近地图底部的 polygon 上 hover，tooltip 完整位于地图容器内。
- 待 Product Owner 预览签字（RM-AC9）。可留意：调色板中有一种灰色（`#b3b3b3`），可能被误读为“无数据”，是否移除由 Product Owner 决定。

---

### RM2 实现记录 — 2026-10-02（Codex）

- 新增 `basemap-file.js`（固定 us / norcal / ops 白名单、PMTiles v3 文件头校验、打开文件句柄与范围 stream）和 `api/basemap.js`（200 / 206 / 416、单范围与 suffix、客户端断开后的 stream 清理）。API 通过现有 handler 表接入；底图独享 `private, max-age=3600`，其余资源仍为 `no-store`；CSP 未改变，错误码不含本地路径。`createApiServer` 支持注入 `basemapDir` / `protomapsDir`，默认底图目录是 `<runtime>/basemap/`。
- `routes[]` 直接带出原 Route Profile 行的 `station / dsp_name / pickup_volume / pph`；不修改 join、coverage、missing、冲突校验、Route Profile API 或 stores。没有新增或读取真实业务数据。
- 前端拆为 `map.js`（加载与事件编排）、`map-view.js`（Leaflet、三层 PMTiles、polygon 与 fit）、`map-panel.js`（搜索、列表、Summary、Selected ZIP、Coverage 与 Missing）、`map-state.js`（纯搜索、选择、样式函数）。本地 UMD Leaflet → Protomaps IIFE → 页面 module 按顺序加载；旧 Leaflet ESM 路径不再提供。三层使用同一 dark flavor，maxDataZoom 6 / 10 / 14，区域层设 bounds，无 map maxBounds，minZoom 3 / maxZoom 16。
- 底图先用 Range 读取文件头；使用已安装 Protomaps 导出的 `PmtilesSource` 所提供的 PMTiles 实例包装 `getZxy`，把后续 archive 请求失败转换为提示与空底图 tile，正常 zoom 取消的 AbortError 仍交给 renderer。缺失底图不会阻止 polygon 或选择交互。底图署名与 Census attribution 保留。
- 搜索 Enter 按 exact 优先 / 唯一包含结果选择；列表点击选择并 fit，无 polygon 的 Route 可选但不移动地图。ZIP 点击、Esc / Clear / 空白取消、Fit Station 保留选择；Summary 复用数字 / 时间格式，Pickup Volume 标签不附统计窗口。Coverage 使用 API 计数；Missing 默认折叠并保留两类原因。调色板删除灰色后冻结为 19 色。
- 检查：`npm.cmd test` 240/240 通过；`git diff --check` 通过（Git 输出已有文件的 LF / CRLF 提示，无 whitespace 错误）。项目无 lint / build scripts。新增合成 archive store / HTTP Range、纯状态、Summary 原值与 DOM doubles 测试；RM1 测试只更新本轮有意改变的 UMD 路径、polygon 高亮、Coverage 展示与 Summary 字段预期。
- 临时 Playwright / Chromium 检查使用独立 mock runtime、mock boundary 和有效但不含 tile 内容的合成 PMTiles v3 archive：1440 / 390 无横向滚动，390 侧边栏在地图下方，搜索 / Route 选择 / Fit Station / Esc / Clear / Station 切换 / 触屏 ZIP 点击通过。正常加载每页 20 个同源请求，无外部请求、console / JavaScript / CSP 错误；缺失合成 archive 时提示出现、polygon 保留。临时数据已清理，未访问真实 DMS 或真实 runtime / basemap。
- RM2-AC2 / AC3 / AC4 / AC5 / AC7 / AC8 / AC10 / AC11 已通过上述验证；AC1 的真实道路 / 城市与缩小全景、AC6 的真实 254 / 269 / 15 数量、AC9 的真实底图运行复核留给 Claude 本机验证；AC12 待 Product Owner 预览签字。真实底图视觉与低配设备性能未在合成 archive 中验证。

### RM3 实现记录 — 2026-10-02（Codex）

- boundary store 改读唯一正式来源 `zcta2020_ca_nv_or.*`；沿用 Polygon / MultiPolygon 坐标与 ZIP 唯一性校验，新增 scope 正则、feature_count 一致性校验、`byZip` Map 和 `inScope`。按绝对 geoDir 缓存成功解析的 Promise，失败不缓存；注入 fileOps 的测试读取不缓存。边界文件更新后需重启进程。未修改 geo 文件、依赖、transform 或 route-profiles store。
- `buildRouteMap` 与新增纯函数 `lookupZip` 共享全 Station postal_codes 校验、归属冲突检查及线路概览字段。缺失原因按支持范围分为 no_zcta / not_checked；ZIP 查询返回五种状态、所属 Station / Route、snapshot fetched_at、geometry 与边界来源。新增 GET `/api/route-map/zip?postal_code=`，校验唯一 5 位字符串，复用既有错误映射、响应头和仅状态码日志；map-text 加入固定静态白名单，CSP 未修改。
- `/map` 的中文文案集中在 map-text（含缩放按钮提示）；保留 ZIP / DSP / PPH / Pickup Volume、编号、Source 小字和 attribution。地图使用 grayscale，容器浅色，其余页面深色；palette 保持 19 个与原有顺序、FNV-1a 算法，只调整四个浅色值（旧值 → 新值见 route-colors 注释）。
- 选择状态为 `{ station, route, zip }`；线路与邮编高亮分别使用深色粗边和洋红粗边，无线路 ZIP 使用独立虚线高亮层并保留其他线路原样。高亮层置顶，有线路的高亮层保留 tooltip。无 geometry 不定位或绘制替代图形；跨 Station 查询先加载所属 Station，并避免该加载自动移动地图。
- 面板按当前选择三行、当前邮编卡、线路概览、统一搜索 / 列表、覆盖率、默认折叠 Missing 顺序显示；线路名 26px、核心数字 24px，空值为 `—`。统一搜索保留 exact 优先 / 唯一包含匹配，1–4 位数字显示 5 位 ZIP 提示，5 位数字自动请求 ZIP API（Enter 也可触发）。独立请求序号防止旧 ZIP 响应覆盖新搜索、线路选择、清除或 Station 切换；网络 / API 错误独立显示错误样式和稳定错误码。
- 测试预期仅更新本轮明确改变的边界文件名 / meta、缓存、样式、中文文案、状态结构、面板布局和四个 palette 值。保留原有搜索、归属、空状态、安全 DOM、API 与底图测试；新增 scope / ZIP 索引、五种查询状态、跨 Station、冲突、错误映射、方法限制、请求头、选择转换、高亮层与搜索竞态测试。
- 最终 `npm.cmd test`：243/243 通过；项目无 lint / build scripts。公开 Census 库校验通过（2519 features、索引完整、成功读取复用缓存）。`git diff --check` 通过，仅有已有工作区 LF / CRLF 提示。
- 临时 Playwright / Chromium 检查：真实 Leaflet + mock runtime + 底图 renderer double；1440 / 390 下统一搜索五种状态、线路搜索、概览数字、定位站点、Esc、触屏 ZIP 点击、中文 zoom title 和无横向滚动通过。首轮 console / JavaScript 错误为 0、外部请求为 0；补充轮使用公开 Census 几何和 mock 线路归属验证 95112 / 94604 / 95814 / 94104 / 95812 / 10001，无 pageerror 或外部请求。临时 mock 文件已清理，未访问真实 DMS、运营 runtime 或真实 PMTiles。
- RM3-AC2 / AC3 / AC4 / AC5 / AC6 已在上述范围验证；AC1 / AC8 的真实底图观感、四个颜色可读性与完整底图运行复核，AC7 的真实 SFO01 254 / 269 / 15 结果留给 Claude 本机验证。AC9 的测试部分通过，Product Owner 预览签字仍待完成。

## RM2 — 地图体验与交互升级（**Approved**，Product Owner 2026-10-02 确认并授权实现）

### RM2 已确认的决定（Product Owner 2026-10-02）

| # | 决定 |
|---|---|
| V1 | 底图选 **D：自托管 Protomaps / PMTiles**。不接 OSM 官方 tile，不接第三方商业 tile。以后公司有 Mapbox / Esri / Google Maps 等正式企业授权时再单独评估 |
| V2 | 批准依赖 `protomaps-leaflet`、`pmtiles`，固定版本，由 Claude 安装；Codex 不改依赖。**实际只安装 `protomaps-leaflet@5.1.0`**：它的 `dist/protomaps-leaflet.js` 是自包含 IIFE（全局 `protomapsL`，已内置 pmtiles 3.2.1），单独再装 `pmtiles` 会产生第二个版本且前端用不到，因此未装（Claude 2026-10-02） |
| V3 | 底图分三层，控制体积：美国低 zoom、北加中 zoom、运营区高 zoom；文件放仓库外，不进 Git；生成步骤见下方 “RM2 底图生成” |
| V4 | 必须在地图可见位置保留 OpenStreetMap / Protomaps attribution，不能隐藏 |
| V5 | 删除灰色 `#b3b3b3`，接受一次整体换色。**RM2 之后 palette 视为稳定版本**，不再随意修改 palette 长度 |
| V6 | Route Summary 字段：Route Name、Station、ZIP Count、DSP、Pickup Volume、PPH、Last Updated。Pickup Volume **不得**命名为 Daily Volume / Today Volume 或其他统计窗口（D6 未确认）。底部统一一行 `Source: DMS snapshot · Updated: <timestamp>` |
| V7 | 交互按 R2-3 ~ R2-8 执行（Fit Station、搜索 + 列表、exact 优先、单结果直接选中、选中 Route 自动 fit、其他 Route 约 12–15% opacity、Esc / Clear / 点空白取消、Selected ZIP、触屏 tap、Coverage 卡、Missing 默认折叠） |
| V8 | 前端拆分：`map.js`（编排）、`map-view.js`（Leaflet / 图层 / fit / 地图事件）、`map-panel.js`（搜索 / 列表 / Summary / Coverage）、`map-state.js`（搜索 / 选择 / polygon 样式等纯函数） |
| V9 | 数据层不变：join / coverage / 冲突校验仍在 server；不新增 DMS 抓取 |

### RM2 底图生成（2026-10-02，Claude 在 Product Owner 本机执行）

- 来源：Protomaps 公开每日构建 `https://build.protomaps.com/20261002.pmtiles`（全球，约 138.5 GB，basemap 版本 4.15.2；数据 © OpenStreetMap contributors，ODbL）。构建列表：`https://build-metadata.protomaps.dev/builds.json`。
- 工具：官方 CLI `go-pmtiles` v1.31.2（Windows x86_64，临时工具，放在仓库外 `%LOCALAPPDATA%\nc-ops-console\tools\`，不进 Git，不加入 `package.json`）。`pmtiles extract` 通过 HTTP Range 只下载所需部分。
- 命令（`--dry-run` 可先估算大小）：

  ```text
  pmtiles extract https://build.protomaps.com/20261002.pmtiles us.pmtiles     --bbox=-125.0,24.0,-66.5,49.5   --maxzoom=6
  pmtiles extract https://build.protomaps.com/20261002.pmtiles norcal.pmtiles --bbox=-124.6,35.5,-119.0,42.5  --maxzoom=10
  pmtiles extract https://build.protomaps.com/20261002.pmtiles ops.pmtiles    --bbox=-123.16,36.43,-121.06,39.01 --maxzoom=14
  ```

  `ops` 的 bbox = `geo/zcta2020_sfo01.geojson` 的范围外扩约 0.15°；`norcal` 包含 Reno（RNO01）和 Medford（MFR01）。
- 结果（`<runtime>/basemap/`，即默认 `%LOCALAPPDATA%\nc-ops-console\runtime-data\basemap\`）：

  | 文件 | 范围 | zoom | 大小 |
  |---|---|---|---|
  | `us.pmtiles` | 美国本土 | 0–6 | 4.7 MB |
  | `norcal.pmtiles` | 北加 + Reno + Medford | 0–10 | 11.6 MB |
  | `socal.pmtiles` | ????bbox `-121.5,32.4,-114.0,35.6`??? `20261028` | 0?10 | 6.1 MB |
  | `mountain.pmtiles` | CO / WY / ID / UT / NM / MT 区域；bbox `-116.5,34.0,-103.0,47.0`；构建 `20261002` | 0–10 | 33.8 MB |
  | `pnw.pmtiles` | WA + OR；bbox `-124.9,42.0,-116.4,49.1`；构建 `20261028` | 0–10 | 22 MB |
  | `az.pmtiles` | AZ；bbox `-115.0,31.2,-108.8,37.4`；构建 `20261028` | 0–10 | 9.3 MB |
  | `hawaii.pmtiles` | ????bbox `-160.6,18.8,-154.7,22.4`??? `20261028` | 0?10 | 0.9 MB |
  | `ops.pmtiles` | SFO01 运营区 | 0–14 | 125.2 MB |

  合计约 197 MB。所有文件均为 PMTiles spec v3、tile type `mvt`。超过各层最大 zoom 时由前端 overzoom 显示。
- 更新：需要更新底图（例如几个月一次，或新增运营区）时，换成新的构建日期重新执行上面的命令，并更新本表。新增 Station 时扩大或新增 `ops` 层的 bbox。

目标：把 RM1 的“深色背景 + polygon”升级为带地理参照的运营地图。**不扩展数据层，不新增 DMS 抓取**；RM1 的 join / coverage / missing / 冲突校验保持在 server 端不变。

### R2-1 底图方案

| 方案 | 运行时外部请求 | CSP | 使用政策 / 成本 | 适合公司内部长期使用 |
|---|---|---|---|---|
| A. OSM 官方 `tile.openstreetmap.org` | 有（每次 pan / zoom 都请求 OSM 服务器） | 需放宽 `img-src` | OSM Tile Usage Policy：志愿者资源，**不适合作为应用的长期生产底图**，有流量限制；必须署名 | **否**（只能临时开发用） |
| B. 免费层托管服务（CARTO basemaps、Stadia Maps） | 有 | 放宽 `img-src` 到一个域名 | CARTO 免费层仅限非商业用途，商业使用需企业授权；Stadia 免费层面向非商业 / 开发，商业用途需付费计划（以各家最新条款为准） | 需要确认授权，**公司运营用途通常属于商业使用** |
| C. 商业托管服务 + API key（MapTiler、Mapbox、Esri 等） | 有 | 放宽 `img-src`（矢量方案还需 `connect-src`） | 付费或有额度的商业授权；key 会出现在浏览器中，需要按域名 / referrer 限制 | 可以，前提是公司有账号和授权 |
| **D. 自托管 Protomaps（PMTiles 单文件矢量底图）** | **无**（底图文件由本地 server 提供） | **不放宽**（全部 `'self'`） | 数据来自 OpenStreetMap，ODbL 许可，**必须显示 “© OpenStreetMap contributors”**；无调用费用 | **可以**，并且不向第三方暴露查看位置 |

**推荐：D（自托管 PMTiles）作为默认方案；如果公司已有地图服务授权（例如 Google Maps Platform、Mapbox、Esri），优先用公司授权的 C。** 理由：D 保留 RM1 的“零外部请求、CSP 不放宽”，也没有第三方使用政策风险；C 适合以后多人 / 部署场景。A、B 不作为长期方案。

D 的实现要点：
- 新增 npm 依赖 `protomaps-leaflet`（在 Leaflet 中渲染矢量底图）和 `pmtiles`（读取 PMTiles），版本固定；需要 Product Owner 批准。
- 底图文件：从 Protomaps 公开构建中用 `pmtiles extract` 截取两部分——**全美低缩放层**（约 z0–z8，用于缩小到 California / USA）和**服务区高缩放层**（北加 + Reno 一带，约到 z14 / z15）。文件放在仓库外的 runtime 目录（预计几十到几百 MB，实际大小截取后确认），**不进 Git**；下载需要联网，由 Claude 在本机执行。
- server 提供底图：`GET /basemap/<name>.pmtiles`，需要支持 HTTP Range 请求（PMTiles 按字节范围读取）；读取通过新的 store 模块，路径不暴露给前端。
- 样式：使用 Protomaps 提供的浅色或深色主题。Route polygon 叠加在上面，降低底图饱和度，让当前 Station 仍是视觉焦点。
- 署名：地图右下角显示 “© OpenStreetMap contributors · Protomaps · Boundaries: US Census 2020 ZCTA”。

### R2-2 CSP / 署名 / 隐私

- D：CSP 不变；没有任何外部请求；隐私影响为零。署名必须显示（ODbL）。
- C：CSP 只为一个服务商域名放宽 `img-src`（矢量方案加 `connect-src`）；浏览器会把查看的地图范围和 IP 发给服务商（不包含业务数据）；API key 用 `.env` 配置，经 server 传给前端，并在服务商后台按 referrer 限制。
- 两种方案都要更新 RM-AC6（“没有外部请求”只对 D 继续成立）。

### R2-3 Station 自动定位 / Fit Station

- 加载和切换 Station 时：`fitBounds(当前 Station 所有 polygon, padding)`。
- 地图左上角加 “Fit Station” 按钮（Leaflet 自定义 control，键盘可操作）：一键回到当前 Station 全景，同时保留当前选择。
- 允许自由 pan / zoom；`minZoom` 允许缩小到能看到美国全境（约 z3–z4），不设 `maxBounds`；不会默认显示整个世界。

### R2-4 Route 选中高亮

- 选择状态：`{ selectedRouteId, selectedZip }`。点 ZIP → 选中该 ZIP 和它所属的 Route；在 Route 搜索 / 列表中点 Route → 只选中 Route。
- 样式由纯函数 `polygonStyle(feature, selection)` 计算（便于测试）：
  - 无选择：所有 Route 正常（填充约 0.6–0.7，细边界）。
  - 有选择：当前 Route 正常颜色、填充不变、边界明显加粗（例如 3px 白色或高对比描边）；其他 Route 填充降到约 0.12–0.15、边界变淡。
  - 选中的 ZIP 在当前 Route 之上再加一层强调描边。
- 取消选择：点地图空白处、按 Esc，或点 “Clear selection”。
- `routeColor` 不变（除下面 R2-9 移除灰色）。

### R2-5 Route 搜索 + 定位（与 Route 列表合并为一个组件）

- 侧边栏顶部一个搜索框，下面是可滚动的 Route 列表；输入时**过滤列表**（不区分大小写的包含匹配）。
- 按 Enter：完全匹配（不区分大小写）优先；否则只剩一条包含匹配时选中它；多条时保持列表让用户点；0 条显示 “No matching route”。
- 选中 Route：高亮整条 Route、`fitBounds` 到该 Route 的 polygon、面板显示 Route Summary。
- 某条 Route 的 ZIP 全部没有 polygon（`mapped_count = 0`）时：仍可选中，面板说明 “No mapped boundary for this route”，不移动地图。
- 不引入模糊搜索库。

### R2-6 Route / ZIP 面板数据

`GET /api/route-map?station=` 的 `routes[]` 扩展（由 server 组装时从 Route Profile 行直接带出，不新增 DMS 抓取、不新增 API 调用）：

```text
routes: [ { route_id, route_name, station, zip_count, mapped_count,
            dsp_name, pickup_volume, pph } ]          // 已有字段直接复用
fetched_at                                            // 已有，作为 Last Updated
```

- 面板分两块：
  - **Route Summary**：Route Name、Station、ZIP Count（含 “mapped X”）、DSP、Pickup Volume、PPH、Last Updated。空值显示 `—`。数字格式复用 `web/format.js`（Pickup Volume 整数千分位，PPH 两位小数）。
  - **Selected ZIP**：ZIP、Route、Station（只在点了 ZIP 时显示）。
- 不显示 Difficulty（本轮不做），不加颜色含义。

### R2-7 Coverage 状态卡

```text
Coverage
94.42%
254 / 269 ZIP mapped
15 without Census ZCTA · 0 need boundary regeneration
```

- `not_checked > 0` 时第二行用警示样式。
- Missing Boundary ZIP 清单默认折叠（`<details>`，标题带数量），展开后表格同 RM1，仍区分 `no_zcta` / `not_checked`。不伪造 polygon。

### R2-8 Route 列表是否第一版一起做

**建议一起做**，而且和搜索合并成一个组件（R2-5）：每行一个颜色块（与地图同色）+ Route Name + ZIP 数；点击 → 高亮 + fit；当前选中行有明显状态；51 行可滚动，不做排序 / 分组。成本低，并且解决“颜色重复时靠什么认 Route”的问题。

### R2-9 颜色

- 从调色板移除中性灰 `#b3b3b3`（变成 19 色）。`routeColor` 仍是 FNV-1a hash 取模、只依赖 `route_id`、不写入数据。
- 注意：调色板长度变了，**所有 Route 的颜色会整体变化一次**；之后刷新数据仍保持稳定。
- 有底图后，调色板需要在所选底图主题上检查可辨识度（必要时只调整颜色值，不改 hash 规则）。

### R2-10 需要修改的文件（建议）

- server：
  - `server/src/route-map/route-map.js`：`routes[]` 增加 `station / dsp_name / pickup_volume / pph`（行为其余不变）。
  - D 方案：新增 `server/src/store/basemap-file.js`（定位、校验底图文件）、静态 / Range 响应支持 `GET /basemap/*.pmtiles`、白名单新增 `protomaps-leaflet` / `pmtiles` 的 ESM 文件。
  - 测试：`route-map.test.js`（新字段）、API、Range 请求、静态白名单。
- web（代码健康：`web/map.js` 已有 134 行，这轮功能会让它翻倍，建议拆分）：
  - `web/map.js`：页面编排（加载、Station 切换、事件分发）。
  - `web/map-view.js`：Leaflet 地图、底图、polygon 图层、fit、高亮样式应用。
  - `web/map-panel.js`：Route 搜索 / 列表、Route Summary、Selected ZIP、Coverage 卡、Missing 折叠清单。
  - `web/map-state.js`：纯函数——`polygonStyle`、`searchRoutes`、选择状态更新。
  - `web/route-colors.js`：移除灰色。
  - `web/styles.css`、`web/map.html`：布局调整。
- 不改：transform、route-profiles store、boundary store、`/api/route-profiles`、Route Profile 页面。

### R2-11 验收标准（草案）

- **RM2-AC1** `/map` 显示底图（道路 / 城市 / 区域可见），Route polygon 覆盖在上面；可以自由 pan / zoom，缩小时能看到 California / USA。
- **RM2-AC2** 打开页面和切换 Station 时自动 fit 到当前 Station；“Fit Station” 按钮一键回到当前 Station 全景。
- **RM2-AC3** 选中 ZIP 或 Route 后：当前 Route 保持原色、边界明显加粗，其他 Route 明显变淡；取消选择后全部恢复。
- **RM2-AC4** 搜索 `SFO01-023`：定位并高亮该 Route，面板显示其信息；包含匹配可用；无结果显示 “No matching route”。
- **RM2-AC5** Route Summary 显示 Route Name / Station / ZIP Count / DSP / Pickup Volume / PPH / Last Updated，数据来自一次 `/api/route-map` 响应，空值 `—`；Selected ZIP 显示 ZIP / Route / Station。
- **RM2-AC6** Coverage 卡显示百分比、`254 / 269 ZIP mapped`、`no_zcta` / `not_checked` 计数；Missing 清单默认折叠，展开后 15 行。
- **RM2-AC7** Route 列表：颜色与地图一致；点击高亮 + fit；选中状态明显。
- **RM2-AC8** 调色板没有中性灰；`routeColor` 稳定、与顺序无关、不写入数据。
- **RM2-AC9** 底图满足所选方案的约束：D 方案下没有任何外部请求、CSP 不变、署名完整；C 方案下只请求批准的一个服务商域名。console 无错误 / CSP 报错。
- **RM2-AC10** join / coverage / missing / 冲突校验仍在 server 端；前端只请求 `/api/route-map/stations` 和 `/api/route-map`（加底图文件）。现有页面和 API 行为不变，`npm test` 全部通过。
- **RM2-AC11** 1440 / 390 均可用（390 时侧边栏在地图下方、搜索和列表可用），触屏不依赖 hover。
- **RM2-AC12** Product Owner 本机预览签字。

### R2-12 风险 / 未决问题

1. **底图方案选择**：D（自托管，推荐）还是 C（公司已有授权的服务商）？公司是否已有地图服务授权？
2. **D 方案的新依赖**：`protomaps-leaflet`、`pmtiles` 需要批准；底图文件大小和更新方式（多久重新截取一次）需要在截取后确认。
3. **D 方案的渲染性能**：Leaflet 中渲染矢量底图（canvas）在低配电脑上可能比栅格底图慢，需要实测。
4. **颜色整体变化一次**（移除灰色导致）。
5. **底图上的颜色可辨识度**：叠加在底图上后部分浅色可能不清楚，需要实测调整。
6. **Route Summary 的字段口径**：Pickup Volume、PPH 是 T3 snapshot 中的 Route 级原值（Pickup Volume 统计窗口仍是 D6 未决问题），面板上需要标明数据来自 DMS snapshot。

### RM2 本机真实验证（2026-10-02，Claude 在 Product Owner 本机运行）

- `npm test` 240/240 通过；`git diff --check` 通过。依赖：`leaflet@1.9.4`、`protomaps-leaflet@5.1.0`（Claude 安装，固定版本）。
- 底图接口：`/basemap/ops.pmtiles` Range `bytes=0-7` → 206（8 字节）、`bytes=-16` → 206、越界 → 416；`us.pmtiles` 全文件 → 200；`world.pmtiles` → 404。下载中途断开 20 次后 server 仍正常（`/api/health` 200，日志无错误）。
- 无界面 Chromium，真实底图 + 真实 SFO01 数据：
  - **首次加载（1440）**：polygon 出现约 0.44 s，网络空闲约 1.2 s；首屏底图 23 次 Range 请求、约 0.72 MB。整轮操作（搜索、缩放到最小、Fit Station）累计 77 次底图请求、约 3.6 MB。390 宽首屏约 1.0 s、0.33 MB。
  - **没有任何外部请求**（全部是 `http://127.0.0.1:3000/`）；console 无 error / warning，无 CSP violation。
  - 底图显示城市 / 道路 / 水系；Route polygon 覆盖在上面；254 个 polygon；缩小到最小 zoom 可见北美全境（`noWrap`，-180° 以西为空白）。
  - Attribution 可见：`Leaflet | Boundaries: US Census 2020 ZCTA, Protomaps © OpenStreetMap`。
  - 打开即自动 fit 到 SFO01；缩小后点 “Fit Station” 回到 Station 全景。
  - 搜索 `sfo01-023` + Enter：定位到该 Route（6 个 ZIP），6 个 polygon 原色 + 加粗描边，其余 248 个 fill 降到约 0.14；Route Summary：`SFO01-023 / SFO01 / 6 (6 mapped) / SFO-WZS / Pickup Volume 1,605 / PPH 28.79 / Last Updated 2026-10-02 12:12 PDT`，底部 `Source: DMS snapshot · Updated: …`。输入 `zzz` 显示 “No matching route”。Esc 清除后没有淡化的 polygon。
  - hover tooltip 与 click / 触屏 tap 的 Selected ZIP 面板正常。
  - Coverage 卡：`94.42%`、`254 / 269 ZIP mapped`、`15 without Census ZCTA · 0 need boundary regeneration`；Missing 清单默认折叠。
  - 1440 / 390 均无页面横向滚动。
- 待 Product Owner 预览签字（RM2-AC12）。

---

## RM3 — 浅色地图、中文 UI、线路概览、线路 / 邮编统一搜索（**Approved**，Product Owner 2026-10-02 确认并授权实现）

### RM3 已确认的决定（Product Owner 2026-10-02）

| # | 决定 |
|---|---|
| X1 | 底图主题先用 **`grayscale`**；实际观感不好再单独调整 |
| X2 | 采用 **CA + NV + OR 服务区边界库**（2,519 个 ZCTA，12.5 MB），**放进 Git**。已由 Claude 生成：`geo/zcta2020_ca_nv_or.geojson` + `.meta.json`，SFO01 的 254 个 polygon 与旧文件逐个一致 |
| X3 | 删除旧的 `zcta2020_sfo01.geojson` / `.meta.json`（已由 Claude 删除）及只服务于单站点边界方案的相关内容；边界库是唯一正式来源 |
| X4 | 允许调深在 grayscale 底图上过淡的颜色（浅黄、浅绿、浅粉等）。**palette 长度保持 19，`routeColor` 算法不变**，不增删颜色；调整后截图检查可读性 |
| X5 | `/map` 全部中文化；ZIP、DSP、PPH、Pickup Volume、Route / Station 编号、attribution 保持原样 |
| X6 | 线路概览按 R3-3 新布局 |
| X7 | 统一搜索“搜索线路或邮编”，规则按 R3-4；邮编搜索支持五种状态 |
| X8 | 新增 `GET /api/route-map/zip?postal_code=`，状态判断、归属、线路概览、geometry、`no_zcta` / `not_checked` 都在 server 端 |
| X9 | 选中邮编用明显粗边；有线路 / 无线路视觉可区分；无线路不得表现成搜索失败 |
| X10 | 选择状态 `{ station, route \| null, zip \| null }`，规则按 R3-7；“当前选择”区域分别显示站点 / 线路 / 邮编 |
| X11 | RM1 / RM2 功能全部保留（R3-9 RM3-AC8） |

范围：UI 和搜索体验。Route-ZIP 数据层（DMS → transform → route-profiles store）不变；边界数据为了支持“无线路 ZIP”需要扩大（R3-5）。RM1 / RM2 的功能全部保留。

### R3-1 浅色底图

- protomaps-leaflet 内置 flavor：`light`、`white`、`grayscale`、`dark`、`black`。**推荐 `grayscale`（浅灰、低饱和）**：道路 / 城市仍清楚，Route 颜色最突出；备选 `light`（带淡彩色）。只改 `BASEMAP_FLAVOR` 常量和 polygon 样式，PMTiles 文件不用重新生成。
- 页面其余部分保持深色；地图容器背景改为浅色，与底图一致。
- polygon 样式在浅底图上重新定（纯函数 `polygonStyle`）：

  | 状态 | 填充 | 描边 |
  |---|---|---|
  | 无选择 | Route 色，fill ≈ 0.5 | 深灰 `#334155`，1px |
  | 选中线路（当前线路） | Route 色，fill ≈ 0.65 | 近黑 `#0f172a`，3px |
  | 选中线路时的其他线路 | Route 色，fill ≈ 0.12 | 灰，opacity ≈ 0.35 |
  | 选中邮编（有线路） | 保持线路样式 | **强调色（例如洋红 `#db2777`）5px**，置于最上层 |
  | 选中邮编（无线路） | 无 Route 色，浅强调色填充 ≈ 0.15 | 同上强调色 5px，**虚线**（区分“无线路”） |
  | hover | 不改填充 | 白色内描边 / 加粗 2px |

- palette 按 V5 冻结，不改长度。浅色调色板中有几种很淡的颜色（例如 `#ffffb3`、`#ffed6f`、`#ccebc5`、`#fccde5`），在浅灰底图上靠深色描边区分；如果实测仍不清楚，可以只**调深这几个颜色的值**（长度不变，只有用到这几个颜色的 Route 会换色）——这需要 Product Owner 另行同意（R3-12）。
- tooltip 保持深色背景、浅色文字，对比度不受底图影响。

### R3-2 中文 UI 范围

- 只改 `/map` 页面面向用户的文字（`<html lang="zh-CN">`），Route Profile 页面不在本轮。
- 文字集中在一个小的字符串表（例如 `web/map-text.js`），不引入 i18n 框架。
- 保持原样：Route ID、ZIP、DSP、PPH、Pickup Volume（D6 未确认，不翻译成具体统计口径）、线路编号（SFO01-023）、站点代码、数据集名称、attribution。
- 对照（节选）：Routes → 线路；Search → 搜索线路或邮编；Fit Station → 定位站点；Clear selection → 清除选择；Route Summary → 线路概览；Selected ZIP → 当前邮编；Coverage → 地图覆盖率；Missing Boundary ZIP → 缺少边界的邮编；Last Updated → 更新时间；No matching route → 未找到匹配线路；`no_zcta` → 无 Census ZCTA；`not_checked` → 边界数据未覆盖（需重新生成）；Loading → 加载中；错误提示同步中文。

### R3-3 线路概览（Route Summary）新布局

```text
┌ 线路概览 ─────────────────────────┐
│ SFO01-023                    （大字，约 24–28px） │
│ 站点 SFO01 · DSP SFO-WZS                         │
│ ┌ ZIP 数 ┐ ┌ Pickup Volume ┐ ┌ PPH ┐            │
│ │ 6      │ │ 1,605         │ │ 28.79 │（大数字）│
│ │已上图 6│ └───────────────┘ └───────┘          │
│ 更新时间 2026-10-02 12:12 PDT                     │
│ Source: DMS snapshot（小字）                      │
└──────────────────────────────────┘
```

- 数据仍来自一次 `/api/route-map` 响应（RM2 已带出字段），空值 `—`，Pickup Volume 只叫 “Pickup Volume”。

### R3-4 统一搜索：“搜索线路或邮编”

- 输入规则（`map-state.js` 纯函数 `classifyQuery`）：
  - 恰好 5 位数字 → **邮编搜索**（按 Enter，或输满 5 位时触发）。
  - 其他 → **线路搜索**（RM2 规则不变：完全匹配优先、包含匹配、多结果列表、无结果“未找到匹配线路”）。输入时实时过滤线路列表。
  - 1–4 位纯数字：按线路包含匹配过滤列表（线路名含数字，例如 `023`），同时提示“输入完整 5 位邮编可搜索邮编”。
- 邮编搜索结果分 5 种状态（由 server 判定，见 R3-6）：

  | 状态 | 条件 | 地图 | 右侧 |
  |---|---|---|---|
  | `covered` 有线路覆盖 | ZIP 在某个 Station 的某条 Route 中，且有 polygon | fit 到该 ZIP，强调色描边；同时选中所属线路（其他线路淡化） | 当前邮编卡（徽标“有线路覆盖”）+ 线路概览 |
  | `covered_no_boundary` 有线路但无边界 | 在某条 Route 中，但没有 ZCTA | 不移动地图；选中所属线路 | “有线路覆盖 · 该 ZIP 暂无可用边界数据” + 线路概览 |
  | `uncovered` 当前无线路覆盖 | 不在任何 Route 中，但有 ZCTA | fit 到该 ZIP，虚线强调色 + 浅填充；其他线路保持正常显示 | 当前邮编卡（徽标“当前无线路覆盖”），不显示线路概览 |
  | `no_boundary` 暂无边界数据 | 不在任何 Route 中，且边界库里没有 | 不移动地图，不画任何 polygon | “该 ZIP 暂无可用边界数据（可能是 PO Box / 机构 ZIP，或不是有效 ZIP）” |
  | `out_of_range` 超出支持范围 | ZIP 不在边界库覆盖的前缀范围内（R3-5） | 不移动地图 | “该 ZIP 不在当前支持的地图范围内（CA / NV / OR）” |

- 不运行时访问任何第三方服务（不做地理编码 API）。
- “暂无边界数据”与“系统出错”分开显示：网络 / API 错误用错误样式和错误码，不会显示成 `no_boundary`。

### R3-5 无线路 ZIP 的数据来源和 ZCTA 范围

- 现有 `geo/zcta2020_sfo01.geojson` 只有 SFO01 的 254 个 ZCTA，无法搜索无线路的 ZIP。
- **推荐：建立一个“服务区边界库”**，按 ZIP 前缀从同一份 Census 2020 ZCTA 1:500k 截取：
  - 范围：**CA（90–96）+ NV（889–898）+ OR（97）**。规则简单、可重复；覆盖全部现有和 legacy Station（含 Reno、Medford）。
  - 实测：**2,519 个 ZCTA，GeoJSON 12.5 MB**（gzip 约 3.9 MB）。对比：只做北加 + NV 为 1,282 个、6.8 MB，但会漏掉 Medford（OR）。
  - 文件：`geo/zcta2020_ca_nv_or.geojson` + `.meta.json`（记录 dataset、vintage、前缀规则、feature 数、生成时间）。
  - 不进前端：边界库只在 server 端读取（boundary store），前端只拿当前 Station 的 polygon（与现在相同，约 0.86 MB）和单个搜索结果的 geometry。
- **边界库取代 `zcta2020_sfo01.geojson`**：Route Map 的 Station polygon 也从边界库里取，解决“按 Station 命名的边界文件”问题（RM1 风险 3），新增 Station 时不用重新截取。
  - 缺失分类随之简化：ZIP 在支持前缀内但边界库没有 → `no_zcta`（边界库对这些前缀是完整的，所以就是 Census 确认没有）；ZIP 不在支持前缀内 → `not_checked`（需要扩大边界库范围）。API 字段不变。
  - 旧文件 `zcta2020_sfo01.*` 改为删除还是保留作历史，见 R3-12。
- 不做 ZIP 点位 / 地理编码；`no_boundary` 只显示说明。

### R3-6 API 扩展

- 新增 `GET /api/route-map/zip?postal_code=95112`：
  - 400 `invalid_postal_code`（不是 5 位数字）。
  - 200 `{ postal_code, status, station, route_id, route_name, route: <与 routes[] 相同的线路概览字段> | null, geometry: <GeoJSON geometry> | null, boundary_source }`，`status` 为 R3-4 的五种之一。
  - 判定在 server 端纯函数 `lookupZip({ profiles, boundaries, postalCode })` 中完成，复用 `postal-codes.js` 的校验；跨所有 Station 查找归属（目前只有 SFO01）。
- `GET /api/route-map?station=` 不变，但 polygon 改从边界库取。
- 前端不做 join：有线路时用已加载的 Station polygon 高亮；无线路时把返回的 `geometry` 画成单独的高亮图层。

### R3-7 选择状态和层级

- 状态模型（`map-state.js`）：`{ station, route: { route_id } | null, zip: { postal_code, status, geometry? } | null }`。
  - 点线路（列表 / 线路搜索）→ 设置 route，清除 zip。
  - 点地图上的 ZIP 或邮编搜索 `covered` → 设置 zip 和它所属的 route。
  - 邮编搜索 `uncovered` / `no_boundary` / `out_of_range` → 设置 zip，route 为 null（不淡化其他线路）。
  - 清除选择 / Esc / 点空白 → 全部清除；切换站点 → 全部清除并定位站点。
- 右侧顶部固定一个“当前选择”块，三行分开显示：**站点** SFO01 / **线路** SFO01-023 或 — / **邮编** 95112 或 —（邮编后带状态徽标）。下面依次是：当前邮编卡（有邮编时）、线路概览（有线路时）、线路搜索与列表、地图覆盖率、缺少边界的邮编（折叠）。
- 邮编高亮（强调色）与线路高亮（深色加粗）视觉上可区分；两者可以同时存在。

### R3-8 文件改动（建议）

- 数据：新增 `geo/zcta2020_ca_nv_or.geojson`、`geo/zcta2020_ca_nv_or.meta.json`；更新 `geo/README.md`（生成步骤、前缀规则）。生成由 Claude 在本机用 mapshaper 执行（与 TBL3 相同方法）。
- server：`store/boundaries-file.js`（读边界库 + 新 meta 校验）、`route-map/route-map.js`（从边界库 join；缺失分类调整；新增 `lookupZip`）、`api/app.js`（新增 `/api/route-map/zip`）、`api/server.js`。
- web：`map-text.js`（新增，中文字符串）、`map-state.js`（`classifyQuery`、新状态模型、`polygonStyle` 浅色版本、邮编高亮样式）、`map-view.js`（flavor、搜索结果高亮图层、fit 到 ZIP）、`map-panel.js`（当前选择块、当前邮编卡、线路概览新布局、中文）、`map.js`（统一搜索编排）、`map.html`、`styles.css`。
- 测试：boundary 库校验、`lookupZip` 五种状态、新 API、`classifyQuery`、选择状态转换、`polygonStyle`、面板 DOM doubles（中文文字、状态徽标、无线路 ZIP 的高亮图层）。

### R3-9 验收标准（草案）

- **RM3-AC1** 地图区域为浅色 / 浅灰底图，页面其余保持深色；浅色线路在底图上可辨认（有深色描边）；tooltip 对比度正常。
- **RM3-AC2** `/map` 面向用户的文字为中文；ZIP / DSP / PPH / Pickup Volume / 线路编号等保持原样。
- **RM3-AC3** 线路概览：线路名和核心数字明显放大；字段齐全；Source 小字保留；Pickup Volume 未改名。
- **RM3-AC4** 搜索框“搜索线路或邮编”：输入 `SFO01-023` 定位线路（RM2 行为保留）；输入 5 位 ZIP 触发邮编搜索。
- **RM3-AC5** 邮编搜索五种状态都正确显示（例子已用 2026-10-02 的 SFO01 数据和候选边界库核实）：
  - `covered`：`95112`（SFO01-013）定位并高亮，显示“有线路覆盖”和线路概览；
  - `covered_no_boundary`：`94604`（SFO01-001，无 ZCTA）显示“有线路覆盖 · 该 ZIP 暂无可用边界数据”；
  - `uncovered`：`95814`（Sacramento）、`94104`（San Francisco 市中心，不在 SFO01 线路中）仍定位并以虚线高亮，显示“当前无线路覆盖”；
  - `no_boundary`：`95812`（无线路、无 ZCTA）显示“暂无可用边界数据”；
  - `out_of_range`：`10001` 显示“不在当前支持的地图范围内”。
  - 没有伪造 polygon。
- **RM3-AC6** 邮编高亮与线路高亮可区分；“当前选择”块分别显示站点 / 线路 / 邮编。
- **RM3-AC7** 边界库只在 server 端读取；`/api/route-map` 的 Station 结果仍为 254 polygon / 269 total / 15 missing（`no_zcta`）。
- **RM3-AC8** RM1 / RM2 功能保留：定位站点、线路列表、线路选中淡化、hover / click / tap、地图覆盖率、缺少边界的邮编、本地 PMTiles、0 第三方请求、CSP 不变、1440 / 390 布局。
- **RM3-AC9** `npm test` 全部通过；Product Owner 预览签字。

### R3-10 风险 / 未决问题

1. **边界库放哪里**：放进仓库（12.5 MB，Census 十年才更新一次，克隆后即可使用）还是放 runtime 目录（不进 Git，但新环境要多一步生成）？推荐进仓库。
2. **旧的 `zcta2020_sfo01.*` 文件**：边界库取代它之后，删除（Git 历史可找回）还是保留？推荐删除，避免两份边界不一致。删除文件需要 Product Owner 同意。
3. **浅色调色板**：部分浅色在浅灰底图上偏淡；先用深色描边解决，若仍不清楚，是否允许调深个别颜色值（会让少数 Route 换色）？
4. **`no_boundary` 无法区分“不存在的 ZIP”和“PO Box ZIP”**：没有 USPS 官方 ZIP 列表时只能统一提示。
5. **底图主题**：`grayscale` 还是 `light`，建议实现后两种各截一张图给 Product Owner 选（只改一个常量）。
6. **server 内存**：边界库 12.5 MB 解析后常驻内存，本机单用户场景可接受。

### RM3 本机真实验证（2026-10-02，Claude 在 Product Owner 本机运行）

- `npm test` 243/243 通过；`git diff --check` 通过；依赖和 `geo/` 未被 Codex 修改；`web/` 无 `innerHTML`。palette 仍为 19 色，4 个浅色调深（`#ffffb3→#c4a62a`、`#fccde5→#d875a8`、`#ccebc5→#71ad68`、`#ffed6f→#d9b52c`），`routeColor` 算法不变。
- API：`/api/route-map?station=SFO01` 仍为 `total 269 / mapped 254 / missing 15（全部 no_zcta）`，254 个 feature（来自 CA+NV+OR 边界库）。`/api/route-map/zip`：`95112 → covered（SFO01-013，Polygon）`、`94604 → covered_no_boundary（SFO01-001，geometry null）`、`95814 / 94104 → uncovered（Polygon）`、`95812 → no_boundary`、`10001 → out_of_range`、`abc → 400 invalid_postal_code`。
- 无界面 Chromium（1440 / 390 + 触屏），真实底图 + 真实数据：
  - `lang="zh-CN"`，面向用户的文字为中文；ZIP / DSP / PPH / Pickup Volume / 线路编号 / attribution 保持原样。
  - grayscale 底图明亮，城市 / 道路清楚；254 个 polygon；调深后的颜色在浅灰底图上可辨认（深色描边）。
  - 线路搜索 `SFO01-023`：定位并高亮；线路概览大字：`SFO01-023`、`站点 SFO01 · DSP SFO-WZS`、`ZIP 数 6（已上图 6）/ Pickup Volume 1,605 / PPH 28.79`、`更新时间 …`、`Source: DMS snapshot`。输入 `023` 显示提示“输入完整 5 位邮编可搜索邮编”。
  - 邮编五种状态：`95112` 有线路覆盖（洋红实线粗边 + 所属线路深色粗边 + 线路概览）；`94604` “有线路覆盖 · 该 ZIP 暂无可用边界数据”；`94104` “当前无线路覆盖”（洋红虚线 + 浅粉填充，其他线路不淡化）；`95812` “暂无可用边界数据（可能是 PO Box / 机构 ZIP，或不是有效 ZIP）”；`10001` “不在当前支持的地图范围内（CA / NV / OR）”。“当前选择”三行（站点 / 线路 / 邮编 + 状态徽标）随状态正确变化。
  - 首次加载约 1.2–1.3 s；**没有任何外部请求**；console 无 error / warning，无 CSP violation；1440 / 390 无页面横向滚动。
- 发现的布局问题（设计层面，未修改）：搜索框位于“当前选择 / 当前邮编 / 线路概览”之后，选中后这些卡片展开会把搜索框推到首屏以下（390 宽时需要来回滚动）。建议把搜索框移到侧边栏顶部，待 Product Owner 决定。
- 待 Product Owner 预览签字（RM3-AC9）。

---

## RM4 — 收口：彩色底图（**Approved**，Product Owner 2026-10-02）

- 底图 flavor 由 `grayscale` 改为 protomaps-leaflet 的 **`light`**（自然、柔和的彩色道路地图）。只改 `BASEMAP_FLAVOR` 常量和必要的 polygon / 高亮样式微调；PMTiles 文件不变。
- 保留 RM1–RM3 全部功能；不改数据层，不新增地图功能。
- 已知未处理：搜索框位于侧边栏卡片之后，选中后会被推到首屏以下（RM3 验证记录）。按 Product Owner “收口、不再扩功能” 的要求本轮不改。

### RM4 实现记录（Implementation Notes，2026-10-02）

- `BASEMAP_FLAVOR` 改为 `light`，地图容器使用浅色背景。保留既有 polygon / 无线路 ZIP 样式数值、19 色 palette、选择状态、搜索、tooltip 和 RM1–RM3 行为；未改数据层或 PMTiles。
- route-map-web 更新底图 flavor 断言为 `light`，map-state 直接验证常量及既有选中线路、ZIP、淡化和虚线样式；`npm.cmd test` 244/244 通过，`git diff --check` 通过。
- 未读取真实 runtime 或底图文件；彩色底图上的实际观感复核及 Product Owner 预览签字待 Claude / Product Owner 完成。

### RM4 本机验证（2026-10-02，Claude）

- `npm test` 244/244；`git diff --check` 通过。`/map` 使用 `light` 彩色底图（海洋蓝、绿地、浅色道路），Route polygon 仍是视觉重点；选中线路、选中 ZIP（洋红实线）、无线路 ZIP（`94104` 洋红虚线 + 浅粉填充）均清楚；1440 / 390 正常；**无外部请求**，console 无 error，无 CSP violation。

---

## RM5 — 难易度颜色模式（**Approved**，Product Owner 2026-10-05；前置条件已满足，**开始实现**）

> 2026-10-05：RD3 / RD4 全量完成。DMS 当前 SFO01 列表的 36 条 Route 全部有 Route Detail cache（含 `pickup_volume_daily`，175 个 ZIP，无 parse_errors）。Product Owner 指示开始 RM5，地图沿用现有 `route-profiles.json` 快照（不重新抓取）。快照中不在 detail cache 里的 Route，按 RM5-7 显示“暂无 ZIP 难度数据”。

> Product Owner 2026-10-05 决定：RM-Q2 → 选中线路后，其他线路保持各自的 Route 难度颜色并淡化，不变灰（即 RM5-4 表）。RM-Q1 → 本轮同时把 Route Profile 页面（主表的线路难度标签、Route Detail modal 的线路 / ZIP 难度）统一为同一套五色（RM5-6 表），人工难度列本轮不改；只改显示颜色，不加入人工难度逻辑，不改任何数据。

> 本节取代第 1 节“不做：Difficulty”和 W7“颜色只表示 Route”这两项，仅在“按难易度”模式下生效。“按线路”模式完全保持 RM1–RM4 的行为。依赖 `docs/features/route-detail.md` RD3（批量 ZIP 详情）；RD3 未完成时，选中线路后各 ZIP 显示为“无数据”。

### RM5-1 已确认的要求（Product Owner 2026-10-05）

- 两种颜色模式：**按线路**（默认，现有逻辑）和**按难易度**。
- 难易度颜色固定：S 极难 紫、A 难 红、B 中 黄、C 易 深绿、D 极易 浅绿、无数据 灰。
- 只使用系统难度，**不用人工难度**。
- 未选中线路：每条 Route 的全部 ZIP 使用该 Route 的整体难度颜色。
- 选中线路：这条 Route 内的每个 ZIP 按自己的 ZIP 难度着色；ZIP 难度只来自 route-details cache；没有 ZIP 详情时**不猜**，也不把 Route 难度复制给 ZIP，并明确显示“暂无 ZIP 难度数据”。
- Legend 只在难易度模式显示，固定 6 项。
- RM1–RM4 的全部功能不变（见 RM5-9）。

### RM5-2 数据来源

| 用途 | 来源 | 字段 | 说明 |
|---|---|---|---|
| Route 难度 | `route-profiles.json`（列表接口，T3） | `route_difficulty`（`roadAreaDifficulty`） | 51 条都有。实测分布：S 2 / A 5 / B 28 / C 15 / D 1。**不用** `route_difficulty_manual` |
| ZIP 难度 | `route-details.json`（RD1 / RD3） | `zips[].postal_code_difficulty` | 只有文字，没有 code（RD-Q2）。SFO01-001 样本 21 个 ZIP 中有 3 个为 null |

- **为什么 Route 难度不用 `route-details.json` 中的 `route_difficulty`**：它只在已抓详情的 Route 上才有，抓取时间也和地图快照不同。地图上的 Route 数据统一来自 `route-profiles.json`。
- **等级识别**：新增一个共用的纯函数 `difficultyLevel(text)`，按 DMS 五个原文（`S级 极难` / `A级 难` / `B级 中` / `C级 易` / `D级 极易`，去掉首尾空格后完全匹配）返回 `'S' | 'A' | 'B' | 'C' | 'D'`。null 或其他文字一律返回 `null`，即无数据（灰色）。Route 和 ZIP 用同一个函数。Route Profile 页面原来的三色 `difficultyTone`（R8）改为使用同一个函数和同一套五色（RM-Q1）。
- 不新增任何难度计算或推断规则（`AGENTS.md` 第 13 节、data-schema 第 4.5 节）。

### RM5-3 API：在 server 端组装（不新增接口）

沿用 W3 / W5：join 在 server 的 route-map 组装层完成，前端不按邮编做 join，也不需要选中线路后再请求 `/api/route-details`。

`GET /api/route-map?station=` 响应新增字段（原有字段不变）：

```text
routes[]:
  route_difficulty        string|null   DMS 原文（route-profiles）
  zip_detail: {
    status                'available' | 'missing'
    fetched_at            ISO|null      该 Route 的 route-details fetched_at
    zip_count             number|null   该 Route 在 route-details 中的 ZIP 行数（zips.length）；missing 时为 null
  }
features[].properties:
  route_difficulty        string|null   同上，冗余到每个 polygon，样式函数不用再查表
  zip_difficulty          string|null   来自 route-details；没有详情或该 ZIP 不在详情里时为 null
  zip_detail_status       'available' | 'missing' | 'not_in_detail'
details_status            'ok' | 'none' | 'invalid'   整个 route-details.json 的状态
```

- `zip_detail_status`：`available` 表示该 Route 有详情且其中有这个 ZIP（`zip_difficulty` 仍可能为 null，即 DMS 本身没有值）；`missing` 表示该 Route 还没有详情；`not_in_detail` 表示该 Route 有详情，但详情里没有这个 ZIP（快照和详情抓取时间不同造成）。难易度模式、选中该 Route 时：`available` 且 `difficultyLevel(zip_difficulty)` 能识别 → 按五色显示；`available` 但 `zip_difficulty` 为 null 或无法识别、`missing`、`not_in_detail` → 灰色，三种情况的提示文字不同（RM5-7）。（2026-10-05 Claude 澄清措辞）
- 线路概览中的“已有 N 个 ZIP”使用 `routes[].zip_detail.zip_count`（详情行数），不使用快照的 `routes[].zip_count`。
- 详情 join 条件：`route_id` 相同，且详情的 `station` 与当前 Station 相同；ZIP 按 `postal_code` 字符串精确匹配。
- `route-details.json` 不存在时 `details_status: 'none'`（全部 `missing`），**地图正常返回 200**。文件损坏或结构不合法时 `details_status: 'invalid'`（全部 `missing`），地图仍返回 200，页面显示警告。地图的线路、邮编、覆盖率功能不能因为详情文件出问题而失败。
- `GET /api/route-map/zip` 中有线路覆盖的结果同样带上 `route_difficulty`、`zip_difficulty`、`zip_detail_status`，使搜索定位后的高亮颜色和点击定位一致。
- 响应体积：每个 polygon 增加 3 个短字段（约 254 个），可以忽略。

### RM5-4 前端状态设计

```text
colorMode: 'route' | 'difficulty'    独立于 selection；默认 'route'；页面内存，不持久化
selection: { station, route, zip }   不变
```

`polygonStyle(properties, selection, colorMode)` 决定填充色（边框、透明度、选中 / 淡化规则沿用现有逻辑）：

| colorMode | 是否选中线路 | 该 polygon 属于选中的线路？ | 填充色 |
|---|---|---|---|
| route | — | — | `routeColor(route_id)`（不变） |
| difficulty | 否 | — | `difficultyColor(difficultyLevel(route_difficulty))` |
| difficulty | 是 | 是 | `difficultyColor(difficultyLevel(zip_difficulty))`；`zip_detail_status ≠ available` 时为灰 |
| difficulty | 是 | 否 | Route 难度颜色，沿用现有的淡化透明度（0.12） |

- 选中 ZIP 时 `selection.route` 也会设置，所以点击 ZIP 后该线路同样进入 ZIP 难度着色。
- 选中 ZIP 的洋红边框、无线路 ZIP 的洋红虚线、hover 白边保持不变。洋红（`#db2777`）和 S 级紫色（`#7e22ce`）色相区分明显；实现后在本机截图确认。
- 切换模式只重新设置样式：**不改变 selection，不改变缩放和视野，不重新请求数据**。

### RM5-5 模式切换控件

- 位置：地图右上角的 Leaflet 控件（与“定位站点”同一类控件），1440 和 390 都能直接看到，不会被侧边栏推到首屏以下。
- 形式：两个按钮组成的分段控件 `按线路 | 按难易度`，用 `role="group"` 加 `aria-pressed`；键盘可操作；`L.DomEvent.disableClickPropagation`，避免点击时触发“清除选择”。
- 侧边栏线路列表的色块随模式变化：按线路时为 Route 颜色（不变）；按难易度时为 Route 难度颜色，并在色块旁显示等级字母（S / A / B / C / D / —），不只靠颜色区分。

### RM5-6 Legend

- 只在“按难易度”模式显示，作为 Leaflet 控件放在地图右下角（在署名之上）；按线路模式下隐藏。
- 固定 6 项，顺序和文字固定：`S 极难`、`A 难`、`B 中`、`C 易`、`D 极易`、`无数据`。每项为色块加文字，DOM 用 textContent 渲染（不使用 inline `<style>`，色块颜色用 `element.style`，与 RM1 的 CSP 做法相同）。
- 标题随状态变化，说明当前颜色代表什么：未选中线路时为“颜色：线路难度”；选中线路时为“颜色：{线路名} 的 ZIP 难度”。
- 390 宽时 legend 不超过约 140 px 宽，不遮挡缩放 / 定位控件；不做折叠。

| 等级 | 文字 | 填充色（建议） |
|---|---|---|
| S | 极难 | `#7e22ce` 紫 |
| A | 难 | `#dc2626` 红 |
| B | 中 | `#eab308` 黄 |
| C | 易 | `#15803d` 深绿 |
| D | 极易 | `#86efac` 浅绿 |
| — | 无数据 | `#9ca3af` 灰 |

颜色常量集中定义在一个模块中（`web/difficulty.js`），legend、polygon 和线路列表色块都从这里取。

### RM5-7 缺少 ZIP 详情时的降级

| 情况（难易度模式、已选中线路） | 地图 | 侧边栏 / tooltip |
|---|---|---|
| 该 Route 没有详情（`missing`） | 该 Route 的全部 ZIP 显示灰色 | 线路概览中显示 **“暂无 ZIP 难度数据”**，并提示 `npm run dms:scrape-route-details -- --station SFO01`；Route 难度照常显示（文字），但**不**用于给 ZIP 着色 |
| 有详情，但某个 ZIP 的难度为 null | 该 ZIP 显示灰色 | tooltip / ZIP 面板中“ZIP 难度：—（DMS 无数据）” |
| 有详情，但其中没有该 ZIP（`not_in_detail`） | 灰色 | “ZIP 难度：—（该 ZIP 不在线路详情中，详情更新于 …）” |
| `details_status: invalid` | 全部按 `missing` 处理 | 地图顶部状态行显示警告“线路详情文件无效，ZIP 难度不可用”；其他功能正常 |
| 未选中线路 | 全部按 Route 难度着色，不需要 ZIP 详情 | — |
| Route 难度为 null 或无法识别 | 灰色 | Route 难度显示 `—` |

缺少边界的 ZIP 在地图上本来就没有 polygon，保持 RM3 现有显示（缺少边界清单不变），不为它们补充难度。

### RM5-8 Tooltip / 面板内容

- Tooltip（两种模式都显示，内容按模式增加）：ZIP、线路、站点（不变）；难易度模式下增加一行：未选中线路时显示“线路难度：B级 中”，选中线路且属于该线路时显示“ZIP 难度：A级 难”或按 RM5-7 显示降级文字。
- 线路概览：增加“线路难度”一项（两种模式都显示）；难易度模式下增加“ZIP 难度：已有 21 个 ZIP · 更新于 …”或“暂无 ZIP 难度数据”。
- 当前邮编面板：有数据时增加“ZIP 难度”一项。

### RM5-9 保持不变（回归检查清单）

中文 UI；彩色 `light` 底图；线路 / 邮编统一搜索（含跨 Station 的 ZIP 搜索）；定位站点；线路列表（搜索过滤、`aria-pressed`）；线路概览；ZIP 选中和高亮；覆盖率；缺少边界的邮编清单；hover / click / 触屏 tap；Esc 和“清除选择”；0 个第三方请求；CSP 不放宽；1440 / 390 响应式且无横向滚动；按线路模式下的 Route 颜色与 RM4 完全一致（palette 冻结）。

### RM5-10 需要修改的文件（建议）

| 层 | 文件 | 改动 |
|---|---|---|
| store | `server/src/store/route-details-file.js` | 新增 `readRouteDetailsForMap({ runtimeDir })`：只读，返回 `{ status: 'ok' \| 'none' \| 'invalid', routes }`，复用现有 `validFile`，不抛出到地图层 |
| route-map 组装 | `server/src/route-map/route-map.js` | `buildRouteMap` / `lookupZip` 新增可选参数 `details`，组装 RM5-3 的字段；不传时与现在一致（全部 `missing`） |
| API wiring | `server/src/api/server.js` | 地图和 ZIP 接口注入 details reader；`app.js` 的路由和错误码不变 |
| 前端共用 | `web/difficulty.js`（新增） | `difficultyLevel`、`DIFFICULTY_COLORS`、`difficultyColor`；需要加入 `server/src/api/static-files.js` 的白名单 |
| 前端 | `web/format.js`、`web/route-detail.js`、`web/app.js`、`web/styles.css` | Route Profile 主表和 modal 的难度标签改用 `difficultyLevel` 加五色（RM-Q1）；文字仍为 DMS 原值 |
| 前端 | `web/map-state.js` | `polygonStyle` 增加 `colorMode` 参数（默认 `'route'`，保持现有调用不变） |
| 前端 | `web/map-view.js` | 模式切换控件、legend 控件、tooltip 难度行、`setColorMode` 只重设样式 |
| 前端 | `web/map-panel.js` | 色块随模式变化并显示等级字母；线路概览 / 当前邮编面板的难度项和降级文字 |
| 前端 | `web/map.js` | 保存 `colorMode` 状态，连接控件、view 和 panel；处理 `details_status: invalid` 的警告 |
| 前端 | `web/map-text.js`、`web/styles.css` | 中文文案；控件、legend 和窄屏样式 |
| 测试 | `server/test/route-map.test.js`、`route-map-api.test.js`、`map-state.test.js`、`route-map-web.test.js`，新增 `difficulty.test.js` | 按模块补充 |

不新增依赖，不新增 API 路径，不改 `route-details.json` / `route-profiles.json` 的 schema。

### RM5-11 验收标准

- **RM5-AC1** 默认是“按线路”模式，地图、色块和交互与 RM4 完全相同（现有测试不改断言即通过）。
- **RM5-AC2** 有明显的 `按线路 | 按难易度` 切换控件；键盘可操作；切换时不改变选择、不改变视野、不发请求。
- **RM5-AC3** 难易度模式、未选中线路：每个 polygon 的填充色等于其 Route 难度对应的颜色（RM5-6 表）；Route 难度为 null 或未知值时为灰色；不使用人工难度。
- **RM5-AC4** 难易度模式、选中线路：该线路的 ZIP 按各自的 `zip_difficulty` 着色，同一线路内可以出现不同等级；其他线路按 Route 难度颜色并淡化。
- **RM5-AC5** 没有 ZIP 详情时：该线路的 ZIP 全部为灰色，侧边栏显示“暂无 ZIP 难度数据”和批量命令；任何 ZIP 都不使用 Route 难度的颜色。null 和 `not_in_detail` 按 RM5-7 显示。
- **RM5-AC6** Legend 只在难易度模式出现，6 项的顺序、文字和颜色固定；标题随是否选中线路变化；1440 / 390 都能看到，不遮挡控件。
- **RM5-AC7** `/api/route-map` 和 `/api/route-map/zip` 返回 RM5-3 的字段；`route-details.json` 不存在或损坏时地图仍返回 200 且其他功能正常；原有字段不变。
- **RM5-AC8** 等级识别只有一个共用函数；Route Profile 主表的**线路难度**（系统难度）和 Route Detail modal（线路难度、ZIP 难度）使用同一套五色，显示文字为 DMS 原值，无数据为灰色或普通 `—`；不改数据。**人工难度列本轮不改**，保持现状（Product Owner 2026-10-05：“人工难度这轮不加”）。
- **RM5-AC9** RM5-9 清单全部回归通过：0 个外部请求，console 没有 error，没有 CSP violation，1440 / 390 页面无横向滚动。
- **RM5-AC10** `npm test` 全部通过；没有新增依赖；Product Owner 本机预览签字。

### RM5-12 未决问题

RM-Q1、RM-Q2 已由 Product Owner 2026-10-05 决定（见本节开头）。


### RM5 实现记录（Implementation Notes）

- 2026-10-05，Codex：基于工作区已有 RD3 / RD4 改动实现；未改需求、验收标准、抓取代码、缓存 schema、依赖、API 路径或 CSP，未访问 DMS / 真实 session / 真实 runtime，未提交、推送或部署。
- 新增只读容错 reader `readRouteDetailsForMap`，复用现有完整文件校验；缺失为 `none`，损坏、结构错误或读取失败为 `invalid`。两种情况地图 / ZIP API 均继续工作。服务端按 route_id + Station + ZIP 字符串精确匹配，只向地图投影难度及详情状态，不输出 raw 等私有字段。Route 难度来自 profile，ZIP 难度来自详情；详情数量采用 zips.length。
- 新增 `web/difficulty.js` 并加入静态白名单；五种原文去首尾空白后精确匹配，未知值为灰。地图、legend、线路列表、Profile 系统难度和 modal 共用等级与颜色。保留人工难度原有三色展示；modal ZIP 表维持 RD4 的五列。
- 默认按线路；模式保存在页面内存。右上分段控件采用原生 button、role=group 和 aria-pressed，并禁用地图点击传播。切换只更新既有图层样式 / tooltip 和面板，不重建地图图层、不定位、不请求。右下 legend 固定六项，宽 140px；难度 tooltip 的换行样式仅作用于难度模式。ZIP 无数据不继承 Route 难度，missing / null / not_in_detail 分别显示对应提示，invalid 在顶部警告。
- 测试断言调整说明：route-map.test.js 的两个完整 summary 预期及 feature properties 预期补入 RM5 新字段；“响应不得包含 difficulty”改为仍禁止 color / raw / source_url（RM5 明确要求难度字段）。rd1.test.js 的系统难度三色 class 断言更新为五色标签，并新增逐色校验；t7.test.js 分别验证系统五色、人工原有三色，DOM doubles 增加 style 属性。既有 map-state 和 route-map-web 的按线路颜色、交互断言未改。
- 检查：Node v24.19.0；`npm.cmd test`（即 npm test）319/319 通过，0 failed / skipped；`git diff --check` 通过。没有 lint / build scripts，未声称运行 lint / build。所有新增测试使用合成数据；API 测试启动临时 loopback server 并自动关闭，未启动真实 runtime 服务。测试输出：`.handoff/RM5-tests.log`。
- 验收对照：AC1（既有 map-state / route-map-web 回归）；AC2（route-map-web：控件语义、aria-pressed、选择 / fit / 请求 / 图层数量不变，真实键盘激活待浏览器复核）；AC3 / AC4（map-state 样式表）；AC5（route-map-web 降级、无继承）；AC6（route-map-web 六项、标题、显隐，真实 1440 / 390 可见性待复核）；AC7（difficulty / route-map / route-map-api）；AC8（difficulty / t7 / rd1，人工列不变）：上述可用 doubles / 本地合成 API 验证部分通过。
- 待 Claude：AC9 的完整真实浏览器回归、键盘 Enter / Space、1440 / 390 布局和 legend 遮挡、Network / console / CSP、真实底图上的五色及洋红描边观感。AC10 的测试和无新增依赖部分通过；Product Owner 本机预览签字尚未完成。本次仅实现完成，UI 未标记 Done。

- **RM5b 选中描边 — 2026-10-05（Codex）**：按 RM5b task brief 将选中边框改为深色 `#0b1220` 外层 + 白色 `#ffffff` 内层；Route 为 3.5 / 1.5，ZIP 为 5 / 3，无覆盖 ZIP 的外层实线、内层 `8 6` 虚线，浅粉填充不变。数值集中在 `SELECTION_OUTLINE`。基础多边形改用中性边框，保留原有填充、透明度、hover 加粗规则、选择、搜索、tooltip 和视野行为。独立 Leaflet pane 在填充层上方，使用 CSSOM 设置 pointer-events:none；描边 fill:false、interactive:false、bubblingMouseEvents:false，选中 ZIP 最后绘制。选择变化重建描边，清除 / Station 切换移除，颜色模式切换复用既有描边，无残留或重复。
- RM5b 检查：`npm.cmd test` 320/320 通过（日志 `.handoff/RM5b-tests.log`），`git diff --check` 通过；项目没有 lint / build scripts。新增 doubles 测试覆盖线宽 / 顺序、无覆盖虚线、非交互、模式复用、清除、Station 切换和 hover。临时合成数据 HTTP server + 已安装 Playwright / Chromium 在 1440 / 390 验证实际 SVG 线宽与顺序、pointer-events、模式切换、Esc 清除、无横向溢出、无 JavaScript / CSP 错误；server 和 browser 已关闭。首次浏览器检查因 PowerShell 管道中文按钮名编码为问号导致 locator 超时，改用 CSS selector 后通过。未新增依赖、未修改数据或需求 / 验收标准、未访问 DMS / credentials / 真实 runtime，未 commit / push / 部署。真实运营底图观感和 Product Owner 预览签字仍待确认；legacy 页面本轮未修改或做浏览器回归。

---

## RM6 — 地图选中信息与侧栏整理（**Approved**，Product Owner 2026-10-07）

只调整 UI / 展示层；District → Station → Route → ZIP、选中逻辑、RM5 / RM5b 颜色和描边、hover / click / tap、Coverage、Missing ZIP、搜索、localStorage 记忆、API / cache 数据含义都**不变**。

### RM6-1 Tooltip（hover）

- 两种颜色模式下都只显示 3 行：`ZIP`、`线路`、`DSP`。删除“站点”和“线路难度 / ZIP 难度”行。缺失时显示 `—`。

### RM6-2 数据（server 端组装，只新增字段，Claude 设计）

- `/api/route-map`、`/api/route-map/district`、`/api/route-map/zip` 返回的每个有线路的 ZIP（feature properties 和 ZIP 查询结果）增加：
  - `dsp_name`：来自该 Route 的 profile 行；
  - `experienced_pph`、`pickup_volume_daily`：来自 route-details 中同一个 ZIP（与 `zip_difficulty` 使用同样的 join 条件）；没有详情或该 ZIP 不在详情里时为 null。
- 原有字段不变。前端不做 Route-ZIP join（W5）。

### RM6-3 侧栏结构（从上到下）

1. **当前邮编**（主要信息；选中 ZIP 时显示）：
   - 头部：大号 `ZIP`；状态做成小 badge（如“有线路覆盖”“当前无线路覆盖”“多个站点”），只在必要时显示；右侧放「清除选择」小按钮。
   - 主要数字（大号，并排）：`熟手 PPH`、`领件量（日均）`（来自 `pickup_volume_daily`，不是百分比）。
   - 辅助信息（小号，一行或两列）：`站点`、`DSP`、`ZIP 难度`（沿用五色标签）。
   - 缺失一律显示 `—`。删除原来的长说明文案（如“该 ZIP 有线路覆盖，地图已定位并高亮”）。无线路 / 无边界 / 超出范围 / 多站点等情况只用 badge 加最短的一行文字表示。
2. **线路概览**（次级信息，视觉权重低于当前邮编；选中 Route 或 ZIP 时显示）：`Route`、`站点`、`DSP`、`ZIP 数`（含已上图数）、`Pickup Volume`、`PPH`、`线路难度`、更新时间。难易度模式下的“ZIP 难度：已有 N 个 ZIP / 暂无 ZIP 难度数据”保留为一行小字。只选中 Route、没有选中 ZIP 时，「清除选择」放在线路概览的头部。
3. **线路**（搜索和线路列表）。
4. **地图覆盖率**、**缺少边界的邮编**（折叠）、跨站重叠提示、ZCTA 说明：保持现有内容，样式统一并收紧。

- **删除“当前选择”卡片**；它显示的站点 / 线路 / 邮编已经被以上卡片覆盖。
- 不重复显示相同字段；卡片的间距、标题字号、badge、数字排版统一；整体更紧凑，像运营 dashboard。

### RM6-4 布局

- 1440 宽度：侧栏从 `minmax(280px, 360px)` 缩窄到约 `300px` 的固定宽度（可在 280–320 之间微调），地图获得剩余宽度；地图高度不变或略增。目标是地图在 1440 下明显变宽。
- 390 宽度：仍为单列（地图在上，侧栏在下），不能有横向滚动；数字和标签在窄屏下可读。

### RM6-5 验收标准

- **RM6-AC1** Tooltip 只有 ZIP / 线路 / DSP（两种模式下都是）。
- **RM6-AC2** 选中 ZIP 后，当前邮编显示 ZIP、站点、DSP、ZIP 难度、熟手 PPH、领件量（日均），缺失为 `—`；清除选择正常工作。
- **RM6-AC3** 没有“当前选择”卡片；线路概览在当前邮编下方，显示当前 Route，且视觉层级较低。
- **RM6-AC4** 选中逻辑、RM5 / RM5b、搜索、District / Station 记忆、Coverage / Missing 没有回归。
- **RM6-AC5** 1440 下地图比 RM5 时明显更宽；390 下没有横向滚动。
- **RM6-AC6** 新增的 API 字段符合 RM6-2，原有字段不变；`npm test` 和 `git diff --check` 通过；没有第三方请求，console 没有 error。

### RM6 实现记录（Implementation Notes）

- 2026-10-07，Codex：保留工作区已有 RM5 / RM5b / MS / DS 改动，只修改 RM6 涉及的展示、地图字段投影及测试。未访问 DMS、凭据或真实 runtime；未新增依赖、修改缓存 schema、提交、推送或部署。
- 服务端复用已有 `difficultyProperties` 中按 Route + Station + ZIP 的 detail join，向 Station / District feature properties 和有线路的 ZIP lookup 新增 `dsp_name`、`experienced_pph`、`pickup_volume_daily`。DSP 来自 profile，两个 ZIP 指标来自详情；保留零值，缺失详情 / ZIP 为 null，不改变原字段或 coverage / missing。
- 两种模式的 tooltip 固定为 ZIP / 线路 / DSP 三行。删除当前选择卡片；ZIP 卡片展示大号 ZIP、状态 badge、熟手 PPH / 日均领件量、站点 / DSP / 五色 ZIP 难度，缺失为 `—`；无边界另加 badge，多站点保留紧凑 owners 列表，超范围保留支持范围一行。共用同一个原生清除按钮，ZIP 选中时移入 ZIP 头部，仅 Route 选中时移入线路概览头部，沿用原 `onClear`。
- 线路概览保留原指标、更新时间和难易度模式详情状态小字，删除批量抓取命令和重复 snapshot 来源文字；ZIP 信息视觉权重高于 Route。桌面侧栏固定 300px，窄屏单列；样式均在 styles.css，文案集中在 map-text.js，没有 inline style 标签或 CSP 调整。
- 既有测试断言调整逐项：五种 ZIP 状态、跨站 ZIP、过期响应及模式切换的 `map-current` 断言改查 ZIP 卡片 / Route 概览；原 ZIP dl 索引改查新标题和指标区域；PO Box / 长无边界说明改查 badge；重复 snapshot 来源断言删除；RM5 tooltip 的 Route / ZIP 难度与降级文字断言改查固定三行，ZIP null / not_in_detail 改查 `—`；抓取命令断言改为不存在；多站点 owner 断言改查紧凑列表。颜色、填充、描边、视野、请求数量、搜索、District / Station 记忆、Coverage / Missing 回归断言保留。完整 feature properties 预期仅补入新增字段。DOM doubles 增加头部节点并模拟 append 的真实移动语义。
- 检查：`npm.cmd test`（即 npm test）409/409 通过，0 failed / skipped；`git diff --check` 通过（仅既有 LF/CRLF 提示）。没有 lint / build scripts。新增合成数据测试覆盖准确匹配、零值、null、无详情 / 不在详情中、lookup、District、API 原字段保留、六个 ZIP 字段、tooltip 安全三行和清除按钮位置 / 功能。测试日志：`.handoff/RM6-tests.log`。
- 使用已安装 Playwright / Chromium 和临时 loopback HTTP handler 注入合成 profiles / details / boundaries，不读取任何运营 runtime。1440px 下侧栏 300px、地图 1072px（原 360px 侧栏时为 1012px）；390px 下地图 / 侧栏 366px，document scrollWidth 为 390px。真实 polygon click / touch tap、两种模式 tooltip、ZIP 指标、清除和展开 Missing 表通过；无外部请求、JavaScript / CSP 错误。Mock 未安装底图，预期 basemap 404 和提示保留，未验证实际 PMTiles 底图。初次检查 hover 到被选中高亮层覆盖的原图层超时，随后改查顶层；tooltip locator 改为最后一个实际 tooltip 后通过。临时 server / browser 已关闭。
- 预览截图：`.handoff/RM6-1440.png`、`.handoff/RM6-390.png`；浏览器结果：`.handoff/RM6-browser.log`。RM6-AC1 / AC2 / AC3 / AC4 / AC5 / AC6 在上述合成数据测试及浏览器范围内通过；真实运营数据与底图观感、Product Owner 预览签字仍待完成。本次未修改或浏览器回归 legacy 页面。

- **RM6b — 2026-10-07（Codex）**：仅调整 `web/map-panel.js`、`web/styles.css` 及相关 DOM 断言。当前 ZIP 改为 2×2 指标（熟手 PPH / 日均领件量、DSP / ZIP 难度），DSP 加粗、五色 badge 放大，站点降为辅助文字；清除按钮采用小号次级样式。侧栏 280px，桌面左右留白 16px、栏间距 16px，顶部控件分行规则不变。线路难度并入概览的紧凑指标组，更新时间移到底部并弱化。站点细看搜索结果不添加 Station 前缀，片区总览仍保留分组 / 搜索前缀；搜索筛选及选择逻辑不变。
- RM6b 检查：指定 `node --test server/test/route-map-web.test.js server/test/map-state.test.js` 24/24 通过；`git diff --check` 通过（既有 LF/CRLF 提示）。没有 lint / build scripts，按 brief 未运行完整 npm test。DOM 断言逐项调整：ZIP 难度由辅助区移至主指标第四项（含无数据断言）；主指标预期补入 DSP / ZIP 难度，辅助区仅剩站点；无边界说明因更新时间移到底部而更新索引；站点细看搜索结果预期删除 Station 前缀。既有交互回归断言保留。初次临时编辑命令因系统 Python 无法运行而失败，改用 Node 完成；初次测试的四项旧排版断言随后更新并通过。
- RM6b 浏览器：已安装 Playwright / Chromium + 临时本地 HTTP 页面，注入合成数据直接执行真实 panel 模块 / CSS；1440 下侧栏 280px、地图容器 1112px（RM6 为 1072px），390 下地图 / 侧栏 366px、scrollWidth 390px；两列指标、15px ZIP 难度 badge、更新时间位于末尾及无 pageerror 通过。截图 `.handoff/RM6b-1440.png`、`.handoff/RM6b-390.png`。该检查仅验证排版，没有启动真实 API、地图渲染或底图，也没有完整 Network / console / CSP 回归；地图交互由指定测试验证。临时 server / browser 已关闭；未访问 DMS / credentials / 真实 runtime、未新增依赖、未 commit / push / 部署。真实地图观感与 Product Owner 预览签字仍待完成。

### RM6b — UI 微调（Product Owner 2026-10-07）

只改 CSS、UI 和排版；数据、API、cache、选中 / 搜索 / localStorage、RM5 配色、hover / click / tap、Coverage 都不变。

- **当前邮编**：顶部是大号 ZIP（右上角放小号次级的「清除选择」）。下面是 2×2 主要指标：第一行为 `熟手 PPH`、`领件量（日均）`（大号数字）；第二行为 `DSP`（加粗、醒目）、`ZIP 难度`（五色 badge，比现在更大更醒目）。`站点`降为辅助信息（小字）。缺失为 `—`。
- **布局**：1440 下侧栏约 280px，页面左右留白适当减少，让地图明显变宽。顶部控件保持现有分行，不强行压成一行。390 保持单列，不出现横向滚动。
- **线路列表**：站点细看时只显示 Route 名（如 `SMF01-001`），不加 Station 前缀；片区总览时保留按 Station 分组或前缀。
- **线路概览**：`ZIP 数`、`Pickup Volume`、`PPH`、`线路难度` 放在同一组紧凑指标中；更新时间放在底部并弱化显示。

---

## RM7 — 地图 DSP 筛选（**Approved**，Product Owner 2026-10-08）

在地图右上角现有的“片区 / 站点”筛选器旁边，新增 DSP 筛选器。**只在前端控制视觉强调和线路列表的过滤**，不改数据、API、cache、scraper、DB，也不改 RM5 / RM5b 的颜色和描边、Coverage、Missing ZIP、跨站冲突、边界逻辑。

### RM7-1 数据来源（Claude 检查后确认：不需要新增 API）

- `/api/route-map/district` 返回的 `routes[]` 和 `features[].properties` 中已经有 `dsp_name`（来自 Route Profile 的 `fleetName`）。
- 选项由前端从**当前已加载的** `routes` 生成：
  - 只取当前范围内的 Route：站点细看时只取该 Station；片区总览时取该 District 的全部 Route；
  - `dsp_name` 去掉首尾空格后，只保留非空字符串；null、undefined、空字符串都不生成选项；
  - 去重；
  - 按码点（code point）比较排序，与 `route-map.js` 中的 `compare` 规则一致，保证顺序稳定；
  - 第一项固定为“全部 DSP”（值为空字符串）。

### RM7-2 状态规则

- 状态：`dsp`，取值为 null（全部）或某个 DSP 名称。默认为 null。
- **只在当前页面会话中有效**，不写入 localStorage，也不放进 URL。
  - 理由：DSP 选项随 District / Station 变化。如果要记住上一次的 DSP，就得在恢复时再判断它在新范围里是否还有效，这会增加状态的复杂度。刷新页面后回到“全部 DSP”，行为最容易理解。
- 切换 District 或 Station、重新加载数据后，重新生成选项。如果当前的 `dsp` 不在新选项中，就自动回到“全部 DSP”。

### RM7-3 地图表现（复用现有的淡化逻辑）

- `polygonStyle` 增加一个 `dsp` 参数。
- **没有选中 Route 时**，满足以下任一条件的多边形就淡化，使用现有的 `fillOpacity 0.12 / opacity 0.35`：
  - 不属于当前聚焦的 Station（现有规则）；
  - 设置了 `dsp`，并且 `properties.dsp_name !== dsp`（新增规则）。
- **有选中 Route 时**：规则不变（只有选中的 Route 正常显示，其他都淡化）。也就是说，选中的 Route 优先于 DSP 筛选。
- 颜色（按线路 / 按难易度）、描边、hover 加粗规则都不变；hover 结束时恢复样式，也要把 `dsp` 传进去。
- “定位”（fit）按钮的行为不变。

### RM7-4 线路列表和搜索

- 设置了 `dsp` 时，线路列表只显示 `dsp_name === dsp` 的 Route。DSP 条件**叠加**在现有列表逻辑上，现有逻辑本身不变：没有搜索词时按聚焦的 Station 过滤；输入线路搜索词时可以跨 Station 搜索（现有行为，见 `route-map-web.test.js` 中“聚焦 MOCKA 时仍可搜索 MOCKB 的线路”）。没有匹配时，显示现有的“未找到匹配线路”。（2026-10-08 澄清：RM7-T1 时 Codex 指出原来的写法与现有的跨 Station 搜索冲突；Product Owner 没有要求改变搜索范围，所以保留现状。）
- 在搜索框输入线路名后按 Enter：只在**已经按 DSP 筛选过**的 Route 中查找，与列表保持一致。
- ZIP 搜索：**不受 DSP 筛选影响**，ZIP 归属仍然以 API 返回的结果为准。

### RM7-5 切换 DSP 时，已选中的 Route / ZIP 怎么处理

| 当前选中的内容 | 切换到某个具体 DSP 时 | 切换到“全部 DSP”时 |
|---|---|---|
| 没有选中 | 不变 | 不变 |
| 选中的 Route（或者选中的、已被 Route 覆盖的 ZIP）属于新 DSP | **保留** | 保留 |
| 选中的 Route（或者已被 Route 覆盖的 ZIP）**不属于**新 DSP | **清除选中**（回到当前 Station / District 的聚焦状态，和按 Esc 的效果相同） | 保留 |
| 选中的 ZIP 不属于任何 Route（uncovered、no_boundary、out_of_range、multi_station） | 保留（DSP 与它无关） | 保留 |

- 理由：用户切换 DSP，说明想看这个 DSP。如果还留着别的 DSP 的 Route，“选中优先”的规则会让新 DSP 的线路全部被淡化，看起来就像 DSP 筛选没有生效。
- **DSP 筛选开着时，用户在地图上点了别的 DSP 的多边形，或者 ZIP 搜索的结果属于别的 DSP**：允许选中，正常显示，DSP 筛选保持不变。这是用户明确的操作，按“选中优先”显示；清除选中后，又回到按 DSP 强调的状态。

### RM7-6 UI

- `map.html` 的 header 中，“站点”下拉框后面加一个“DSP”下拉框，`id="map-dsp"`，样式与现有的两个下拉框一致。数据加载完成前为 disabled。
- 390 宽度下不能出现横向滚动；1440 宽度下与现有的两个筛选器排在一行，或者沿用现有的换行规则。

### RM7-7 验收标准

- **RM7-AC1** 选项：站点细看时只有该 Station 的 DSP；片区总览时是该 District 全部的 DSP；去重；顺序稳定；没有空白、null 之类的选项；第一项是“全部 DSP”；默认为全部。
- **RM7-AC2** 切换 Station 或 District 后，如果原来的 DSP 在新范围中不存在，自动回到全部；如果仍然存在，就保留。
- **RM7-AC3** 地图：选择 DSP 后，其他 DSP 的多边形淡化，透明度数值与现有的聚焦淡化相同；选择全部后恢复。两种颜色模式下颜色都不变。选中 Route 时仍然按现有规则显示。
- **RM7-AC4** 线路列表只显示所选 DSP 的 Route（叠加在现有的 Station 范围和跨 Station 搜索逻辑上，现有逻辑不变）；按 Enter 搜索时只在“现有逻辑 + DSP”筛选过的 Route 中查找。
- **RM7-AC5** 切换 DSP 时，已选中内容的处理符合 RM7-5 的表格；在地图上点击、或 ZIP 搜索到别的 DSP 时，可以正常选中，DSP 筛选保持不变；ZIP 归属不变。
- **RM7-AC6** RM5 / RM5b / RM6 的颜色、描边、tooltip、Coverage、Missing、跨站冲突、District / Station 记忆都没有回归；DSP 不写入 localStorage。
- **RM7-AC7** 1440 / 390 宽度下没有横向滚动，console 没有 error；`npm test` 全部通过，现有断言除了因为新增参数必须调整的地方以外都不改，调整的地方要逐条说明；`git diff --check` 通过；没有新增依赖。

### RM7 Codex 任务

| 任务 | 内容 | 状态 |
|---|---|---|
| RM7-T1 | 按 RM7-1 至 RM7-7 实现 DSP 筛选器和测试 | 待 review |

### RM7 实现记录（Implementation Notes，2026-10-08）

- 新增 `dspOptions`，按当前 Station / District 生成去重、trim 后非空、稳定排序的选项；DSP 仅保存在页面内存，重新加载范围时保留有效值或回到全部。
- 新增 `filteredRoutes`，列表和 Enter 共用现有 Station / 跨 Station 搜索规则，再叠加 DSP 条件；ZIP 查询与归属逻辑不变。
- `polygonStyle` 的可选第五参数控制未选中时的 DSP 淡化；所有地图样式调用均传入 DSP，`view.setDsp` 复用 `refreshStyles`，选中描边与颜色逻辑不变。
- DSP 切换时按已加载的完整 Route 判断归属，必要时复用 `deselect`；不属于任何 Route 的 ZIP 保留。下拉框加载期间禁用，选项使用 DOM / textContent 创建；header 增加必要的宽度约束。
- 新增 4 项测试；现有测试断言没有修改，仅 DOM fixture 增加 `map-dsp` 元素。
- 检查：定向测试 28/28；`npm.cmd test` 478/478（PowerShell 阻止 npm.ps1，改用 npm.cmd）；无 lint / build script。`git diff --check` 退出 0，无空白问题（Git 提示 LF 将转换为 CRLF）。
- 浏览器：已安装 Playwright / Chromium，临时本地静态 HTTP 服务和合成 API 数据；未启动真实 API、未访问 DMS、未安装依赖。1440 / 390 无横向滚动、无 console / page error、无外部请求。截图 `.handoff/RM7-1440.png`、`.handoff/RM7-390.png`；复核脚本 `.handoff/RM7-browser-check.mjs`，测试日志 `.handoff/RM7-tests.log`。
- RM7-AC1 至 RM7-AC7 技术检查通过；仍待 Claude review 和 Product Owner 预览签收。仓库原有其他未提交改动保留。

---

## RM8 — 搜索框内容不因切换筛选而清空（**Approved**，Product Owner 2026-10-08）

### RM8-1 原因（Claude 检查代码）

- 切换 Station 或 District 时会调用 `loadStation()`，它先执行 `clear()` → `panel.clear()`，其中有 `search.value = ''`，所以输入的内容被清空了。
- `loadStation` 有一个 `preserveSearch` 选项，但目前没有任何调用方使用它，而且它同时控制“切换后不重新定位地图”（`fitToStation: !preserveSearch`），把“保留搜索文本”和“地图视野”绑在了一起。
- 切换 DSP 只会调用 `deselect()`，按代码看不会清空输入框；用测试确认这一点。

### RM8-2 规则

- **搜索框的文字与片区、站点、DSP 的筛选状态分开**：切换片区、站点、DSP，以及加载失败后点“重试”时，**都保留**输入框的内容。
- 只有以下情况会清空输入框：用户自己删除（包括浏览器 search 输入框自带的清除按钮），或者整页重新加载（重新加载后搜索框为空，与现在一致）。
- “清除选择”按钮和 Esc 只清除地图上的选中，不清空输入框（现有行为，保持不变）。
- 地图视野按现有规则处理：切换站点或片区后，仍然定位到新的范围。这和是否保留搜索文本无关。
- 切换后的选中规则不变：切换站点或片区时，仍然清除已选中的 Route / ZIP（现有行为）；切换 DSP 时按 RM7-5 处理。保留下来的搜索文本**不会**自动重新执行 ZIP 查询，也不会自动选中任何东西。
- **新范围下的结果显示：**
  - 输入的是线路搜索词：线路列表按现有规则和 DSP 条件过滤；没有匹配时显示现有的“未找到匹配线路”。
  - 输入的是完整的 5 位 ZIP：线路列表按现有规则显示（ZIP 不参与线路过滤）。搜索提示行显示“已保留 ZIP <zip>，按 Enter 在当前范围重新查询”。按 Enter 后，走现有的 ZIP 查询逻辑；如果 ZIP 不属于当前片区，显示现有的“该 ZIP 属于 …”提示。
- 正在进行中的 ZIP 查询，在切换范围时作废（现有的 `zipSequence` 机制），不会把旧的结果应用到新范围上。

### RM8-3 验收

- **RM8-AC1** 输入 ZIP 或线路名后，切换站点、片区、DSP，输入框的内容都不变；“重试”也不清空。
- **RM8-AC2** 新范围中线路搜索没有匹配时，显示“未找到匹配线路”，输入保留；保留的是 ZIP 时显示约定的提示。
- **RM8-AC3** 用户清空输入框后，列表恢复，提示消失；按 Enter 搜索线路和 ZIP 都正常；切换范围前发出的 ZIP 查询，结果不会应用到新范围。
- **RM8-AC4** 切换后的地图定位、选中清除、RM5 / RM5b / RM6 / RM7 都没有回归；`npm test` 全部通过，因为这项改动而必须调整的现有断言要逐条说明。

| 任务 | 内容 | 状态 |
|---|---|---|
| RM8-PS1-T1 | 实现 RM8 搜索文本保留与 PS1 排序 | 待 review |

### RM8 / PS1 实现记录（Implementation Notes，2026-10-08）

- RM8：panel.clear 仅清理数据和状态，不清空搜索文本。删除无调用方、无测试引用的 preserveSearch；范围加载始终 fitToStation，zipSequence 不再恢复。站点 / 片区 / DSP 切换使旧 ZIP 查询失效；加载成功及 DSP 切换显示 map-text.js 中的保留 ZIP 提示，不自动查询。原有 input / Enter 查询及清除选择逻辑保留。
- PS1：复用已在静态白名单中的 format.js，导出 sortRows；严格有限 number 判断，缺失值末尾，原始下标打破平局，返回新数组。app.js 仅内存保存排序，点击表头不请求、不写 localStorage；按 route_id 重建定位映射，排序时保留已有线路高亮。
- 两个表头使用原生 button、aria-sort、箭头和 focus 样式。切换站点 / 片区及 ZIP 自动定位沿用现有路径，不重置排序。
- 新增 profile-sort.test.js 并注册 index.js；在原有地图 / PZ1 DOM 夹具中增加 RM8 / PS1 测试。没有修改现有测试断言；画像页夹具仅增加排序表头节点。初轮新增夹具重复初始化导致全局 fetch 恢复错误，已拆成独立 fresh-page 测试修正隔离；临时脚本字符编码问题也已修正。
- 浏览器复核使用已安装 Playwright / Chromium、本地临时 HTTP 服务和合成数据。两页 1440 / 390 宽度无页面横向滚动，无 console / page error，无外部请求；地图底图使用预期不可用的合成响应，边界与交互正常。画像页手机截图在既有表格滚动区内滚动至 active 箭头。脚本和日志：.handoff/RM8-PS1-browser-check.mjs、RM8-PS1-browser.log；截图：RM8-PS1-profile-1440.png、RM8-PS1-profile-390.png、RM8-PS1-map-1440.png、RM8-PS1-map-390.png（均位于 .handoff/）。已查看要求的三张截图。
- 无数据 / schema 改动，无新增依赖；未改后端 / API / scraper / DB / P3，未访问真实 DMS，未写凭据，未 commit / push / 部署。工作区已有改动保留。项目没有 lint / build scripts。
- 技术实现待 review，UI 仍待 Product Owner 预览签收。

- 最终检查：npm.cmd test 494/494 通过（原基线 487，新增 7 项）；日志 .handoff/RM8-PS1-tests.log。git -c core.safecrlf=false diff --check 无输出、退出码 0（仅此命令关闭原有 LF/CRLF 提示）。RM8-AC1 至 AC4、PS1-AC1 至 AC4 技术检查通过。

---

## RM9 — 地图视觉层级、尺寸与 Route 编号（**Approved**，Product Owner 2026-10-09 / 2026-10-13）

本节记录地图 UX audit 之后的三轮改动。**与 RM4 / RM5 / RM5b / RM7 中“保持原有颜色、描边”的约束冲突时，以本节为准。** 数据、API、选择和淡化的**判定逻辑**、颜色**语义**（线路色按 `routeColor` 的槽位、难度色按 RM5-6 表）都不变。

### RM9-1 Product Owner 决定

| # | 决定 |
|---|---|
| M1 | （MAP-R1，2026-10-09）渲染：SVG 渲染器的 padding 改为可配置常量（polygon、highlight、selection-outline 三类图层都生效）；底图区域层设置 minZoom（`us` 不设 maxZoom，因为南加州、Yuma、夏威夷只有 `us` 覆盖）；所有底图使用 `updateWhenZooming: false`；点击 ZIP 后不显示浏览器焦点框。 |
| | MAP-PERF（2026-11-11）：区域层已覆盖全部运营区，us 改为 maxZoom 6，hawaii minZoom 7 |
| M2 | （MAP-R1）视觉层级为 **选中 > 悬停 > 普通 > 淡化**；数值集中在 `web/map-state.js` 的 `POLYGON_STYLE` 常量中。悬停不再使用白色描边。**取代 RM5-AC1 中“地图样式与 RM4 完全相同”和 RM7 中“不改描边”的要求。** |
| M3 | （2026-10-09）Product Owner 本人把淡化描边的不透明度调为 0.23（`POLYGON_STYLE.dimmed.opacity`）。 |
| M4 | （MAP-R1b，2026-10-09）地图页的地图更大、字更大：只在 `web/styles.css` 末尾的 `MAP-R1b` 区块中覆盖，范围限定为 `.map-page`。 |
| M5 | （MAP-R2a，2026-10-13）**线路颜色在地图上饱和度更高、更容易分区**：只对地图 polygon 的填充色做 HSL 变换（色相不变，饱和度 ×1.4、亮度 −0.06）。`routeColor` 的调色板、右侧栏色块、线路画像页都不变；难度色不变。数值来自 Claude 在真实 Chrome 中的预览（普通填充 0.34、描边 `#334155` 0.5 / 0.8px；选中线路 0.62；淡化 0.14 / 描边 0.3，在 M3 的基础上按同一方向加深）。 |
| M6 | （MAP-R2a）新增 **focused** 状态：没有选中线路时，站点聚焦或 DSP 过滤中**匹配**的 ZIP 比普通状态更突出（填充 0.42、描边 0.65）。**取代 RM7-3 中“匹配项保持原样式”的表述**；淡化的判定不变。 |
| M7 | （MAP-R2a）**地图直接显示 Route 编号**：不需要开关，不限着色模式。每条 Route 只显示一次尾号（`SFO01-021` → `021`）；锚点在主要覆盖区域内（面积加权质心，不在线路内时改用最近成员 ZIP 的内部点）；缩放 ≥ 11 时显示，缩远时隐藏（选中线路从 9 开始显示，并且更突出）；按优先级避让其他标签和仓库 marker；标签不响应鼠标，不影响任何现有交互。 |

### RM9-2 约束

- MVR Phase 3：新增仓库外 runtime/basemap/service.pmtiles，来源为 Protomaps 20261110 构建，z11–14、约 915 MB，覆盖 `config/basemap-service-region.json` 中 52 个 Station 服务区 bbox（各含 0.05° 边距）；前端按联合范围请求并保留区域底图回退，详见 `map-visual-refresh.md` 第 10 节。

- 正式 3000 会直接读取 `web/` 文件，并且服务端的静态白名单是固定的：本节的改动**不新增 web 文件，也不新增 import 路径**（见 WH-FIX1）。`map-view.js` 因此会变长，已记入 `docs/tech-debt.md`。
- 标签和颜色只是前端呈现，不改 `/api/route-map*` 的返回结构。

### RM9-3 验收

见 `.handoff/briefs/MAP-R1-rendering.md`、`MAP-R1b-scale.md`、`MAP-R2a-vivid-labels.md` 中的 AC。浏览器实测结果记录在本节的实现记录中。

---

## RM10 — 线路编号标签：按线路模式、短编号、多区域、低存在感（**Approved**，Product Owner 2026-10-29）

在 RM9-M7 的标签基础上调整。**与 RM9-M7 冲突时以本节为准。** 数据、API、选择 / 淡化 / 聚焦的判定逻辑都不变；仍然**不新增 web 文件、不新增 import 路径**（RM9-2）。

### RM10-1 Product Owner 决定

| # | 决定 | 取代 |
|---|---|---|
| L1 | 只在**按线路**着色模式下显示编号；切到按难易度时全部隐藏，切回来时恢复。 | M7“不限着色模式” |
| L2 | 只显示尾号的数字值，去掉前导零：`SFO01-021` → `21`，`RNO01-003` → `3`，`X-000` → `0`。尾号不是纯数字时原样显示（例如 `A12`）。 | M7 的 `021` |
| L3 | 一条线路有多个明显分离的覆盖区域时，每个区域可以有一个相同编号；用规则限制密度（见 RM10-2）。 | M7“每条 Route 只显示一次” |
| L4 | 样式：深灰文字 + 浅色 halo，不用黑框。普通标签低存在感但看得清；选中线路的编号更明显（更大、更深、浅色半透明底）；淡化的编号更淡但仍可读。 | M7 选中时黑底白字 |
| L5 | 缩放太远时隐藏或减少：保留 M7 的阈值（普通 ≥ 11，选中线路 ≥ 9）；**次要区域**的编号只在 ≥ 12 时显示（选中线路的次要区域 ≥ 10）。 | — |

### RM10-2 多区域规则（Claude 设计）

- 分区：同一 Route 的成员 ZIP polygon，按经纬度包围盒判断是否相连（包围盒间距 ≤ 容差视为同一区域，容差为可配置常量，初始 0.01°）。用并查集合并，结果是这条 Route 的若干区域。
- 每个区域按现有方法计算锚点（面积加权质心；不在区域内时用最近成员 ZIP 的内部点）。
- 面积最大的区域为**主区域**。其他区域只有在面积 ≥ 主区域面积 × 25% 时才生成标签；每条 Route 最多 3 个标签。以上数值都是可配置常量。
- 布局时：主区域的标签优先于同优先级的次要区域标签；同一 Route 的两个标签在屏幕上距离小于 160px 时，只保留先放下的那个。现有的避让（其他标签、仓库 marker、视口外）继续生效。

### RM10-3 验收标准

- RM10-AC1：按难易度模式下所有编号隐藏；切回按线路后，按原有规则显示。
- RM10-AC2：`SFO01-021` 显示 `21`，`RNO01-003` 显示 `3`；`X-000` 显示 `0`；`A12` 这类非数字尾号原样显示；空名称仍然没有标签。
- RM10-AC3：一条 Route 有两个分离区域且面积都达到阈值时，生成两个锚点，各自在对应区域内；面积太小的区域不生成；同一 Route 不超过 3 个。
- RM10-AC4：同一 Route 的标签在屏幕上距离小于 160px 时只显示一个；次要区域按 L5 的缩放阈值显示。
- RM10-AC5：CSS 不再有黑底白字；普通 / 选中 / 淡化三档在真实 Chrome 中能区分，选中的最明显。
- RM10-AC6：标签不响应鼠标，hover / click / 选择 / 搜索 / DSP 过滤 / 仓库层行为都不变；缩放动画过程中不重新布局，也不重新计算几何（RM9 现有测试继续通过）。
- RM10-AC7：Claude 在真实 Chrome 中检查 SFO01 等线路密集区域：标签不重叠，不显得杂乱。

### RM10 实现记录

- 第 1 轮修复：按 Claude 的 Chrome 审查反馈，将 `.route-label--dimmed` 不透明度从 0.5 提高到 0.65，改善街道级底图上的可读性，并同步更新 CSS 测试断言。
- `routeLabelText` 使用字符串去除纯数字尾号的前导零，保留非数字尾号和空值行为，避免长数字转换丢失精度。
- `ROUTE_LABEL_REGIONS` 集中配置包围盒容差 0.01°、次要区域面积比 0.25 和最多 3 个标签。Polygon / MultiPolygon 的 polygon 按包围盒通过并查集合并；区域内沿用面积加权质心及内部点回退，锚点增加 `primary`，`weight` 为区域面积。几何仍只在构建标签时计算。
- 标签仅在线路模式布局；相同交互优先级先排主区域，再按区域面积排序。次要区域提高一级缩放阈值，同 Route 已放置中心距离小于 160px 时隐藏；视口、其他标签和仓库避让继续保留。
- 普通标签改为深灰文字、白色半透明 halo、0.85 不透明度；选中为 14px 深色文字、浅色半透明底、1 不透明度；淡化为 0.5。同步调整碰撞矩形尺寸。
- 更新 R2a 断言：尾号和锚点文本不再保留前导零；MultiPolygon 权重从整条线路总面积改为当前区域面积；难易度模式改为全部隐藏并验证切回恢复；CSS 从黑底白字 15px 改为浅底深字 14px，淡化不透明度改为 0.5。缩放缓存测试在动画结束前切回线路模式，以继续验证实际布局及几何缓存。
- 新增测试覆盖分离区域内部锚点、25% 面积阈值、最多 3 个、MultiPolygon 分区、容差及传递合并、主区域优先、160px 严格边界、普通及选中次要区域缩放阈值。
- 验证：定向测试 48/48；全量 `npm.cmd test` 609/609（`npm test` 被 PowerShell 的 `npm.ps1` 执行策略拦截，使用同一 npm 的 cmd 入口完成）；无 lint / build 脚本。`git diff --check` 通过。
- 通过 Playwright 启动真实 Chrome（headless），只读检查现有 `http://127.0.0.1:3000/map`：地图加载 445 个 polygon、98 个标签；SFO01 放大后按 CSS display 统计标签为 5 → 难易度模式 0 → 线路模式恢复 5，无 pageerror。标签 marker 为零尺寸，不能用 Playwright `:visible` 统计其文本显示。首次中文按钮定位因 PowerShell 管道编码失败，改用模式按钮索引完成验证。
- AC1–AC4 自动化通过；AC5 样式已实现，真实浏览器三档视觉效果仍待 Claude 复核；AC6 自动化回归通过；AC7 密集区域视觉验收和 Product Owner 预览签核待完成。未提交、推送或部署，未访问 DMS，未修改数据库结构或业务数据；全量测试包含既有独立测试库用例。

### RM10b — 编号默认可见，按缩放分档（**Approved**，Product Owner 2026-10-29）

**取代 RM9-M7 / RM10-L5 中的缩放阈值**（普通 ≥ 11、选中 ≥ 9、次要区域 +1）。RM10 的 L1–L4 和多区域规则不变。

| # | 决定 |
|---|---|
| B1 | 按线路模式下，任何缩放级别都显示编号，不再有最小缩放；按难易度模式下全部隐藏（不变）。 |
| B2 | 按缩放分三档（阈值和数值都是 `ROUTE_LABEL` 中的常量）：**远** zoom < 10：字更小、更淡，碰撞框外加较大的留白，让标签稀疏；**中** 10 ≤ zoom < 12；**近** zoom ≥ 12：沿用 RM10 现在的样式。 |
| B3 | 继续使用碰撞 / 避让逻辑，挤不下的自动省略；优先级不变：选中 > 聚焦 > 普通 > 淡化，同级先主区域、再按面积。 |
| B4 | 选中线路的编号在任何缩放下都显示（仍然要在视口内，不和仓库 marker 重叠），并且比同档其他编号更明显。 |
| B5 | 次要区域：选中线路任何档都显示；其他线路只在中档和近档显示。 |

验收：
- RM10b-AC1：按线路模式下，zoom 7、9、10、12 都有编号显示；按难易度模式下全部隐藏。
- RM10b-AC2：三档的字号、透明度、留白不同，远档最小、最淡、最稀疏；碰撞框尺寸和字号一致，标签之间不重叠。
- RM10b-AC3：选中线路在远档也显示，并且比其他编号明显。
- RM10b-AC4：其他线路的次要区域在远档不显示；选中线路的次要区域在远档也显示。
- RM10b-AC5：缩放动画过程中不重新布局，也不重新计算几何（RM9 / RM10 现有测试继续通过）。
- RM10b-AC6：Claude 在 Chrome 中检查片区总览（District Overview）和站点级别：远距离时不乱，不重叠。


#### RM10b Implementation Notes

- Removed minimum zoom and secondary offsets. Frozen `ROUTE_LABEL.tiers` defines far (<10), mid (<12), near dimensions and 10/5/2px padding. Pane classes change only when the tier changes. CSS uses 10/11/12px ordinary text, .7/.8/.85 opacity, and 13/13/14px selected text at full opacity.
- Collision rectangles expand on all sides; viewport culling uses unpadded bounds. Selection and primary-region priority, 160px deduplication, warehouse avoidance, difficulty-mode hiding, animation guards and geometry caching remain. Far secondary regions require selection.
- Updated old assertions: ordinary labels now appear at zoom 10; other routes at zoom 9 and labels at zoom 8 participate in layout. Ordinary secondary regions start at mid zoom 10 instead of 12; selected secondary regions appear at zoom 9. Strict 160px boundary remains.
- Added coverage for zoom 7/9/10/12 pane classes and mode switching, 30px-separated labels conflicting only at far padding, unpadded viewport bounds, CSS tiers, far selection priority, warehouse avoidance and offscreen selection.
- Final targeted tests: 51/51. Full `npm.cmd test`: 611/611; the subsequently added far selected warehouse/viewport test passed in the final targeted run. `git diff --check` passed. No lint/build scripts exist.
- AC1-AC5 implemented and covered by automated tests. AC6 awaits Claude Chrome review at District Overview and Station levels, followed by Product Owner preview sign-off. No real-browser check this round. Existing uncommitted RM10 changes preserved; no commit, push, deployment, DMS access, business-data or database-schema changes. Full tests include existing isolated test-database cases.

### RM10c — 编号更大、更明显（Product Owner 2026-10-29）

Product Owner 反馈 RM10b 的编号“太不明显”。数值由 Claude 在真实 Chrome 中预览确定，**取代 RM10 / RM10b 中的字号和透明度**；分档、碰撞、优先级规则不变。

| 档位 | 普通 | 淡化 | 选中 |
|---|---|---|---|
| 远（< 10） | 14px，opacity .95 | .7 | 17px |
| 中（10–11） | 15px，opacity 1 | .75 | 17px |
| 近（≥ 12） | 16px，opacity 1 | .8 | 18px |

文字 `#0f172a`，粗细 700，halo 加强为 `0 0 2px #fff, 0 0 3px #fff, 0 0 6px rgba(255,255,255,.95)`。选中标签的浅底样式不变。碰撞框尺寸按新字号同步放大。

- RM10c Implementation Notes (2026-10-29, Codex): Updated tier font sizes, opacity, halo and collision dimensions; retained selected background, padding and layout logic. Updated CSS/constants assertions and viewport fixture (8 to 9px). Targeted tests 51/51; npm.cmd test 612/612; git diff --check passed with line-ending warnings only. No lint/build scripts. Real-browser review and Product Owner preview sign-off remain pending. Preserved existing uncommitted changes; no commit, push, deployment, DMS access, business-data or database-schema changes. Full tests include existing isolated test-database cases.

### RM10d — 编号跟随区域的淡化 / 选中状态（Product Owner 2026-10-29）

规则：编号的透明度和强调程度要和对应 Route 的 polygon 当前视觉状态一致。站点聚焦时其他站点、DSP 筛选不匹配、选中某条线路时的其他线路，这些区域被淡化后，编号一起淡化；选中线路的编号最明显；普通的正常显示。不能出现 polygon 已经变淡、编号仍然很亮的情况。

Claude 检查：判定逻辑已经和 `polygonStyle` 一致（`labelPriority`：选中 = 0，聚焦匹配 = 1，普通 = 2，所有成员 ZIP 都淡化 = 3）。问题出在 RM10c 把淡化编号的透明度调到了 .7–.8，视觉上和普通编号差不多。修改：各档的淡化编号统一为 `opacity: .38; color: #475569; font-weight: 600`（数值由 Claude 在 Chrome 中预览确定）。

- RM10d Implementation Notes (2026-10-29, Codex): Consolidated dimmed CSS into `.route-label.route-label--dimmed` after tier rules (opacity .38, color #475569, weight 600); removed far/mid dimmed overrides without changing ordinary/selected styles or logic. Added station-focus, DSP-filter and route-selection label/polygon consistency checks at zoom 7/10/12, and updated CSS assertions. Targeted tests 52/52; npm.cmd test 613/613; git diff --check passed with line-ending warnings only; no lint/build scripts. Headless Playwright Chromium computed-style checks confirmed all three tiers; full map browser regression and Product Owner preview sign-off remain pending. Existing uncommitted changes preserved; no commit, push, deployment or DMS access; no business-data/schema changes (full suite includes existing isolated test-database cases).

### RM10e — 编号加半透明浅色底（Product Owner 2026-10-29）

目标：编号在复杂底图上更容易看，但不变成很抢眼的 marker。数值由 Claude 在 Chrome 中预览确定。Product Owner 手动把远档字号调成了 18px，本节保留这个值，其他字号不变。

- 普通：数字 `#334155`；底 `rgba(255,255,255,.72)`，padding `0 4px`，圆角 2px，细描边 `0 0 0 1px rgba(15,23,42,.08)`；去掉 text-shadow halo。
- 选中：底 `rgba(255,255,255,.95)`，数字 `#0f172a`，padding `1px 5px`，圆角 3px，`box-shadow: 0 0 0 1px rgba(15,23,42,.3), 0 1px 3px rgba(15,23,42,.2)`。
- 淡化：opacity 作用在整个标签上，数字和底一起淡化为 `.4`，数字 `#475569`。

- RM10e Implementation Notes (2026-10-29, Codex): Added ordinary/selected translucent chips and borders, removed text-shadow, and set outer dimmed opacity to .4; preserved far 18px, all other font sizes/line-heights, collision constants and logic, and existing uncommitted changes. Updated CSS assertions; targeted tests 52/52, npm.cmd test 613/613 (includes existing isolated test-database cases), git diff --check passed with line-ending warnings only; no lint/build scripts. Headless Playwright Chromium confirmed computed styles in all three tiers; full map browser regression and Product Owner preview sign-off remain pending. No commit, push, deployment, DMS access, business-data or schema changes.

---

## RM11 — 目标区域强调 + 相邻线路避色（**Approved**，Product Owner 2026-10-29）

前端呈现的改动，不改 API 和数据。**与 RM9-M5 / M6 的数值和 RM2 “颜色由 route_id hash 固定”冲突时，以本节为准。** 仍然**不新增 web 文件**。

### RM11-1 目标区域更明显（Product Owner 决定）

- **目标** = 选中的 Route，或站点聚焦 / DSP 筛选中匹配的区域（现有的 `selectedRoute` / `focused` 状态）。目标区域的颜色更深、更饱和，fill opacity 提高。
- **淡化** = 现有的 `dimmed` 状态。降低饱和度和透明度，但仍然能看清。
- 两者之间要有明显的颜色 / 填充差异，不只靠边框区分。没有筛选时的 `normal` 状态不变。
- 饱和度和亮度的变换**只在按线路模式下生效**。按难易度模式下难度色的含义不变，只沿用现有的透明度层级（Claude 决定：避免难度色偏离 legend）。
- 初始数值（`POLYGON_STYLE` / `ROUTE_FILL` 中的常量，Claude 会在 Chrome 中调整）：
  - 目标：在 vivid 色的基础上饱和度 ×1.2、亮度 −0.05；`focused.fillOpacity` .42 → .52，`selectedRoute.fillOpacity` .62 → .7。
  - 淡化：在 vivid 色的基础上饱和度 ×0.45、亮度 +0.06；`dimmed.fillOpacity` .14 → .16。
- 编号跟随这个层级：目标区域（聚焦匹配，priority 1）的编号使用新 class `route-label--focused`，数字 `#0f172a`，底 `rgba(255,255,255,.9)`；选中和淡化的样式不变（RM10e）。

### RM11-2 相邻线路避色（Product Owner 决定，算法由 Claude 设计）

- 只要求**共享边界的 Route** 颜色不同、并且不太接近；不要求全地图唯一。selected / dimmed 仍然叠加在分配到的基础色之上。
- **邻接**：两条 Route 的 ZIP polygon 共享 ≥ 2 个顶点（坐标保留 5 位小数作为 key）时视为相邻。Census ZCTA 的相邻边界共用顶点，Claude 实测：北加州 97 条 Route、192 对相邻、每条最多和 9 条相邻，计算约 80ms。只碰到一个角不算相邻。
- **颜色距离**：对 `vividRouteColor(color)` 计算 CIE Lab ΔE（CIE76），阈值 `minDeltaE = 30`（常量；第 1 轮审查按 Product Owner“一眼能区分”的要求从 20 提高：ΔE 21.3–25.5 的相邻色仍较相似。此阈值同步适用于 AC1 / AC6 的色差检查；Claude 页面模拟的 5 个片区均满足，最小 ΔE 为 33.5）。
- **分配**（纯函数，确定性：相同输入一定得到相同输出）：
  1. 按相邻数从多到少排序，相同时按 `String(route_id)` 排序。
  2. 每条 Route 的首选色是原来的 `routeColor(route_id)`（没有冲突时颜色不变，减少变化）。首选色和已分配的相邻 Route 的 ΔE 都 ≥ 阈值时，就用首选色。
  3. 否则从首选色在 palette 中的下一个位置开始，循环寻找第一个满足阈值的颜色。
  4. 都不满足时，选和相邻 Route 最小 ΔE 最大的颜色。
- **范围**：每次加载片区数据（`/api/route-map/district`）时，对整个片区的 features 计算一次。地图 polygon 和右侧栏线路色块使用**同一份**分配结果，保证一致。换站点聚焦 / DSP / 选择时不重新计算，颜色不会跳。没有分配结果的 Route（例如 ZIP 搜索带出来的片区外 Route）回退到 `routeColor`。
- **已知影响**：同一条 Route 的颜色由所在片区的邻接关系决定，数据刷新导致邻接变化时，颜色可能变化。线路画像页不使用 `routeColor`，不受影响。
- 基线（现有 hash 分配，Claude 实测）：北加州 193 对相邻中同色 4 对、ΔE < 20 的 8 对；南加州 450 对中同色 20 对、ΔE < 20 的 21 对。

### RM11-3 验收标准

- RM11-AC1：`assignRouteColors` 是纯函数，结果确定；两条共享边界的 Route 不同色；只碰角不算相邻；没有冲突时保留 `routeColor`；冲突时换色后 ΔE ≥ 20；无解时取最小 ΔE 最大的颜色。
- RM11-AC2：地图 polygon 和侧栏色块使用同一份分配结果；切换站点聚焦 / DSP / 选中 / 着色模式时不重新计算；没有结果时回退到 `routeColor`。
- RM11-AC3：按线路模式下，目标区域的颜色变换和 fill opacity 按 RM11-1 生效，淡化区域去饱和；按难易度模式下难度色不做变换；`normal` 不变。
- RM11-AC4：聚焦匹配的编号有 `route-label--focused`，样式按 RM11-1。
- RM11-AC5：hover、click、选择、搜索、仓库层、标签布局行为都不变；现有测试继续通过（断言因为本节数值改变而失效时，逐条说明）。
- RM11-AC6：Claude 在 Chrome 中检查北加州、南加州的密集区域：相邻 Route 一眼能区分；在页面里重新统计，相邻 Route 中同色 0 对，ΔE < 20 的尽量为 0（没有达到时说明原因）；目标区域和淡化区域的差异足够明显。

### RM11 Implementation Notes (2026-10-29, Codex)

- Added pure `assignRouteColors`: deduplicated five-decimal vertex keys across Polygon/MultiPolygon rings, shared-vertex adjacency, degree-descending/string-ID ordering, sRGB D65 CIE76 distances after vivid conversion, cyclic first-fit and maximin fallback. Frozen configuration lives in `ROUTE_COLOR_ASSIGN`; palette/hash and source features remain unchanged.
- `map.js` computes one assignment per successful district load and shares it with view/panel. Polygon paths (including hover and searched ZIP highlights) and panel swatches retain it across interactions; missing entries fall back to hash colors.
- Reused HSL conversion for vivid/target/dimmed fills. Focused/selected-route/dimmed opacity is .52/.7/.16; selected ZIP remains .8. Difficulty colors are unchanged. Priority-1 labels toggle `route-label--focused`; selected/dimmed CSS takes precedence. Existing RM10 changes, far 18px font and geometry/collision rules are preserved.
- Updated prior assertions individually: RM2 selected fill expects target `#cca300`; DS focus expects target/dimmed route fills while difficulty colors remain unchanged; RM7 DSP expects dimmed route fill without explicit selection; R2a focused hierarchy expects target/dimmed route fills; RM5 mode-switch searched-highlight expects selected target fill on returning to route mode. Border, hierarchy and interaction assertions remain.
- Added tests for purity/determinism, corner-only separation, closing-vertex deduplication, coordinate precision, CIE76/cyclic choice, overconstrained-clique maximin fallback, transform values, difficulty invariance, shared render arguments, persistent view/panel colors, fallback and focused labels.
- Verification: targeted 57/57; full npm.cmd test 618/618, including existing isolated test-database cases. No lint/build scripts. One overlapping full-test rerun did not start because PowerShell could not reopen the active log; the previous suite completed successfully.
- Headless Playwright Chromium loaded the existing local map: HTTP 200, 445 polygon paths, 98 labels, 37 focused labels, far font 18px, no page errors. This was a loading smoke check. AC1-AC5 have automated coverage; AC6 remains with Claude in Chrome, followed by Product Owner preview sign-off. Legacy price-sheet/analytics pages were not manually rechecked.
- No commit, push, deployment, DMS access, dependency/API changes, production data or schema changes. REQUIREMENTS.md is absent; requirements came from the approved route-map spec.

- RM11 review round 1 (2026-10-29, Codex): Raised minDeltaE from 20 to 30 for clearer adjacent-route distinction; updated three threshold assertions and added an explicit configuration assertion. Targeted tests 57/57; npm.cmd test 618/618 (including existing isolated test-database cases); git diff --check passed with a line-ending warning only. No lint/build scripts; Chrome visual recheck and Product Owner preview sign-off remain pending. Existing uncommitted changes preserved; no commit, push or deployment.

## RM12 — All Stations 全部视为 active（**Approved**，Product Owner 2026-10-29，轻量改动）

只改前端呈现，不改 API 和数据。**与 RM11-1 中“没有筛选时 `normal` 状态不变”冲突时，以本节为准。**

- 按线路模式下，没有选中 Route、没有站点聚焦（All Stations）、也没有 DSP 筛选时，所有 Route 都使用和站点聚焦时目标区域相同的 `focused` 样式：颜色按 `ROUTE_FILL.target` 变换，fill opacity 和边框也相同。不因为 All Stations 整体变淡。
- 单站点聚焦、DSP 筛选、选中 Route 时的行为不变：目标区域 `focused` / `selectedRoute`，其余 `dimmed`。
- 编号跟随 polygon 状态（RM10d）：All Stations 下的编号都是 `route-label--focused`。
- 按难易度模式不变：没有筛选时继续使用 `normal`（`difficultyFillOpacity`）。
- `POLYGON_STYLE.normal` 常量保留，难易度模式仍然使用它。

验收标准：
- RM12-AC1：按线路模式、无选择、`focusStation === null`、`dsp === null` 时，`polygonStyle` 的返回值和同一 Route 在站点聚焦匹配时相同。
- RM12-AC2：按难易度模式下，无筛选时的返回值不变。
- RM12-AC3：单站点、DSP、选中 Route 时的返回值都不变；hover 在 focused 基础上叠加。
- RM12-AC4：All Stations 时编号都有 `route-label--focused`，碰撞布局不变。
- RM12-AC5：Claude 在 Chrome 中检查北加州 All Stations：整张地图的饱和度和单站点聚焦时的目标区域一致。

### RM12 Implementation Notes

- 2026-10-29 (Codex): Added route-mode fallback to focused in polygonStyle; map-view priority/collision logic, constants and far 18px CSS unchanged. Updated old normal assumptions individually: RM2 fill/color and unowned ZIP transitions now focused; RM5 unfiltered difficulty borders remain normal; R1 route opacity now focused; R2a unfiltered route/focus opacity equality; RM11 unfiltered target transform; web initial/mouseout/clear styles now focused; district-map unfiltered colors equal station-focused colors. Added complete style/filter/selection/hover and All Stations focused-label coverage. Targeted tests 59/59, final npm.cmd test 623/623 (existing isolated test DB), git diff --check passed (line-ending warnings only); earlier runs exposed old assertions, corrected before final rerun. No lint/build scripts. Existing local /map HTTP 200; headless Chromium loaded 445 paths/98 labels without page errors (loading smoke only). AC1-AC4 automated; AC5 Claude Chrome check and Product Owner preview sign-off pending; legacy pages not manually rechecked. Existing spec edits preserved; no API/data/schema/dependency changes, DMS access, commit, push or deployment.

## RM13 — 页面视觉改版（参考图）（**Approved**，Product Owner 2026-11-02）

Product Owner 提供参考图 `线路画像Ui改动.png`（仓库根目录，未加入 Git；副本 `.handoff/RM13-reference.png`），说明“不用完全一样，奇怪的地方按 Claude 的理解处理”。参考图画的是**线路地图页**。只改前端呈现，不改 API、数据和交互逻辑；**不新增 web 文件**（静态文件白名单），图标用内联 SVG。

### RM13-1 顶部标题栏（两个页面共用）

- 一行：左侧是青色竖条 + `NC OPS CONSOLE`（小号、字距加宽），一条竖分隔线，然后是页面图标和页面标题（地图页：地图图标 + “线路地图”；画像页保留“美西线路画像”和英文副标题）。右侧是页面切换（线路档案 / 线路地图），当前页是填充的深青色按钮，下边缘带青色高亮，其他是普通文字。
- 线路画像页只换这个标题栏，表格、筛选区和 ZIP 搜索的布局不变（Claude 决定：参考图没有画线路画像页，避免猜测）。

### RM13-2 地图页工具栏

- 标题栏下面是一张圆角卡片（工具栏）：左侧是 片区 / 站点 / DSP 三个下拉框，标签在框的左边；右侧是 “DMS 快照 · 更新于 <时间>” 和一个带图标的「更新记录」按钮（打开现有的更新记录弹窗）。“管理仓库”和 3100 上的“刷新数据”按钮也放在这一侧，不改变它们的显示条件。
- 原来在页面上方占好几行的内容收起：
  - 数据来源说明、各 Station 的数据时间明细，放进现有的“数据时间明细”折叠区，或者放进更新记录弹窗，**默认不展开**；
  - **警告类信息仍然直接显示**：最近一次刷新失败、正在更新、需要重新登录、加载错误、底图缺失、仓库提示等。有内容时在工具栏下方显示一行提示条，没有内容时不占空间。不能因为改版而隐藏这些警告。
  - 「更新于」的显示（第 0 轮 Codex 指出：现有 `#map-updated` 显示的是各 Station 名称和时间的完整列表，不是单个时间；Claude 决定如下）：
    - 选中单个 Station：显示该 Station 的数据时间；
    - 片区总览：只有一个时间时直接显示；有多个时间时显示**最早 – 最新**的范围（例如 `2026-10-14 10:02 – 2026-10-29 17:14 PDT`）。不只显示最新时间，避免掩盖过期的 Station。
    - 各 Station 名称和时间的完整列表移到默认折叠的“数据时间明细”中，内容不变。
    - 时间格式沿用现有的格式化函数。
  - “DMS 快照，非实时数据”的含义保留（例如写成 “DMS 快照 · 更新于 …”）。

### RM13-3 地图卡片

- 地图是大圆角卡片（约 12px），尽量占满工具栏下方的高度（桌面端约 `calc(100vh - 标题栏 - 工具栏 - 边距)`，最小约 480px）。
- 缩放按钮：白色方形圆角按钮，上下排列。“定位站点 / 定位片区”改为缩放按钮下方的定位图标按钮（准星图标），保留原来的 `aria-label` / `title` 文字和行为。
- 着色模式（按线路 / 按难易度）：右上角深色胶囊形分段按钮，选中项是青色填充、深色文字。

### RM13-4 右侧线路栏

- “线路”卡片：标题较大；搜索框带放大镜图标，placeholder 改为“搜索线路编号或邮编”。线路列表每行是一张带边框的圆角小卡片：左边是色块，中间是线路名称，右边是 “N ZIP”。列表固定高度、内部滚动。选中 / hover 状态沿用现有逻辑，只调整样式。
- 当前邮编、线路概览、地图覆盖率、缺少边界的邮编等其他卡片保留，使用同样的卡片样式，放在线路卡片下面。

### RM13-5 通用

- 深色背景，统一的卡片背景、边框和圆角；青色作为强调色。
- 390px 宽度：工具栏换行，不出现横向滚动；地图和侧栏上下排列。
- 现有元素的 id、`data-map-text`、aria 属性保持不变，JS 逻辑不改（只允许为了放置位置做必要的 DOM 调整）。

### RM13-6 验收标准

- RM13-AC1：两个页面的标题栏按 RM13-1；画像页其他部分不变。
- RM13-AC2：地图页工具栏按 RM13-2；警告类信息有内容时仍然可见，没有内容时不占空间；更新记录弹窗可以打开。
- RM13-AC3：地图卡片、缩放 / 定位按钮、着色模式切换按 RM13-3，行为不变。
- RM13-AC4：右侧线路栏按 RM13-4，搜索、选择、ZIP 搜索行为不变。
- RM13-AC5：390px 下没有横向滚动；现有测试通过（因为 DOM 位置改变而失效的断言逐条说明）。
- RM13-AC6：Claude 在 Chrome 中对照参考图检查桌面和 390px 两种宽度。

### 实现记录（Implementation Notes）— RM13

- 2026-11-02：标题栏共用视觉样式；画像页只调整标题栏包装。地图筛选和数据操作移入工具栏；地图数据来源与 Station 完整时间列表放入默认折叠明细，刷新失败、登录过期及其他状态提示保留在折叠区之外。画像页的数据状态布局保持原样。
- `mapUpdatedSummary` 按实际时间排序并复用 `formatUpdated`，单站显示单个时间，片区显示最早至最新范围；同一时刻的不同 ISO 表达不产生重复范围。
- 定位按钮使用内联 SVG，保留点击行为并按站点／片区更新 `aria-label` 和 `title`；更新记录按钮和搜索框也使用内联 SVG。未新增 web 文件、依赖或数据字段。
- 测试断言调整：搜索 placeholder 使用批准的新文案；定位按钮从文字断言改为可访问名称断言，原定位行为检查保留；旧 R1b 样式检查限定于自身区块，新 RM13 样式另行检查；外部 URL 检查仅豁免 SVG namespace（不是网络资源），HTML 注入和其他外部 URL 检查保留。
- Playwright headless 已检查运行中的 `http://127.0.0.1:3000/map`：1440×900 和 390×900 截图位于 `.handoff/RM13-desktop.png`、`.handoff/RM13-mobile.png`，390px 下 `document.documentElement.scrollWidth` 为 390，无页面 JavaScript 异常；确认明细默认折叠、更新记录弹窗、线路选择、定位及难易度切换可用。截图含内部现有运行数据，仅留本地，不提交。AC6 仍待 Claude 在 Chrome 中检查，并待 Product Owner 预览签核。
- 浏览器模拟 freshness 返回刷新失败及登录过期状态，实测两条提示均可见且不在 details 内；画像页标题和原站点筛选仍正常。`npm.cmd test` 全量通过；无 lint / build 脚本。`git diff --check` 通过（仅有现存 LF/CRLF 提示）。未执行 DMS、提交、推送、部署或生产数据库操作。
- 2026-11-02 第 2 轮修复：仅取消地图页最大宽度，清理旧边距规则，保留桌面左右 24px／移动端 12px；正常加载成功的消息复用 `.sr-only`，文字和 aria 属性不变，加载中、失败、无数据、无边界及详情警告仍可见；新增状态切换测试并将旧宽度断言更新为 `none`。`npm.cmd test` 633/633 通过（含已有隔离测试数据库用例），无 lint/build 脚本；`git diff --check` 通过（仅 LF/CRLF 提示）。Playwright 实测 2327px、1440px 满宽和 390px 无横向滚动，成功消息视觉隐藏、模拟失败消息可见；待本轮预览签核。未访问 DMS，未修改业务数据或数据库结构，未 commit/push/部署。

## RM13b — 视觉改版第 2 版（参考图 2.0）（**Approved**，Product Owner 2026-11-02）

Product Owner 提供新的参考图 `线路画像2.0.png`（仓库根目录，未加入 Git；副本 `.handoff/RM13b-reference.png`），说明“不好看的地方按 Claude 的想法处理”。在 RM13 的基础上修改，规则同 RM13-5（不新增 web 文件、不改逻辑、保留 id / aria、警告可见）。

1. **品牌**（两个页面共用的标题栏）：左侧改为青色地图轮廓图标 + 品牌名，取代竖条和 `NC OPS CONSOLE`。品牌名前半部分是青色，后半部分是白色，字号较大、加粗。竖分隔线后面是页面标题（地图页“线路地图”，不再带图标；画像页“美西线路画像”和英文副标题不变）。
   - **品牌名（Claude 决定）**：参考图写的是 “NorCal & SoCal Ops Dashboard”，但现在的片区还包括丹佛、西雅图、凤凰城，这个名字不准确。改用 **“West Region Ops Dashboard”**（“West Region” 青色），和画像页的 “West Region Route Profile” 一致。品牌名放在一个常量 / 一处 HTML 中，方便以后修改。
2. **工具栏**：右侧文字改为 `数据更新时间：<时间>`（时间规则同 RM13-2）。“DMS 快照，非实时数据”的说明不在工具栏中显示，改为这段文字的 `title` 提示，同时写在更新记录弹窗顶部。
3. **“数据时间明细”折叠区**从工具栏下方移到「更新记录」弹窗中（弹窗顶部一节，例如“各站点数据时间”，内容不变）。工具栏下方只保留有内容时才出现的警告提示条（RM13-2 的规则不变）。
4. **地图卡片**：1px 青色边框，加一层很淡的青色外发光。
5. **仓库图例**（地图左下角现有的 `.warehouse-legend`）：改为深色圆角胶囊，带细边框，仓库图标是白色线条，旁边是“仓库”。只改样式，显示条件不变。
6. 其他（缩放 / 定位按钮、着色模式切换、右侧线路栏、390px）保持 RM13 的效果。

验收标准：
- RM13b-AC1：两个页面的标题栏按第 1 条显示品牌名和页面标题。
- RM13b-AC2：工具栏按第 2 条显示；数据时间明细在更新记录弹窗中，可以看到完整列表；警告提示条规则不变。
- RM13b-AC3：地图边框、仓库图例按第 4、5 条显示。
- RM13b-AC4：390px 下没有横向滚动；现有测试通过（因为结构改变而失效的断言逐条说明）。
- RM13b-AC5：Claude 在 Chrome 中对照参考图检查。


### 实现记录（Implementation Notes）— RM13b

- 2026-11-02：两页标题栏共用 `data-status.js` 中唯一品牌常量（West Region / Ops Dashboard），通过 textContent 和内联 SVG 构造；页面标题保留，地图标题旁旧图标移除。未新增 web 文件或外部资源。
- 地图工具栏显示“数据更新时间”，DMS 快照说明置于 title（保留原 data-map-text 节点供辅助技术读取），并显示在更新记录弹窗顶部。地图时间明细移到弹窗独立 section，刷新记录异步加载或失败不会清除明细，周期刷新继续保留当前 Station 时间列表。画像页数据状态区布局不变。
- 地图增加 1px 青色边框和淡外发光；仓库图例为深色圆角胶囊，白色线条仅覆盖图例 SVG，marker 和显示条件不变。移动端图例抬高以避开地图署名。
- 断言调整：旧 RM13 明细位置断言改为弹窗归属，增加完整 4 个合成站点、时间、跳过原因及 DMS 说明检查；线路概览时间文案断言从“更新时间”改为“数据更新时间”，原值与行为断言保留。新增两页品牌挂载、唯一品牌常量渲染、图标 aria-hidden 和工具栏 title 测试。
- 检查：相关测试 51/51；npm.cmd test 全量 634/634 通过（包含项目原有隔离测试数据库用例）；无 lint / build 脚本。git diff --check 通过，仅有 LF/CRLF 提示。
- Playwright headless 检查现有本地服务 /map：1440×900 和 390×900，scrollWidth 分别为 1440 / 390；445 个 polygon path，弹窗含 54 个站点列表项，两页品牌正确，无 pageerror。浏览器拦截 freshness 响应模拟刷新失败和登录过期，两条提示均可见且不在 details/dialog 内。截图为 .handoff/RM13b-desktop.png、.handoff/RM13b-mobile.png，仅本地保留。未手动回归 legacy 价格表和 analytics 页面。
- AC1–AC4 技术检查通过；AC5 待 Claude Chrome 对照检查及 Product Owner 预览签核。未修改需求、验收标准、API、业务数据或数据库结构，未访问 DMS、commit、push 或部署；既有未提交改动保留。

## RM13c — 线路档案页视觉改版（参考图）（**Approved**，Product Owner 2026-11-02）

Product Owner 提供参考图 `线路档案.png`（仓库根目录，未加入 Git；副本 `.handoff/RM13c-reference.png`），规则和 RM13 / RM13b 相同：不用完全一样，不好看的地方按 Claude 的想法处理。只改线路档案页（`/`，`web/index.html`）的呈现，不改 API、数据、筛选 / 排序 / ZIP 搜索 / 详情弹窗等逻辑。不新增 web 文件；保留 id、aria 和事件；警告信息有内容时必须可见。

1. **标题栏**：沿用 RM13b 的共用标题栏（地图图标 + “West Region Ops Dashboard”，竖分隔线，页面标题“美西线路画像” + 英文副标题 “West Region Route Profile”，右侧页面切换）。参考图左上角还是旧的竖条 + 大写文字样式，**Claude 决定以 RM13b 为准**，两个页面保持一致。
2. **数据状态条**（一张圆角卡片，一行）：左侧数据库图标 + “DMS 快照，非实时数据”（加粗），竖分隔线，然后是数据来源说明和 Last Updated（现有 data-status 的内容）；右侧是「更新记录」按钮。3100 上的“刷新数据”按钮也放在右侧，显示条件不变。
   - “数据时间明细”和地图页一样放在「更新记录」弹窗中（RM13b-3，`data-status.js` 两个页面共用）。参考图把它画在状态条里，**Claude 决定与地图页保持一致**。
   - 警告（刷新失败、正在更新、需要登录、加载错误）有内容时显示在状态条下方的提示条中。
3. **筛选工具栏**（一张圆角卡片）：片区 / 站点 / DSP 下拉框（标签在左）；竖分隔线；时钟图标 + 两行文字“更新时间 / <时间>”（现有 `#updated`）；图层图标 + “线路总数 / <数量>”（现有 `#total`，筛选时仍然是“筛选数 / 全部数”）；竖分隔线；右侧是 ZIP 输入框和「搜索」按钮。ZIP 搜索结果（`#profile-zip-result`）显示在工具栏下方，有内容时才占空间。
4. **表格**：放在圆角卡片中；表头背景略深，列名加粗，可排序的列带排序图标（沿用现有排序状态）；行之间是细分隔线，hover 时行背景变亮；线路名称是青色链接；难度徽章保留现有颜色，圆角加大一点；数字列右对齐。
5. 390px：标题栏和工具栏换行，页面不出现横向滚动；表格在自己的滚动容器中横向滚动（现有 `.table-scroll`）。

验收标准：
- RM13c-AC1：标题栏和地图页一致，当前页是“线路档案”。
- RM13c-AC2：数据状态条、筛选工具栏按第 2、3 条显示；明细在更新记录弹窗中；警告和 ZIP 结果有内容时可见。
- RM13c-AC3：表格按第 4 条显示；排序、DSP 筛选、ZIP 搜索、点击线路打开详情的行为不变。
- RM13c-AC4：390px 下 `scrollWidth <= 390`；现有测试通过（因为结构改变而失效的断言逐条说明）。
- RM13c-AC5：Claude 在 Chrome 中对照参考图检查。

### 实现记录（Implementation Notes）— RM13c

- 档案页新增 `.profile-page` 样式作用域，沿用 RM13b 标题栏；状态卡片包含数据库 SVG、来源和 Last Updated、更新记录及原条件下的刷新按钮。通过现有 `map-data-actions` 挂载机制复用更新记录弹窗；`data-status.js` 仅新增可选的 `profile-data-summary` 宿主，地图页渲染路径保持不变。
- 筛选栏保留所有控件 id 和事件，更新时间、线路总数增加时钟 / 图层 SVG，ZIP 结果移到工具栏下方，空内容不占空间。表格增加卡片、分隔线、hover 和徽章圆角；排序 SVG 直接使用现有 `aria-sort` 状态，保留原箭头 span 供现有渲染更新，不修改 `app.js` 或筛选 / 排序 / ZIP / 详情逻辑。
- 新增档案页当前导航、更新时间、DSP 筛选数 / 全部数、排序 SVG 状态样式，以及状态卡片时间更新和明细弹窗归属测试；原有行为断言全部保留，没有因本次改版删除或改写断言。
- Playwright headless 使用现有本地 3000 服务检查 `/` 和 `/map`，1440×900、390×900 的页面 scrollWidth 分别为 1440、390；地图两种宽度均渲染 445 个边界。已检查排序图标循环、DSP 数量 / 时间、打开详情、ZIP 结果显示、更新记录明细；拦截 freshness 响应模拟刷新失败和登录过期，两条警告均在弹窗外可见；无 pageerror。
- 截图保存在 `.handoff/RM13c-desktop.png`、`.handoff/RM13c-mobile.png`，仅本地保留。未访问 DMS、未修改数据源或数据库结构、未重启服务、未提交 / 推送 / 部署。AC5 的 Claude Chrome 审查和 Product Owner 预览签收待后续完成；legacy 价格表与 analytics 未手动回归。
- 检查结果：`npm.cmd test` 全量 636 / 636 通过，定向测试 25 / 25 通过；`git diff --check` 无空白错误（工作区有 Git 的 LF / CRLF 提示）。项目没有 lint 配置或 build 命令。

## RM13d — 字体和字号统一（**Approved**，Product Owner 2026-11-02，轻量改动）

Product Owner 反馈：两个页面的字体和参考图不一样，字太小，看着累。按 Claude 的审美调整，只改 `web/styles.css`。

- **字体**：`"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif`（Windows 上中文用微软雅黑 UI，英文和数字用 Segoe UI）。数字列和时间统一使用 `font-variant-numeric: tabular-nums`。不引入外部字体（CSP / 局域网使用）。
- **字号层级**（桌面端；文字不小于 12px）：
  - 品牌名 22px / 700；页面标题 28px / 700；英文副标题 14px；页面切换 16px（当前页 600）。
  - 工具栏和状态条：标签 15px、下拉框和输入框 15px、“更新时间 / 线路总数”等小标题 13px、它们的值 16px / 600、数据来源说明 14px、按钮 15px。
  - 表格：表头 14px / 600，正文 15px，行高约 44px；难度徽章 13px / 600。
  - 地图页侧栏：卡片标题 18px（“线路”卡片 22px）、线路名称 15px、ZIP 数 13px、覆盖率数字 28px、正文 14px；着色模式按钮 14px；地图标注、tooltip 等现有尺寸不变。
  - 原来 11px / 12px 的辅助文字（例如 `dt`、`.eyebrow`、`.map-sidebar dt`、`.map-badge`）提高到 12–13px。
- **390px**：整体约缩小 1–2px（例如页面标题 22px、表格正文 14px），保持不出现横向滚动。
- 标签字号（`.route-label*`，包括 Product Owner 调过的 18px）**不改**。
- **宽屏放大（第 1 轮审查补充，Claude 决定）**：Product Owner 的浏览器视口约 2560 CSS px（缩放 100%），参考图约 1700px 宽，所以上面的桌面字号在宽屏上仍然显得小。增加两档：
  - 视口 ≥ 1800px：上面列出的字号（标签除外）整体 +2px（例如表格正文 17px、表头 16px、工具栏标签 / 下拉框 17px、值 18px、品牌名 24px、侧栏线路名称 17px；**页面标题例外，每档 +4px：28 → 32 → 36px**，第 1 轮 Codex 指出原文示例和“+2px”矛盾，Claude 决定），表格行高、按钮和输入框的内边距相应加大。
  - 视口 ≥ 2300px：在上一档的基础上再 +2px（页面标题 +4px）。
  - 用媒体查询或 CSS 变量实现，不使用 CSS `zoom` / `transform: scale`（会影响 Leaflet 的鼠标坐标）。地图标注字号不变。
- 验收：两个页面在 Chrome 中对照参考图，主要文字（工具栏、表格、侧栏列表）明显更易读；390px 下 `scrollWidth <= 390`；现有测试通过。


### ?????Implementation Notes?? RM13d

- 2026-11-02?????????? web/styles.css ???????????????????????????????? tabular-nums??? 22px??? 28px??? 16px?????? 15px????? 15px??? 14px/600??? 13px/600???? 44px????? 18px????? 22px????? 15px??? 14px???? 28px?390px ????????????
- ?? MAP-R1b ??????????????????? tooltip?popup???????????.route-label* ??????????????? 18px?????????????HTML??????API ????????????????
- ? brief ??? CSS ?????NAV1 ????? 17px ?? 16px?R1b ??????????????? :where ????????????????????? 20px ????? 15px?????????????????????????????????? 57/57 ???
- Playwright headless ???????? / ? /map?? 1440?900?390?900??? scrollWidth ??? 1440 / 390???? 37 ???? 445 ????? pageerror?????/???? 28px/22px???? 22px/20px??? .handoff/RM13d-profile-desktop.png?RM13d-profile-mobile.png?RM13d-map-desktop.png?RM13d-map-mobile.png???????
- ??????????????????DSP ????/????????ZIP ??????????????????/????????????????? legacy ???? analytics????????????????????????? Chrome ????? Product Owner ???????390px ?????????
- ??? DMS?????????????????commit?push ????npm test ????????????????????????? lint ??? build ???
- ?????npm.cmd test ?? 636/636 ???git diff --check ??? 0????? LF/CRLF ??????????????????/??????????????????????

- 2026-11-02 RM13d ? 2 ??? :root ?? / ????? ?1800px??2300px ?????????? UI ???? +2px?h1 ?? +4px?28/32/36px??????????????????? .route-label*??? tooltip / popup ????????????????? zoom / scale??? R1b ? NAV1 ??????????????npm.cmd test 636/636 ???git diff --check ???? LF/CRLF ????Playwright ????????? / ? /map ? 1440/1920/2560/390?900 ?????? .handoff/RM13d-{profile,map}-{width}.png?390px ?? scrollWidth=390?2560px ??????????????????? 100?60px ???????????? 0?? pageerror?37 ???? 445 ??????????? DMS????????????????/??/?????? lint/build ???Claude ???????? Product Owner ?????????
