# 按日期查看（Date View，DV）

状态：**Approved — 已实现（DV-T1..T4，2026-11-12）；migration 009 已在正式库执行（2026-11-12）；待 Product Owner UI 签字**

## 1. 目标

线路档案和线路地图都可以选择一个过去的日期，查看那一天的数据：表格、线路详情弹窗（概况）、地图、ZIP 搜索都跟着所选日期变化。默认仍然显示最新数据，行为与现在一致。

## 2. Product Owner 决定（2026-11-12）

| # | 决定 |
|---|---|
| V1 | 日期选择放在线路档案筛选栏 DSP 右边。没有数据的日期也列出，在日期旁边标“（空）”。 |
| V2 | 首票价格：查看过去日期时仍然显示**当前**价格（报价没有历史）。 |
| V3 | 线路详情弹窗（概况）也跟着所选日期。 |
| V4 | 线路地图、ZIP 搜索也要支持日期，两个页面的日期要连贯。 |
| V5 | DV-Q1、DV-Q2 按本 spec 默认方案执行（Product Owner 未提出修改，2026-11-12 授权实现）。DV-Q3 在 DV-T1 中核对后再定。 |

## 3. 现状（Claude 2026-11-12 检查）

- 每次刷新为每个 Station 写入新 snapshot，旧的状态为 `superseded`，不删除（RH 第 3 节）。约从 2026-10-07 起有数据，AR 上线前不连续。
- `nc.v_route_history_daily`（migration 008，已在正式库执行）：每个 Station 每个 Pacific 日取当天最后一个 active / superseded snapshot，只暴露少量列（名称、DSP、领件量、PPH、首公里、难度、ZIP 列表）。表格够用，但缺少完整 `profile` 和 `detail_version_id`。
- `snapshot_routes.detail_version_id` 把每条 Route 与当时的线路详情版本关联；`route_detail_versions` 保留所有 committed 版本，但 reader 现在只能读 `v_route_details`（每条 Route 最新版本）。
- 现有读取都只读“最新”：`getStationSnapshot`、`readRouteProfiles`（ZIP 搜索、地图使用）、`getRouteDetail`、`readRouteDetailsForMap`（`server/src/db/db-data-source.js`）。
- 首票价格来自 `v_route_quotation_first_0_1lb`（当前报价），不受日期影响。
- `DATA_SOURCE=json` 没有历史数据。

## 4. 方案

### 4.1 统一规则：“某天的数据”

- 所选日期 D（Pacific）下，每个 Station 使用**当天最后一个 active / superseded snapshot**（与 RH 视图同一规则）。
- 每条 Route 的详情使用该 snapshot 行上的 `detail_version_id` 指向的版本；没有关联版本时，显示“该日无详情”，不回退到最新版本（避免把新数据当成旧数据显示）。
- 首票价格始终是当前报价，表头/弹窗标注“当前报价”。
- 不选日期 = 最新，走现有代码路径，结果与现在完全一致。

### 4.2 数据（migration 009，只加视图）

- `nc.v_daily_snapshots`：每个 Station 每个 Pacific 日一个 snapshot（规则与 008 相同）。列：`station`、`day`、`snapshot_id`、`snapshot_at`、`fetched_at`、`source_as_of`、`total`。同时用于“有数据的日期列表”。
- `v_route_history_daily` 用 `CREATE OR REPLACE VIEW` 改为基于 `v_daily_snapshots`，输出列名、类型、顺序和结果完全不变，使“每天一个 snapshot”的规则只写一处。
- `nc.v_daily_snapshot_routes`：`v_daily_snapshots` JOIN `snapshot_routes`，列：`day`、`station`、`snapshot_id`、`route_id`、`ordinal`、`route_name`、`profile - 'raw'`（与 `v_active_routes` 同样的投影）、`detail_version_id`。
- `nc.v_route_detail_versions` / `nc.v_route_detail_version_zips`：所有 committed 的详情版本（投影与 `v_route_details` / `v_route_detail_zips` 相同，去掉 raw 字段），按 `id` 读取。
- 只 `GRANT SELECT` 给 reader（和 scraper，与 008 一致）；不改表、不改数据。正式库执行前备份（停止条件）。
### 4.3 数据访问 + API

