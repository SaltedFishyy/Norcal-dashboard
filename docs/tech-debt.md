# Technical Debt（技术债）

已确认存在、但目前没有实际影响、暂不修复的问题。每条写清现状、为什么暂不修、什么时候需要处理。修复后标记为已解决并注明日期。

---

## 2026-10-07 Code review（Claude）

### TD1 `writeLastFailure` 只保留 SFO01

- 现状：`server/src/store/route-profiles-file.js` 的 `writeLastFailure` 写入 `station: station === 'SFO01' ? station : null`。
- 为什么暂不修：目前调用它的 3 个 CLI（`dms:scrape`、`dms:scrape-route-detail`、`dms:scrape-route-details`）在参数校验阶段都只接受 SFO01，非 SFO01 的 Station 在写失败记录之前就退出了。多 Station 批处理 `dms:scrape-stations` 不调用 `writeLastFailure`，而是把失败写进自己的 `station-batch-state.json`、`station-batch-runs/` 和 `station-batch-failure.json`。所以 SMF01、DEN01 等 Station 目前不会出现 `station: null`。
- 什么时候处理：任何一个单 Station CLI 放开 SFO01 限制时，同步把这里改为“通过 `^[A-Z]{3}\d{2}$` 校验的真实 Station，否则 null”，并补测试。

### TD2 Route Profile store 读取校验过浅

- 现状：`readRouteProfiles` / `getStationSnapshot` 只校验文件结构和 snapshot 的 `fetched_at`、`total`、`rows` 是否为数组、`source_as_of`，不校验 row 内容。`/api/route-profiles` 会原样返回 rows。
- 已有保护：
  - 写入路径：`transformRoutePortrait` 严格校验，再原子写入，正常流程不会产生坏 row。
  - 地图、ZIP 查询和 Tableau 导出路径：`route-map.js` 的 `validateProfiles` 和 `export/tableau-route-zips.js` 会校验 `route_id`、`route_name`、`postal_codes`，坏 row 时 fail closed。
  - 前端：全部用 `textContent` 和 `row?.[field]`，坏 row 只会显示 `—` 或错误数值，没有注入风险。
- 剩余风险：runtime 文件被人工修改后，Route Profile 表格可能显示错误数值，而不是报 `snapshot_invalid`。
- 什么时候处理：出现第二个需要校验完整 row 的场景，或 runtime 文件需要多人或多个进程写入时，把 row 校验从 `validateProfiles` 抽成共用的 row validator，由 store 读取时复用，不要再复制一套 schema。另外，任何一个 Station 有坏 row 都会让所有 Station 的地图返回 500（`validateProfiles` 会遍历全部 Station）。目前这是预期的 fail closed，后续可以考虑只校验请求涉及的 Station。

### TD3 `defaultStationOrder` 与 `config/districts.json` 两份 Station 列表

- 现状：`config.js` 的 `defaultStationOrder` 现在只作为 `dms:scrape-stations` 不传 `--stations` 时的默认列表（North Cal 原 9 个 Station）。下拉框和 District 展示已改为使用 `config/districts.json`（见 `docs/features/district.md`）。
- 为什么暂不修：Denver 一直通过显式 `--stations` 运行。GJT01 和 BZN01 不在 DMS 菜单中，按约定不能加入批处理（切站会触发安全停止），所以从 districts.json 自动生成批处理列表反而会出错。
- 待跟进：PIH01 已加入 Denver 配置，但尚未抓取；`district.md` 记录的 Denver 全量命令不包含它，下次跑 Denver 时需要手动加上。
- 什么时候处理：District 或 Station 数量继续增加，导致手动维护 `--stations` 容易漏站时，再考虑在 districts.json 中为每个 Station 标记是否参与批处理，由批处理按 District 读取。
- 计划（2026-10-07）：`docs/features/central-db.md` 第 5 节在 districts.json 中新增 `scrape_disabled`，P3 的刷新按钮会按 District 配置计算 Station 列表；命令行的默认列表暂时保持不变。

### TD4 schema_version 1 依赖“缺字段检测”而不是版本号

- 现状：`route-profiles.json` 和 `route-details.json` 都是 v1，新增字段依靠缺字段检测处理：
  - Route Detail：`completeRouteDetail` 要求 `pickup_volume_daily` 字段存在、route_id、station 和 route_name 一致，并且 ZIP 集合与 Profile 相同；不满足就重抓。`listCachedRouteIds().missingPickup` 也会让旧缓存重抓。
  - Route Profile：每次都整站覆盖，没有“缓存跳过”逻辑；缺 `postal_codes` 时，地图和导出会明确报错并提示重抓。
- 2026-10-07 实测：runtime 中有 155 条 detail，只有 1 条（route 831 `SFO01-001`）缺 `pickup_volume_daily`，它已经不在当前 SFO01 Profile 列表中（旧 Route 的残留），不会影响地图。
- 什么时候处理：下次新增必需字段、且无法靠“字段是否存在”判断新旧数据时，再升级 schema v2，并配套迁移或强制重抓。

### TD5 route_id 全局唯一假设

- 现状：`route-details.json` 以 `route_id` 作为 key。
- 2026-10-07 实测：runtime 中 19 个 Station 的 Profile 没有跨 Station 重复的 route_id；155 条 detail 的 key 与 route_id 全部一致，station 与 Profile 也全部一致。
- 结论：**当前数据支持全局唯一假设，但未由 DMS 官方契约确认。**
- 已有保护：地图 `detailFor` 和批处理 `completeRouteDetail` 都会额外比对 station，即使出现重复，也不会把别站的 detail 显示到本站。不过重抓会覆盖另一个 Station 的同 key 记录。
- 什么时候处理：真实数据中出现跨 Station 重复 route_id 时，再讨论 key 结构（需要升级 schema）。

### TD6 run 中有 limited Station 时仍记为 completed

- 现状：使用 `--max-routes-per-station` 时，Station 状态为 limited，但整个 run 的 status 仍是 completed（JSON 和 DB 都是这样）。
- 为什么暂不修：这个参数只用于测试，Worker 的正式刷新不传它，所以不会出现这种情况（Product Owner 2026-10-08）。

### TD7 公用电脑上的 repo 位于 OneDrive 同步目录

- 现状：repo 在 `OneDriveDesktopNorcal-dashboard`，开机启动的服务直接从这里运行。
- 影响：可能出现同步冲突，或者文件偶尔被锁住；数据、日志、密码都已经不在 OneDrive 中。
- 什么时候处理：部署到正式公用电脑或重新安装时，把 repo clone 到同步目录之外（Product Owner 2026-10-08 决定 P3 暂不迁移）。

### TD8 正式服务直接读取 repo 工作区的前端文件，并且静态白名单是固定的

- 现状：3000 和 3100 每次请求都从 repo 工作区读取 `web/` 文件，但服务端代码要等重启才会更新（包括静态白名单）。
- 影响：
  - 开发过程中的前端改动会立刻被局域网用户看到。
  - 新增的 web 文件在重启前会返回 404，2026-10-09 曾因此导致地图白屏（WH-FIX1）。
  - 为了避开这个问题，RM9 不新增文件，`web/map-view.js` 因此变长（约 300 行），需要拆分。
- 什么时候处理：和 TD7 一起处理，让正式服务从固定的发布版本运行。届时把 `map-view.js` 拆为标签、渲染等模块，同时更新白名单并重启服务。
