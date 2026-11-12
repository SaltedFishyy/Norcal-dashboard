# 多站点自动串行批处理（Multi-Station Batch）— Spec

- Status: **Approved**（Product Owner 2026-10-06 提出需求并授权实现和真实运行；标注“Claude 设计”的条目是实现细节，Product Owner 可随时调整）
- 更新：2026-10-06
- 相关：`docs/features/route-detail.md`（RD3 / RD3-12 / RD3-13 / RD3-14 / RD4）、`docs/features/dms-refresh.md`（T3 Route Profile）、`docs/features/route-map.md`（RM5）、`docs/data-schema.md` 第 8–9 节、`docs/open-questions.md` D8 / TBL-Q2 / TBL-Q6

---

## 1. 目标

把 Product Owner 负责的 9 个站点录入现有 dashboard / cache / map。用**一个命令、一个浏览器会话**自动串行处理所有站点，不需要逐站人工确认：

```text
切站 → 双重验证站点 → 获取当前 Route list（= 该站 active Route）
→ 逐条抓 Route Detail / ZIP Detail（跳过完整 cache）→ 完整性检查 → 写 Route Profile snapshot → 保存 Station summary
→ 等待 15 秒 → 自动切到下一个 Station
```

默认站点顺序：`SFO01 → SMF01 → RNO01 → SCK01 → MOD01 → MFR01 → OAR01 → RDG01 → RDG02`。

## 2. Product Owner 要求（2026-10-06）

| # | 要求 |
|---|---|
| MS1 | 一次只处理一个 Station；Station 严格串行；Route 严格串行；不并发 |
| MS2 | Route 间隔约 2 秒；每个 Station 完成后固定等待 15 秒，然后自动继续（Product Owner 2026-10-06 调整：原为 4 秒 / 60 秒） |
| MS3 | 同一个 browser / session，不反复登录 |
| MS4 | 切站必须**双重验证**：右上角显示的 Station = 目标；Route list 数据也属于目标 Station。不一致 → 立即停止整个批次 |
| MS5 | **DMS 当前 Route list 是该 Station active Route 的唯一来源**。旧 cache 保留为历史，但不在当前列表里的 Route 不再作为 active 显示在 dashboard / map；不为匹配旧 cache 去补 Route |
| MS6 | 已有完整、符合当前 schema（RD4）的 Route Detail 跳过；缺字段 / 旧格式自动重抓；每成功一条立即写入 |
| MS7 | 断点续跑：已完整完成的 Station 跳过；当前 Station 中有完整 cache 的 Route 跳过；从缺失处继续 |
| MS8 | 每个 Station 完成后做完整性检查（第 7 节）；失败 → 停止整个批次 |
| MS9 | 真实 0 Route 的 Station 记录为 `0 routes`，不算错误；但由加载失败、请求失败、session 问题、切站未完成导致的“0 条”必须停止 |
| MS10 | 安全规则不变（0 并发、不无限重试、RD3-14 定位 fallback）；新增 per-station 和 whole-batch request cap，按 Route 数动态计算并留余量 |
| MS11 | 任何时候 429 / 5xx / session 失效 / 数据校验失败 / Station 身份不一致 / 页面结构严重异常 / 请求超过 cap → 立即停止整个批次，不进入下一个 Station |
| MS12 | 每个 Station 和整个批次都输出 summary（第 8 节） |
| MS13 | 数据结构和前端 ZIP 表沿用现有规则（RD4：ZIP、领件量（日均）、熟手 PPH、ZIP 难度、首公里距离；不显示派送异常率 / DNR / 安全等级） |
| MS14 | 地图兼容多站点，保持 RM5 全部规则；超出边界库的 ZIP 只记录缺失，不生成假 polygon |
| MS15 | 先小规模真实验证（MFR01 + 另一个 Route 少的站点），稳定后自动按顺序跑完剩余站点；出现 stop condition 立即停下汇报 |

## 2.1 等待策略调整（Product Owner 2026-10-06）

- Route 间隔 4 秒 → **2 秒**；Station 间隔 60 秒 → **15 秒**（只针对多站点命令；单站点 RD3 命令不变）。
- 其他保护不变：Station / Route / browser 严格串行；429 / 5xx / session 失效 / 数据校验失败 / Station 身份不一致立即停止；per-route、per-station、whole-batch 请求上限；断点续跑；每条成功立即写入；切站双重确认；不重试。
- Station 完整性检查保持为快速校验（第 7 节，纯函数，不增加额外等待）。
- 每次等待在日志中输出一行带时间戳的记录（等待类型、毫秒数、开始时间），便于核对实际间隔。

## 3. DMS 切站机制（2026-10-06 Claude 只读探索，58 个 `/prod-api/` 请求，无 429 / 5xx / 401；结果在 runtime `multi-station-exploration/`，不进 Git）

- **右上角 Station 显示**：`HEADER.dbu-web-main-layout-header … DIV.right-menu-item … DIV.dbu-web-main-dropdown-trigger > SPAN.groupCheck`，文本为当前 Station（如 `SFO01`）。
- **下拉菜单**：点击后出现 `UL.dbu-web-main-dropdown-menu`，每个 Station 是一个 `LI.dbu-web-main-dropdown-menu-item`（文本完全等于 Station 代码），当前 Station 为禁用样式。菜单很长（约 80 个 Station），目标项可能在视口外，**必须用 locator 点击（让 Playwright 先滚动到可见），不能用坐标点击**。
- **切站请求**：点击后发出 `GET /prod-api/switch-org/<orgId>`（例如 MFR01 = 1519），随后页面在同一路由（`/gofo-site/report/reportCenter/areaDepiction`）重新加载约 20 个基础请求，并**自动发出一次路区画像列表请求**（`pageSize` 10）。
- **列表随全局 Station 过滤**：路区画像页面的“转运站点”筛选框为空时，列表请求体为 `{"pageNum":1,"pageSize":…,"siteHandleType":"ALL","pageType":""}`，**没有 Station 参数**，返回的就是右上角当前 Station 的 Route（SFO01 36 条；MFR01 2 条，`transitStationName` 都是 `MFR01`）。
- **切站是服务端会话状态**：切到 MFR01 后，账号的当前 Station 即为 MFR01。探索结束时已切回 SFO01 并确认。批处理必须在结束（包括中途停止）时恢复为开始前的 Station（第 5.6 节）。