- `db-data-source.js` 中现有读取函数增加可选参数 `day`：缺省时 SQL 和结果与现在相同；有 `day` 时读 4.2 的视图。表格、ZIP、地图共用同一个“按日读取”函数，不各写一套。
- 现有 API 统一接受可选 `date=YYYY-MM-DD`：`/api/route-profiles`、`/api/route-detail`、`/api/zip`、`/api/route-map`、`/api/district-map`（具体路径以 `server/src/api/app.js` 为准）。格式错误 / 未来日期返回 400；当天该 Station 无数据返回 200 + 空结果和 `empty: true`，不是 404。
- 新增 `GET /api/snapshot-days?station=<code>`（或 `district=`）：返回最早有数据的日期到今天（Pacific）的完整日期列表，每项 `{ day, has_data }`。
- JSON 模式：`snapshot-days` 返回 `{ available: false }`；其他接口带 `date` 时返回 400 `history_unavailable`。

### 4.4 前端：线路档案

- DSP 右边新增“日期”下拉框：第一项“最新”（默认），然后按日期倒序列出；无数据的日期显示为“11/05（空）”。
- 选中“（空）”的日期：表格显示“该日无数据”，筛选和排序保持不变。
- 选中过去日期时：顶部显示提示条“正在查看 11/08 的数据 · 回到最新”；“更新时间”显示该 snapshot 的时间，“线路总数”为当天数量；首票价格列标题注“当前报价”。
- DSP 下拉选项根据当天数据重新生成；如果原来选中的 DSP 当天不存在，回到“全部 DSP”。
- 刷新按钮行为不变；刷新完成后自动回到“最新”。
- 线路详情弹窗：概况显示当天版本；“历史”标签不变（本来就看 7/30 天），以所选日期为窗口终点的改动**不在本次范围**。

### 4.5 前端：线路地图 + 连贯

- 日期作为 URL 参数 `?date=YYYY-MM-DD`，两个页面都读取。顶部“线路档案 / 线路地图”切换链接带上当前日期，所以切换页面时日期保持不变；刷新页面或分享链接也能保留。没有参数 = 最新。
- 地图页使用同样的日期下拉组件（共享一个前端模块，不在两个页面各写一份）。
- 地图按所选日期显示线路 ZIP 区域和片区汇总；底图（ZIP 边界）和仓库位置不受日期影响。
- ZIP 搜索（两个页面）按所选日期查找。

## 5. 验收标准

- **DV-AC1** migration 009 只新增视图和授权；在测试库上可以重复执行；reader 能读新视图、不能读底层表。
- **DV-AC2** 不带 `date` 时，所有现有 API 的响应与改动前逐字段一致（现有测试全部通过，另加对比测试）。
- **DV-AC3** 带 `date` 时，每个 Station 只取当天最后一个 active / superseded snapshot；跨 UTC 午夜有测试；详情使用 `detail_version_id` 指向的版本，没有关联时返回“无详情”，不回退最新。
- **DV-AC4** `date` 格式错误、未来日期返回 400；当天无数据返回 `empty: true`；JSON 模式返回 `history_unavailable` / `available: false`。
- **DV-AC5** `snapshot-days` 返回从最早数据日到今天（Pacific）的连续日期，`has_data` 正确。
- **DV-AC6** 线路档案：日期下拉框在 DSP 右边；“最新”默认；空日期带“（空）”；过去日期显示提示条、当天更新时间和总数；首票价格标“当前报价”；DSP 选项按当天重建。
- **DV-AC7** 线路详情弹窗概况显示所选日期的版本；历史标签行为不变。
- **DV-AC8** 地图和 ZIP 搜索按所选日期显示；`?date=` 在两个页面间切换时保留；无参数时与现在完全一致。
- **DV-AC9** 390px 窄屏可用，无横向滚动；中文文案；不新增依赖。
- **DV-AC10** 用 30 天数据量测试，按日期读取的 API 本机响应 < 500 ms。