## 4. 架构（Claude 设计）

```text
server/bin/dms-scrape-stations.js        CLI：参数、配置、站点顺序、run state、Station 循环、15 秒等待、summary
server/src/dms/station-switch.js          Playwright：读右上角 Station、点下拉菜单切站、等待 switch-org 和自动列表、双重验证
server/src/dms/portrait-page.js           拆分：浏览器会话生命周期 / 列表查询（不选“转运站点”的全局模式）/ 计数和 cap
server/src/dms/route-detail-page.js       复用：单条 Route 详情（RD3-14 定位 + 标签详情 + 产能 + 关闭弹窗），不复制
server/src/transform/route-profile.js     复用：列表 → Route Profile rows（已校验每条 transitStationName = Station）
server/src/store/route-profiles-file.js   复用 saveStationSnapshot（按 Station 覆盖 = active 列表）
server/src/store/route-details-file.js    复用 saveRouteDetail；新增按 Station 判定 Route 完整性
server/src/store/station-batch-file.js    新增：run state、Station summary、批次 summary（原子写）
server/src/batch/station-integrity.js     新增：纯函数完整性检查
```

- 现有命令 `dms:scrape`（T3，SFO01）、`dms:scrape-route-detail`、`dms:scrape-route-details` 的行为不变。
- DMS → transform → store → API → frontend 的分层不变。

## 5. 处理流程

### 5.1 启动

1. 解析参数（第 9 节），检查配置和 session 文件，读取 run state（第 6 节）。
2. 打开**一个**浏览器、一个 page，进入路区画像页面，确认已登录。
3. 读取右上角当前 Station，记为 `original_station`（用于结束时恢复）。

### 5.2 切站与双重验证（每个 Station）

1. 如果右上角已经是目标 Station → 不点击菜单，直接进入第 5.3 步。（仍然要做双重验证。）
2. 否则：点击右上角 trigger → 在菜单中找**恰好 1 个**文本完全等于目标的 `LI.dbu-web-main-dropdown-menu-item` → 先安装 `switch-org` 响应监听，再用 locator 点击。
3. 等待 `GET …/switch-org/<id>` 返回 200（超时约 30 秒；非 200 → 停止）。
4. **验证一**：轮询右上角 `SPAN.groupCheck` 文本，等于目标 Station（约 30 秒上限）。
5. 等待切站后自动发出的列表请求返回（不校验它的内容是否完整，只要求请求成功）。
6. 进入第 5.3 步，用显式查询拿到完整列表；**验证二**在第 5.3 步完成。

任何一步失败或超时 → `StationSwitchError`，停止整个批次。

### 5.3 获取当前 Route list

1. 不使用“转运站点”筛选框（保持为空），每页设为 100 条，点「查询」，截获 `pageSize` 100 的列表响应。
2. **验证二**：响应 `success` / `code` 正常；`data.records` 中**每一条**的 `transitStationName === 目标 Station`；`data.total` 为非负整数。再次确认右上角仍然是目标 Station。任一条不一致 → `StationMismatchError`，停止。
3. `total > 100` 时按 RD3-12 逐页加载（点“下一页”），每页同样做验证二；全部页加载完成后才算拿到完整列表。
4. **0 Route**：`total === 0`、`records` 为空、列表请求 200 成功、右上角 = 目标、表格容器可见 → 记录 `0 routes`，写入 0 行 snapshot。只要列表请求失败、超时、未登录或切站未完成，都**不能**当作 0 routes，必须停止。

### 5.3a 多页 Station 的处理顺序（2026-10-06 Claude 澄清）

只遍历一次，不回到前面的页，不额外请求：

1. 加载第 1 页 → 验证二 → 把这一页的 records 用 transform 的同一套规则解析为 rows（用于本页 Route 的完整性判定，包括 ZIP 集合比较）→ 按页面顺序抓这一页需要抓的 Route Detail。
2. 点“下一页” → 验证二 → 解析 → 抓详情；依此类推（RD3-12）。
3. **最后一页加载并验证完成后**，把所有页的 records 合并，调用 `transformRoutePortrait` 生成 snapshot，完整性检查通过后才调用 `saveStationSnapshot`（第 5.4 节）写入（2026-10-07 / central-db P1）。
4. 中途停止时，该 Station 的 snapshot **不更新**（保留旧的），已写入的 Route Detail 保留；续跑时该 Station 从第 1 页重新开始，已完成的 Route 会被跳过。
5. `total ≤ 100` 时只有 1 页，仍在本次详情处理完成且完整性检查通过后才写 snapshot（2026-10-07 / central-db P1）。
6. 第二遍分页**不允许**。如果某页在 L1–L3 都定位失败，并且 L5 不可用，按 RD3-14 停止。
7. **L5 只能在第 1 页使用**：L5 恢复列表后会回到第 1 页，无法保证单遍分页，所以在第 2 页及以后需要 L5 时，直接停止整个批次（`SelectorError('L5 不可用于第 2 页以后')`）。在第 1 页使用 L5 后，恢复时必须确认仍在第 1 页、每页 100 条、记录与之前一致，否则停止。（当前 DMS 页面没有“路区名称”筛选框，L5 本来就不可用。2026-10-06 Claude 澄清）

### 5.4 写 Route Profile snapshot（active 列表）

- 用全部页的 records 组成列表体，调用现有 `transformRoutePortrait`（会再次校验 Station、Route ID 唯一、`postal_codes` 等），然后执行完整性检查；仅在检查通过后调用 `saveStationSnapshot` 原子覆盖该 Station 的 snapshot。检查失败保留旧文件，已成功写入的 Route Detail 保留（2026-10-07 / central-db P1）。
- 覆盖后，`route-profiles.json[station].rows` 就是该 Station 当前 active 的 Route。旧 snapshot 中有、但当前列表没有的 Route 从 active 中移除；它们的 Route Detail 留在 `route-details.json` 作为历史，不删除。
- 同一 Station 内的 ZIP 冲突沿用 T3 / TBL2 规则（transform 失败 → 停止）。

### 5.5 Route Detail（每条 Route）

- 处理顺序按页面顺序（RD3-12），每条前做 RD3-14 L0 等待。
- **Route 完整**（可以跳过）：`route-details.json` 中有该 `route_id`，且 `station === 当前 Station`，`route_name` 与当前列表相同，每个 ZIP 都有 `pickup_volume_daily` 键（值可以为 null，RD4），并且详情 ZIP 集合与当前 profile 的 `postal_codes` 相同。否则重抓（`--refresh` 时全部重抓）。
- 详情流程完全复用 RD3 / RD4（定位 fallback、标签详情、产能 / 按邮编、校验、关闭弹窗），每条成功立即写入；Route 间隔 4 秒。
- 详情记录的 `station` 取当前已验证的 Station，不从 Route Name 推断。
- 写入前额外确认右上角仍是当前 Station（防止中途被切走）。

### 5.6 Station 结束、等待和批次结束

1. 完整性检查（第 7 节）→ 写 Station summary 和 run state（第 6、8 节）。
2. 如果不是最后一个 Station：等待 `STATION_BATCH_DELAY_MS`（默认 15000），等待期间也受 429 / 5xx / 401 监控。
3. 批次结束（完成或停止）：在关闭浏览器前**恢复右上角为 `original_station`**（如果与当前不同；只点菜单，验证右上角文本）。恢复失败不改变停止原因，但要在 summary 中写 `original_station_restored: false` 并在终端提示。熔断 / 登录失效导致浏览器已关闭时无法恢复，同样如实记录。
4. 写批次 summary。

## 6. 断点续跑（Claude 设计）

- runtime 目录新增 `station-batch-state.json`：`run_id`、`started_at`、`station_order`、`stations: { <code>: { status, summary_file, completed_at } }`、`finished_at`。`status` 取值：`pending` / `in_progress` / `completed` / `limited`（因 `--max-routes-per-station` 未抓完）/ `stopped`。
- 启动时：存在 state、`finished_at` 为 null、且 `station_order` 与本次相同 → **续跑**同一个 run：`completed` 的 Station 直接跳过（不切站、不请求）；其他 Station 从头处理（Route 级 cache 跳过保证只抓缺失 Route）。否则开始新 run（`--new-run` 强制新 run）。
- **Station 完成**：完整性检查通过，并且不是因为 `--max-routes-per-station` 少抓（那种情况为 `limited`）。
- **Route 完成**：见第 5.5 节。
- 全部 Station `completed` 后写 `finished_at`；下次运行开始新 run（Route 级 cache 仍会跳过，所以只产生切站和列表请求）。

## 7. Station 完整性检查（纯函数，Station 结束后执行）

必须全部满足，否则 `IntegrityError`，停止整个批次（在 `limited` 模式下，只检查已处理的 Route，并标记为 `limited`，不算失败）：

- `route_total` = 当前列表 Route 数 = snapshot 行数。
- `route_total === success_count + skipped_cached_count`，且 `failed_count === 0`。
- snapshot 中每一行的 `station` 都是当前 Station，没有其他 Station 的 Route；`route_id` 唯一。
- 每个 active Route 都有 Route Profile 行，也都有完整的 Route Detail（第 5.5 节定义），并且 detail 的 `station` 等于当前 Station。
- ZIP Detail 关联：详情 ZIP 集合 = profile `postal_codes`；每个 ZIP 都有 `pickup_volume_daily` 键，值为 number 或 null（RD4）。刚抓取的 Route 如果 ZIP 集合不一致（DMS 两个接口本身不一致），**不猜、不修正**，作为 `zip_set_mismatch` 警告写入 summary，不算失败；cache 中的旧记录不一致时会被重抓（第 5.5 节）。
- 边界库覆盖：统计该 Station 有 / 无 polygon 的 ZIP 数（`no_zcta` / `not_checked`），只记录，不算失败。
- 跨 Station ZIP 重叠（同一 ZIP 出现在两个 Station 的 active snapshot 中）：只作为警告写入 summary（TBL-Q2 未决，不自动消解），不算失败。

## 8. Summary

**Station summary**（`station-batch-runs/<run_id>/<station>.json`，同时在终端打印一行）：`station`、`status`、`route_total`、`success_count`、`skipped_cached_count`、`failed_count`、`zero_routes`、`request_count`（该 Station 的 `/prod-api/` 数，包括切站）、`list_request_count`、`detail_request_count`、`station_request_cap`、`start_time`、`end_time`、`duration_ms`、`locate_method` 统计、`integrity: { passed, checks, warnings }`、边界覆盖统计、`stop_reason`（如有）。

**批次 summary**（`station-batch-runs/<run_id>/batch-summary.json`，并在终端打印）：Station 总数、完成数、`limited` / 跳过（续跑）/ 未处理的 Station、总 Route 数、新抓 Route 数、cache 跳过 Route 数、总请求数、`batch_request_cap`、总耗时、各定位方法次数、缺失的 Station / Route、`original_station` 和是否已恢复、停止原因。

所有文件写在 runtime 目录（不进 Git），原子写。日志不打印 cookie、token、完整 URL 或响应正文；失败诊断沿用 RD3-11。

## 9. 命令和配置

```text
npm run dms:scrape-stations -- [--stations SFO01,SMF01,...] [--max-routes-per-station N] [--refresh] [--new-run] [--headless]
```

- `--stations`：逗号分隔的 Station 代码（`^[A-Z]{3}\d{2}$`，不重复）；不传时使用第 1 节的默认顺序。
- `--max-routes-per-station N`：每个 Station 最多实际抓取 N 条，用于小规模验证；这样的 Station 记为 `limited`。
- `--refresh`：已有完整 cache 也重抓。
- `--new-run`：忽略未完成的 run state，开始新 run。