## 6. 任务拆分

| 任务 | 内容 | 授权 |
|---|---|---|
| DV-T1 | migration 009 视图 + `data-schema.md` + 测试库测试 | 实现授权；正式库执行另需确认 |
| DV-T2 | 数据访问层 `day` 参数 + API `date` 参数 + `snapshot-days` + 测试 | 实现授权 |
| DV-T3 | 共享日期下拉模块 + 线路档案表格 / 提示条 / 详情弹窗 | 实现授权；UI 预览签字 |
| DV-T4 | 地图页日期 + `?date=` 跨页面保留 + ZIP 搜索 | 实现授权；UI 预览签字 |

顺序：DV-T1 → T2 → T3 → T4。

## 7. 待确认 / 风险

- **DV-Q1** 片区视图（地图选片区、多个 Station）：某天只有部分 Station 有数据时，显示有数据的 Station，并标出哪些 Station 当天是“（空）”。下拉框中的“（空）”只在所有 Station 都没有数据时才标。是否同意？
- **DV-Q2** “（空）”日期是否允许选择？本 spec 默认**可以选**，选中后显示“该日无数据”。
- **DV-Q3（已核对，2026-11-12）** 正式库抽样 SFO01 全部 11 个有数据日（10/07–11/12），每天 36–37 条线路都有关联详情版本，空关联 0 条，不需要回退规则。原问题：早期 snapshot 的 `detail_version_id` 可能为空（需在测试库上核对比例）。如果大量为空，过去日期的详情 / 地图会大面积显示“无详情”，届时再决定是否允许回退到“该日之前最近的详情版本”。
- 风险：`db-data-source.js` 和 `app.js` 已经承担较多职责；按日读取逻辑放进独立的数据访问函数，API 层只做参数校验，避免继续堆在一处（CLAUDE.md 第 5.1 节）。

## 8. 实现记录（Implementation Notes）

- DV-T4（2026-11-12）：地图页复用 `web/date-view.js`，DSP 后新增日期选择和 `.view-date-notice` 提示。按片区加载 `snapshot-days`，列表不可用时隐藏选择并恢复最新；保留列表外日期为空日期。地图 / ZIP 请求携带所选日期，导航和 URL 同步日期并保留其他查询参数。根据 `stations_with_data` 显示片区缺失站点；单站点 404 / 空结果及整片区空日期采用无数据提示。日期切换复用地图 / ZIP 请求序号清除选择并丢弃旧响应，片区日期列表另用请求序号保护。更新时间继续读取地图响应的 `fetched_at`；DSP 继续按本次响应重建。后端、档案页、底图和仓库模块未改动，无依赖、数据结构或数据集变更。
- DV-T4 验证：全量 `npm.cmd test` 856 项通过，0 失败、0 跳过；随后补充片区日期列表竞态及空线路响应测试，地图定向测试共 62 项通过。Playwright 临时本地静态服务使用合成 API 数据验证历史日期、导航链接、部分站点提示、空日期、回到最新、ZIP 搜索和 390px 布局（body / document 宽度均为 390px，无 JavaScript 异常），不访问 DMS / 生产数据。项目无 lint / build 命令；`git diff --check` 通过。未提交、推送或部署；真实数据 UI 仍待 Product Owner 预览签字。

- DV-T3（2026-11-12）：新增共享前端 `web/date-view.js`（日期校验、URL / API 参数、日期选项及导航同步），加入 `server/src/api/static-files.js` 静态白名单。档案页在 DSP 后增加日期选择和历史提示，按日读取档案、ZIP 和详情概况；空日期显示“该日无数据”，DSP 按响应重建，报价标注当前值。站点切换重新加载日期列表，保留列表外的日期；列表不可用时隐藏选择并恢复最新。请求序号阻止旧站点响应覆盖新选择。`data-status.js` 保留自动初始化，默认重新加载移除 date、保留其他 URL 参数；无 date 时仍调用 reload。详情历史标签、报价弹窗及地图页面文件未修改，无依赖或数据结构变更。
- DV-T3 验证：新增共享模块 / 静态白名单测试，扩展档案、ZIP、详情、历史标签及默认刷新测试。Playwright 使用临时本地静态服务和合成 API 响应验证历史详情、空日期、回到最新及 390px 布局，页面宽度 390px，无横向滚动或 JavaScript 异常；不访问 DMS 或生产数据。UI 仍待 Product Owner 真实数据预览签字。全量测试和最终检查结果见交付报告；项目无 lint / build 命令。
- DV-T3 最终检查：`npm.cmd test` 852 通过、0 失败、0 跳过；相关前端定向测试 40 项通过；`git diff --check` 通过。使用 `npm.cmd` 执行项目原有 test script；未提交、推送或部署。

- DV-T1（2026-11-12）：新增 migration 009 的每日 snapshot / Route、全部 committed Detail / ZIP 视图；历史视图复用每日选择规则，投影及授权保持不变。不新增索引。新增真实测试库测试，覆盖 Pacific 日期、同日去重、版本关联 / 空关联、raw 清理、008 替换前后列与行对比、重复迁移及 reader 权限。同步更新既有迁移版本断言。正式库未执行；测试运行结果见本次交付报告。DV-Q3 的真实历史空关联比例未核对，合成测试数据不能推断该比例。
- DV-T1 检查：为避免读取 `.env`，使用 `node --test server/test/`；782 通过、2 失败、57 跳过。两项失败为现有 freshness / readonly-server 测试强制要求测试库配置；当前进程未配置 `NC_TEST_DB_*`，新增 DB 测试跳过，需本机补跑。迁移 runner 定向测试和 `git diff --check` 通过；无 lint / build 配置。
- DV-T2（2026-11-12）：按任务 brief 补齐 009 的 `v_daily_snapshots.source` 末列；新增 `daily-route-profiles.js`，DB data source 通过只读 `atDay(day)` 适配四个既有读取方法，其他方法沿用原来源。各次数据库读取继续使用 repeatable-read 只读事务。详情严格使用当日关联版本，空关联不回退；报价仍取当前值。API 共用日期校验与 Pacific 今天函数，七个读取接口接入日期，新增只读 `snapshot-days`（API / Worker 均可用），日期补全逻辑放在 `api/date-view.js`。未改 builder、前端或生产数据库。
- DV-T2 验证：新增 API 测试覆盖七接口默认响应对比、日期与 Pacific 午夜校验、JSON 不可用、空日期、片区部分成员有数据、连续日期、当前报价及 Worker 只读路由。真实测试库测试覆盖历史 Profile 元数据 / DSP / PPH、关联详情 / ZIP、空关联不回退、009 source 列及权限；30 天 × 533 条线路的 HTTP 测量低于 500 ms。全量 `npm.cmd test` 846 通过、0 失败、0 跳过；定向测试 6 项通过。PowerShell 禁止执行 npm.ps1，使用等价 npm.cmd 运行项目 test script。无 lint / build 配置；`git diff --check` 通过。测试仅使用隔离测试 schema，正式库未执行迁移。
- 部署（2026-11-12，Claude，Product Owner 授权）：`pg_dump -Fc --schema=nc` 备份到 runtime `backups/nc-before-009-2026-11-12T20-42-33-254Z.dump` → `npm run db:migrate`（009 applied，001–008 skipped）。3000 / 3100 已在此前重启为新代码。局域网验证：`snapshot-days`、`route-profiles?date=`、`route-map/district?date=` 返回正确；`route-history` 不受影响。