| 配置（`.env`，可选） | 默认 | 说明 |
|---|---|---|
| `ROUTE_DETAIL_BATCH_DELAY_MS` | 多站点命令默认 **2000**（下限 2000）；单站点 `dms:scrape-route-details` 仍默认 4000 | Route 间隔。`.env` 设置时两个命令都使用该值 |
| `STATION_BATCH_DELAY_MS` | **15000**（下限 10000） | Station 间隔 |
| `MAX_ROUTE_DETAIL_REQUESTS` | 30 | 单条 Route 详情请求上限，沿用 RD4 |
| `STATION_REQUEST_BASE` | 80 | 每个 Station 的固定开销上限（切站约 20、列表若干），用于计算 Station cap |
| `STATION_REQUEST_PER_ROUTE` | 22 | 每条要抓取的 Route 的请求额度（实测约 16，留余量） |
| `MAX_MULTI_STATION_BATCH_REQUESTS` | 12000 | 整个批次 `/prod-api/` 的绝对上限 |

- **per-station cap**（动态）= `STATION_REQUEST_BASE + STATION_REQUEST_PER_ROUTE × 本站列表 total + (页数 − 1) × 5`。拿到第 1 页之前，用 `STATION_REQUEST_BASE` 作为临时上限；第 1 页验证后，用响应中的 `total` 计算正式上限，此后不再改变（2026-10-06 Claude 澄清：用 `total` 而不用“需要抓取数”，因为多页时后面的页还没加载就无法知道需要抓取数；这个上限较宽，但仍然有上限）。超过 → `LoadLimitError`，停止。
- **whole-batch cap**：已处理 Station 的 cap 之和，不超过 `MAX_MULTI_STATION_BATCH_REQUESTS`；任一超过 → 停止。
- 原有的 per-route cap 不变。列表请求上限改为按 Station 计算：每个 Station `MAX_PAGE_LOADS_PER_STATION`（默认 3）+ 切站自动列表 1 次 + 额外页数，**再加上 RD3-14 的规则：本 Station 每使用一次 L5（按名称筛选）增加 2**。（2026-10-06 Claude 澄清：多站点沿用 RD3-14 的 L5 额度规则，不取消）

## 10. 停止条件（任何一个都停止整个批次，不进入下一个 Station）

SC4（Product Owner 2026-11-05）：目标菜单项数量为 0，且可见 `li.dbu-web-main-dropdown-menu-item` 中至少有一个 Station 文字符合 `^[A-Z]{3}\d{2}$` 时，可判定目标不在已展开的菜单中。只点击 trigger 打开 / 关闭菜单，确认所有菜单项隐藏、页头 Station 未变后，抛出 `StationNotInMenuError`；不点击 Station、不产生 switch-org 请求。菜单未展开、没有可见 Station、重复目标、关闭失败或页头变化仍按 `StationSwitchError` 停止。

批次捕获该专用错误，以 `{ code, district, reason: 'not_in_dms_menu' }` 写入 progress、JSON run state / batch summary 的 `skipped` 并记录汇总日志；继续下一站，不写该站 snapshot / Route Detail，不算失败。其他站完成则批次完成、无 stop_reason。静态 `scrape_disabled` 不变。3100 沿用 progress.skipped 显示原因。

### SC4 实现记录（Implementation Notes，2026-11-05）

- DB 现有 Station 状态没有 skipped，且 scope 在 INSERT 后不可更新。沿用 brief 允许的“DB 无该站运行行、跳过信息在 JSON 运行记录”方案：切站成功后才持久化 in_progress，DB sink 不插入 pending / skipped 条目；不新增状态、migration 或权限。DB v_runs 的 scope.skipped 仍仅包含配置跳过，运行时跳过详情读取 JSON 运行记录 / progress。
- JSON state 中跳过站保留 pending 并另存 skipped，完成与缺失清单计算排除本次运行时跳过；若批次被其他错误中止，续跑会重新检查缺站，避免把临时缺站永久记为完成。
- 验证：`npm.cmd test`（即 `npm test`）684/684 通过，0 failed / skipped，日志 `.handoff/SC4-tests.log`；包含菜单关闭 / 页头变化保护、无 switch-org 请求、中间站跳过后继续、历史 snapshot 保留、真实测试库双写与 3100 合成 DOM 显示。`git diff --check` 通过（仅 LF/CRLF 提示）。没有 lint / build scripts。首轮发现状态持久化时机回归，修复后全量通过；新增 DB 断言已限定本次运行，不把历史运行行计入。
- 未访问真实 DMS、运行 dms:*、重启服务或改正式数据库；没有新增依赖、提交、推送或部署。南加州配置与相关 SC2 / SC3 测试恢复为 HEAD 的 15 站版本。真实地图 / 3100 浏览器预览及 Product Owner 签字未执行。

429 / 5xx、401 / 登录页 / 密码框、`switch-org` 失败、右上角 Station 不等于目标、列表记录的 `transitStationName` 不一致、列表请求失败或超时、0 Route 但不满足第 5.3 节条件、transform / 校验失败（含同站 ZIP 冲突）、RD3 / RD4 的所有详情校验、定位全部失败、per-route / per-station / whole-batch cap、完整性检查失败、Ctrl+C。停止时：已写入的数据保留，run state 中当前 Station 标为 `stopped`，写 summary，尝试恢复 `original_station`，写诊断文件。**不重试**。

## 11. Dashboard / 地图兼容（第 2 个 Codex 任务，Claude 设计）

- **Route Profile 页面**（`/`）：增加 Station 选择框（选项来自已有 snapshot 的 Station 列表；URL `?station=` 优先；默认第一个）。表格、modal、五色、5 列 ZIP 表不变。只显示该 Station 的 active snapshot。
- **地图**（`/map`）：Station 选择框已经存在；数据只来自所选 Station 的 active snapshot（旧 Route 自动不显示）。RM5 规则全部不变。
- **跨 Station ZIP 重叠**：目前 `validateProfiles` 发现任意两个 Station 共享 ZIP 就让整张地图返回 `route_zip_conflict`。改为：
  - 构建某个 Station 的地图时，只把**本 Station 内**的冲突当作错误（沿用现有规则）。
  - 跨 Station 重叠不阻止地图，`/api/route-map` 增加 `cross_station_conflicts: [{ postal_code, stations: [...] }]`（只列出涉及本 Station 的），页面显示提示“以下 ZIP 同时出现在多个站点”。不判断归属（TBL-Q2）。
  - `/api/route-map/zip`：ZIP 属于多个 Station 时返回 `status: 'multi_station'` 和 `owners` 列表，**不自动切换 Station**，面板列出各 Station / Route。
- Tableau 导出的冲突规则不变（仍然失败并报告）。
- 超出边界库（CA / NV / OR）的 ZIP 按现有 `not_checked` 处理（缺少边界的邮编清单），不生成 polygon。

### 11.1 Station 顺序与“上一次选择”（Product Owner 2026-10-06）

- **固定顺序**：Route Profile 和 Map 的 Station 下拉框统一按 `SFO01 → SMF01 → RNO01 → SCK01 → MOD01 → MFR01 → OAR01 → RDG01 → RDG02` 排列，不再按字母排序。顺序只在一个地方定义：server 端复用 `config.js` 的 `defaultStationOrder`，由 `/api/route-map/stations` 按此顺序返回。如果有 snapshot 中存在、但不在该列表里的 Station，按字母顺序排在后面。
- **记住上一次选择**：两个页面共用一个 localStorage key（`nc-ops-console.station`），只保存 Station 代码。
  - **只在用户手动选择 Station 时保存**。地图上搜索其他 Station 的 ZIP 时自动切换 Station，不算手动选择，不保存。
  - 页面打开时的默认 Station 优先级：URL `?station=`（显式链接）> localStorage 中保存的值 > `SFO01` > 列表第一个。保存的值或 URL 参数不在当前可用 Station 列表中时，跳到下一个优先级。
  - localStorage 读写都用 try / catch 包裹；不可用时（隐私模式等）按没有保存值处理，页面照常工作。
  - 不需要服务器持久化。恢复 Station 只请求本地 API，**不访问 DMS**。
- 其他功能不变：Station 切换、Route / ZIP 搜索、RM5 / RM5b、Coverage、Fit Station、选中 Route / ZIP、cache / API 数据逻辑。

## 12. 验收标准

**MS-T1（批处理）**

- **MS-AC1** 一个浏览器会话内按顺序处理多个 Station；Station 和 Route 都严格串行；Route 间隔约 2 秒，Station 间隔约 15 秒（可配置）。
- **MS-AC2** 切站按第 5.2 节执行（locator 点击菜单项，等待 `switch-org` 返回 200，右上角文本 = 目标），并通过第 5.3 节的列表验证；任何不一致都停止。
- **MS-AC3** 0 Route Station 按第 5.3 节处理：真实的 0 条记为 `0 routes` 并继续；请求失败等情况停止。
- **MS-AC4** 每个 Station 用当前列表覆盖 snapshot（active）；旧 Route 的 detail 不删除；不补造 Route。
- **MS-AC5** Route 完整性判定和跳过 / 重抓规则按第 5.5 节；每条成功立即写入；detail 的 `station` 正确。
- **MS-AC6** 完整性检查按第 7 节；失败时停止；警告写入 summary。
- **MS-AC7** 断点续跑按第 6 节：`completed` 的 Station 不再切站；Route 级跳过；`limited` 的 Station 在下一次运行中补全。
- **MS-AC8** per-station / whole-batch cap 按第 9 节动态计算，超过即停止；原有的 per-route cap、熔断和登录检测都保持。
- **MS-AC9** 结束和停止时都尝试恢复 `original_station`，并如实记录结果。
- **MS-AC10** Station summary 和批次 summary 字段齐全，原子写入，没有敏感信息。
- **MS-AC11** 现有命令和测试不变；`npm test` 和 `git diff --check` 通过；不新增依赖。

**MS-T2（dashboard / 地图）**

- **MS-AC12** Route Profile 页面可以切换 Station，只显示 active snapshot。
- **MS-AC13** 跨 Station 重叠不再让地图失败；按第 11 节显示提示，ZIP 搜索返回 `multi_station`，不自动切站；同 Station 冲突仍然报错。
- **MS-AC14** RM5 和 RM5b 的全部功能在每个 Station 上都正常；1440 / 390；没有第三方请求。

**真实验证（Claude 在 Product Owner 本机执行）**

- **MS-AC15** 小规模验证：
  1. 先运行 `--stations MFR01,<另一个 Route 少的站点> --max-routes-per-station 1`；
  2. 再不加限制运行同一组站点，验证续跑；
  3. 检查切站、无混站、列表、Route Detail、snapshot / station key、15 秒自动继续、summary、续跑，以及没有 429 / 5xx / session 问题。
  
  通过后按默认顺序运行全部 9 个 Station。

## 13. 未决问题

- TBL-Q2（ZIP 归属冲突的业务规则）仍然未决；本 spec 只显示冲突，不判断归属。
- 其他 Station 的站点代码在 DMS 中都存在（菜单中可以看到全部 9 个）；各站点 Route 数在实际运行后才能知道。

## MS-T1 实现记录（Implementation Notes，2026-10-06）

- 新增 `dms:scrape-stations` CLI，参数与配置集中在 `server/src/config.js`。默认 9 个 Station，Route / Station 间隔分别为 4000 / 60000 ms；串行执行并使用一个浏览器会话。现有三个 CLI 仍只接受 SFO01，未修改既有测试断言。
- `withPortraitPage` 把会话初始化与 `queryStation` 分开，新命令使用 `globalStationMode`，不操作“转运站点”；显式查询、下一页及 L5 查询都拒绝带有 `transitStationCodeList` 的请求。复用原来的 guarded / control、计数、熔断、登录监控、详情定位、详情 transform 和原子 store。RD3-11 诊断抽取到 `batch-diagnostics.js`，新旧命令共用；旧诊断文件名、字段、脱敏、截图失败行为与 4.5 秒时限保持不变。
- 切站使用 HEADER 下的 dropdown trigger / SPAN.groupCheck 和精确菜单 locator，点击前安装两个响应监听；switch-org HTTP 200、右上角文本与自动列表成功都必须确认。切站监听和控件操作各有 30 秒上限，文本轮询同时受 deadline 与有限轮询次数保护。恢复也使用同一函数和安全监控；已熔断关闭浏览器、恢复请求失败或身份无法确认时记录 false，不覆盖原停止原因。
- 单遍分页：每页先验证身份、页码、100 条/页、total 和该页应有记录数，再用既有 transform 规则解析该页；跨页 ID / 名称重复及最终同站 ZIP 冲突均停止。沿用 RD3-12 的 10 页绝对上限。达到实际抓取限制后仍读取剩余列表页，但不额外抓详情，以取得完整 active snapshot；没有第二遍分页。
- 选择统一在全部页及本次详情处理完成后写 snapshot，包括只有 1 页的情况。分页中途失败保留旧 snapshot，成功详情逐条保留；独立详情 store 不删除历史 Route。写详情和 snapshot 的原子 rename 前再次做 guarded / Station 检查。
- L5 仅允许第 1 页；第 2 页以后需要 L5 时直接停止。第 1 页恢复必须确认身份、页码、100 条/页、total 与原 records 完全一致；页面状态无法确认时停止，不额外查询恢复。每次 L5 仍增加 2 次列表请求预算。
- Route cache 读取新增原始记录 reader，避免 API reader 的 null 默认值掩盖旧字段缺失。完整性按 station、route_id、route_name、ZIP 集合及每 ZIP 的原始 `pickup_volume_daily` 键 / number-or-null 类型判断。刚抓取的合法详情若 ZIP 集合不同，仅记录 `zip_set_mismatch`；下一次运行不会把这种记录当作完整 cache 跳过。
- Station integrity 为纯函数，limited 模式只检查已处理 Route；跨 Station ZIP 重叠只记录警告。边界覆盖复用现有 CA/NV/OR reader；范围内缺失为 `no_zcta`，范围外或库无法读取时为 `not_checked`，不生成 polygon。数据来源继续是手动启动的 DMS browser automation，Profile / Detail 的 `fetched_at` 和两个 cache 的 schema_version 1 不变；`docs/data-schema.md` 补充新命令的来源和写入方式。
- per-station 请求从切站之前计数，先用 base，首页验证后按 total 固定正式 cap。whole-batch 请求数包含浏览器启动及恢复请求，受 Station cap 累加额度和绝对上限共同约束；启动 / 恢复也不获得额外放宽额度。列表预算逐 Station 重置，追加自动列表、额外页与 L5 额度。单 Route cap 维持原规则。
- run state、Station summary 和 batch summary 使用既有 `writeFileAtomic` 写 runtime。只有全部 Station completed 才设置 finished_at；completed 跳过，limited / stopped 从第 1 页重新读取并按 Route cache 续跑。Station 等待期间失败也把当前 Station 标为 stopped，未处理 Station 保持 pending。损坏存储保守停止；诊断 / 恢复失败不能替换原停止原因。停止 summary 记录已知缺失 Route，并用 `unloaded_route_count` 区分尚未加载的 Route，不猜测其 ID。
- 新增 43 项 doubles / 合成文件测试：`multi-station-batch.test.js`、`station-switch.test.js`、`station-integrity.test.js`，共享 `multi-station-fixtures.js` 并注册到 test/index.js。覆盖单会话与串行间隔、header / 精确菜单 / 监听时序、切站失败与超时、0 Route、混站、150 条单遍分页、历史 detail 保留、cache 重抓 / refresh、limited / completed 续跑、新 run、cap / L5 预算、第二页 L5 停止、完整性失败和警告、恢复成功 / 失败 / 已关闭、Station 等待期间 429 / 5xx / 401 / SIGINT、summary 计数和初始 header 失败诊断。
- 最终 `npm.cmd test`（Windows 的 npm test）：363/363 通过；`git diff --check` 通过，仅已有 LF/CRLF 提示。没有 lint / build scripts，没有新增依赖。未访问 DMS、启动真实浏览器、读取真实 session / runtime、写入凭据、commit、push 或部署；保留开始前 `.gitignore`、open-questions 和 spec 的已有内容。
- 验收映射：MS-AC1 串行 / 延迟 / 单会话；AC2 切站与逐页身份校验；AC3 成功空列表与失败停止；AC4 snapshot 覆盖 / 历史详情保留；AC5 原始 cache 完整性 / 重抓 / 原子写前身份检查；AC6 纯函数失败与警告；AC7 completed / limited 续跑与新 run；AC8 动态 cap / 原有安全监控；AC9 恢复结果；AC10 原子 state / summary / 共享脱敏诊断；AC11 既有测试断言不变及全套回归。AC1–AC11 在 doubles / 合成文件范围内通过；MS-T2、真实 DMS 验证（AC15）和 Product Owner 的实际运行验收未执行。

### MS-T1 第 1 轮修复（Implementation Notes，2026-10-06）

- 按本轮明确修复指令调整重载等待：新增 `waitForHeaderStation`，每 200 ms 轮询，deadline 与有限次数共同限制为约 30 秒。页头缺失、重复、隐藏、暂时无效文本与重载读取异常都等待；持续旧值超时包含目标 / 当前 Station。切站前及恢复原 Station 复用该等待，确认目标后仍进行严格身份校验。`readCurrentStation` 先等待可见（5000 ms），随后严格检查唯一性与 Station 格式；写入前 `assertCurrentStation` 继续拒绝其他 Station。
- switch-org HTTP 200 后先等待 networkidle（30000 ms）；仅此等待的 TimeoutError 不终止。自动列表监听仍在点击前安装；仅自动列表监听 TimeoutError 表示未看到，交给第 5.3 节显式查询验证。已看到的非 200 / 未成功响应仍停止，原有熔断、登录检查与所有 cap 不变。Station summary 增加 `automatic_list_seen` 布尔记录，不改 Profile / Detail schema。
- `StationSwitchError` 保留菜单项数量、trigger 数量、HTTP 状态码、页头超时等具体原因；意外错误保留阶段消息和原始 cause，RD3-11 共享诊断继续提取最内层 cause 第一行并脱敏。恢复调用同一切站函数，先等当前页头就绪、必要时切回、再严格确认；切站失败但浏览器存活时真实执行恢复操作，已关闭 / 熔断时如实记录 false，不替换原停止原因。
- 新增 11 项 doubles / 合成 fixture 测试：页头消失 / 重复 2 秒后恢复、无效 / 隐藏页头、旧值超时含当前值、networkidle 超时、错过自动列表后显式查询成功、自动列表 500 熔断和 HTTP 200 业务失败、切站重载失败后等待并切回且记录 true、浏览器关闭记录 false、阶段 / cause 诊断，以及严格读取 5 秒可见等待 / 超时 cause。fixture 使用虚拟等待，不启动真实浏览器；原有测试断言保持不变。
- 最终 `npm.cmd test`（Windows 的 npm test）374/374 通过；`git diff --check` 通过（仅既有 LF/CRLF 提示）。没有 lint / build scripts，没有新增依赖；本轮仅修改切站模块、批处理 summary 记录、两个测试及其共享 fixture、本实现记录，保留开始前已有改动。未访问 DMS、读取真实 session / runtime、写入凭据、commit、push、部署或发布。
- 验收：MS-AC2、MS-AC9、MS-AC10 的本轮修复在 doubles 范围内通过；MS-AC1、3、4、5、6、7、8 保持且全套回归通过；MS-AC11 满足。实际 DMS 稳定性与 MS-AC15 留给 Claude / Product Owner 本机重新验证，本轮不宣称真实验收完成。

## MS-T2 实现记录（Implementation Notes，2026-10-06）

- Route Profile 复用只读 `/api/route-map/stations`，不新增接口。URL 中的 Station 在快照列表内时优先，否则使用列表第一项；切换重新请求该 Station 的 active snapshot，序号保护避免旧响应覆盖新选择。保留表格、系统五色、人工难度样式和五列 ZIP modal；切站关闭已打开的 modal。无快照、列表失败可重试；空快照和 Profile 加载错误继续沿用既有状态，空状态文案移除 SFO01。
- 地图保留所有快照字段格式校验，构建时只拒绝当前 Station 内的 ZIP 归属冲突；跨站重复通过新增 `cross_station_conflicts` 返回，仅包含当前 Station，ZIP 和站点排序稳定。全局 ZIP 查询仍拒绝同站归属冲突；跨站多归属返回 `multi_station`、显式投影的 `owners` 和实际 geometry，单归属与无归属响应字段不变。多归属不选择归属 Station / Route，相关字段为 null。未改变 Tableau 导出的冲突规则。
- 侧栏在覆盖率附近使用原生 details / summary 展示可折叠的跨站提示，默认收起，清理及切站重置；内容使用 textContent。多归属查询保持当前 Station、列出各 Station / Route、定位实际 geometry，只绘制该 ZIP 的现有 RM5b 双层描边，不选整条线路；有当前站点 polygon 时沿用其颜色。未修改 palette、legend、模式切换规则、描边常量或 CSP，没有新增外部请求或依赖。
- 本轮修改 `server/src/route-map/route-map.js`；`web/app.js`、`index.html`、`format.js`、`map.js`、`map.html`、`map-panel.js`、`map-text.js`、`map-view.js`；`server/test/route-map.test.js`、`route-map-api.test.js`、`route-map-web.test.js`、`t7.test.js`、`rd1.test.js`。RD1 fixture 补站点控件及列表请求，modal 原有行为断言保留；原跨站失败断言按本 spec 更新。同站冲突和 Tableau 测试继续通过。保留任务开始前 MS-T1 等工作区改动。
- 数据来源仍为已有手动抓取快照，经本地只读 API 加载；继续显示 fetched_at / 非实时快照提示。本轮未修改数据集、缓存 schema、抓取及批处理代码，未访问 DMS、真实 runtime、session 或凭据，未 commit、push、部署或发布。
- 检查：Node v24.19.0；`npm.cmd test`（npm test）378/378 通过，0 failed / skipped，日志 `.handoff/MS-T2-tests.log`；`git diff --check` 通过，仅既有 LF/CRLF 提示。项目没有 lint / build scripts，未运行 lint / build。API 检查仅使用合成文件、临时目录和自动关闭的 loopback server；前端使用 DOM / Leaflet doubles。
- **MS-AC12**：合成测试通过，覆盖列表选项、默认第一项、URL 优先 / 无效 URL 回退、切站重新请求、空 / 加载 / 错误与重试；页面只请求所选 Station snapshot。
- **MS-AC13**：合成测试通过，覆盖同站错误、跨站地图成功、当前站点限定提示、折叠 / 清理、多归属 owners / geometry、搜索不切站和仅 ZIP 描边；API 原有字段回归通过。
- **MS-AC14**：RM5 / RM5b 现有自动化回归全部通过，未改变模式、legend、颜色、描边、覆盖率、缺失边界或定位规则；本轮没有第三方请求代码变更。每个实际 Station、1440 / 390 布局、真实浏览器 Network / console / CSP 和底图观感由 Claude 本机验证，尚未完成；Product Owner 预览签字仍待进行，不宣称 UI 验收完成。

### ???????Implementation Notes?2026-10-06?

- ? MS-delays brief?? `server/src/config.js` ??????? Route ?? 2000 ms??? 2000??Station ?? 15000 ms??? 10000????? `parseRouteDetailBatchDelay` ???? 4000 ms??????????????????????
- ????? Route ????? Station ??????? guarded ???? `???route|station?<ms> ms??? <ISO ??>`????????????????????????????cap?????????????????? summary?
- ??????????????? / SIGINT ????????? / ????? 101 Route ??????????????????????ISO ????????`npm.cmd test`?npm test?380/380 ???0 failed / skipped?`git diff --check` ???? LF/CRLF ????? lint / build scripts????????
- ??? doubles ??????????? DMS????? runtime / session??????commit?push ????MS-AC1 ??????? doubles ??????MS-AC2?10 ???????MS-AC11 ???MS-AC12?14 ???????????????? UI ?????????MS-AC15 ????????

### MS-T2b Station 顺序与记忆（Implementation Notes，2026-10-06）

- `/api/route-map/stations` 复用 `config.js` 的 `defaultStationOrder`，仅返回快照中存在的站点，列表外站点按字母顺序追加；不复制默认站点列表。
- 新增 `web/station-preference.js` 并加入静态文件白名单。两个页面共用 `nc-ops-console.station`，启动按 URL → 保存值 → SFO01 → 第一项选择，只在 Station 下拉框 change 事件保存。ZIP 搜索自动切站、启动、重试及显式 URL 不覆盖偏好。
- storage 可注入；未传入时在 try/catch 内读取 globalThis.localStorage，属性 getter、getItem、setItem 抛错均不影响页面。空站点列表继续沿用既有空状态；chooseStation 对空列表返回 undefined。Map 的 createMapPage 增加可选 storage 参数，方便隔离测试。
- 新增 6 项测试，覆盖 API 顺序/额外站点/快照过滤、选择优先级、存储异常（含 getter）、Profile 保存/恢复/URL 不覆盖、Map 保存/恢复/ZIP 自动切站不保存。T7 静态资源测试验证新模块的白名单、原 CSP 和安全响应头。`npm.cmd test`（npm test）386/386 通过，0 failed/skipped，日志 `.handoff/MS-T2b-tests.log`；T7、route-map-web、map-state、RM5/RM5b 回归通过。`git diff --check` 通过，仅 LF/CRLF 提示。没有 lint/build scripts，未增加依赖。
- 使用已有 Playwright Chromium 对临时合成快照和 loopback API 做真实浏览器检查：默认 SFO01、Profile 手动保存、Map 恢复并手动保存、Profile URL 优先且不写入、Map ZIP 自动切站且不保存，全部通过，无 pageerror。未读取真实 runtime，合成环境没有底图 archives；底图观感、实际九站点及 1440/390 预览签字仍待 Claude/Product Owner 验证。
- 本轮仅改变站点展示顺序和浏览器偏好，不修改快照/cache schema、数据集、需求或验收标准。保留开始前工作区改动；未访问 DMS、读取 session、写入凭据、commit、push、部署或发布。MS-AC12/13 相关自动化回归通过；MS-AC14 自动化部分通过，实际站点/布局预览未验收；MS-AC1–11 与 MS-AC15 的真实 DMS 验证不属于本次任务。

## SC5 — 页头起始值不是 Station 代码（Product Owner 2026-11-11）

**背景：** 2026-11-11 重新登录后，DMS 页头 Station 下拉框（`header .dbu-web-main-dropdown-trigger span.groupCheck`）显示 `GOFO-EXPRESS`，不是 Station 代码。`readCurrentStation` 要求 `^[A-Z]{3}\d{2}$`，所以批次在读取 `original_station` 时以 `StationSwitchError('页头 Station 格式无效')` 停止（run `4bbec45d…`）。Product Owner 要求：起始值不是 Station 时也要能通过同一个下拉框正常切换到目标站点。

**规则：**

1. **起始值**：`original_station` 可以是 Station 代码，也可以是“组织标签”：去掉首尾空白后符合 `^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$`（例如 `GOFO-EXPRESS`）。不符合（空、过长、含其他字符）仍按 `StationSwitchError` 停止。summary 中记录 `original_station` 原文和 `original_kind: 'station' | 'label'`。
2. **切换与校验不放宽**：切到目标 Station 仍用原菜单 locator、`switch-org` 响应和页头文本严格确认（页头必须等于目标 Station 代码）；逐页身份校验、`assertCurrentStation` 不变。
3. **恢复**：
   - 起始值为 Station 代码：不变。
   - 起始值为组织标签：结束时打开同一菜单，查找文字**精确等于**该标签的菜单项；恰好 1 个时点击，并确认页头文本等于该标签后记 `original_station_restored: true`。找不到、多于 1 个或确认失败时，记 `false`，在日志中写一行“原页头为组织标签，未能恢复”，**不改变停止原因、不视为失败**；页头停留在最后一个处理的 Station。
4. 菜单缺站判断（SC4）中“页头未变化”的比较，同样按原文比较起始值（Station 或标签）。
5. 适用于所有使用页头切站的入口（批次、route-detail 批次、global Station 模式），共用同一读取函数。

### SC5 实现记录（Implementation Notes，2026-11-11）

- 新增 `readHeaderOrigin`，返回 `{ kind, value }`；与 `waitForHeaderStation` 共用原有 200 ms、约 30 秒有界轮询，按 SC5 校验去除首尾空白后的起始值。`readCurrentStation` 和写入前严格身份校验保持不变。切站起始读取及 SC4 菜单关闭后的原文比较使用新函数。
- 多站批次保存 `original_kind`，Station 起始值沿用现有恢复流程；组织标签通过同一菜单精确匹配唯一项并确认页头恢复。标签中的正则特殊字符会转义。失败记录 false 和一行“原页头为组织标签，未能恢复”，保留批次状态与停止原因。
- 未经真实 DMS 验证；无法确定组织标签项是否触发 `switch-org`，标签恢复以页头精确文本确认为准，仍受现有 guarded 安全监控保护。目标 Station 的 switch-org / 页头 / 自动列表处理和安全上限保持现有行为。检索确认当前仅多站批次使用页头切站及 global Station 模式；route-detail 批次使用筛选控件，没有页头原值恢复入口。
- 新增合成测试覆盖标签起始抓取与恢复、非法起始值、缺项 / 重复 / 确认失败、完成与停止状态保留、标签起始的 SC4 缺站，以及标签正则字符转义。原有测试断言未改；定向测试 70/70 通过。
- 按 brief 执行 `node --test server/test/`，不加载 `.env`：835 项，777 passed、56 skipped、2 failed。失败为 CD-AC30 / CD-AC31，均报“未配置 NC_TEST_DB_*”；全量通过条件尚未满足，留待 Claude 本机运行。日志 `.handoff/SC5-tests.log`、`.handoff/SC5-targeted-tests.log`。`git diff --check` 通过，仅 LF/CRLF 提示；项目无 lint / build scripts。
- 本轮未读取 `.env`、真实 runtime 或 session，未访问 DMS、重启服务、新增依赖、commit、push 或部署；保留工作区已有改动。
