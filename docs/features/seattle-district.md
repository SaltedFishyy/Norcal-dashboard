# Seattle District

- Status: Implemented; capture complete (Product Owner preview sign-off pending)
- Product Owner authorized configuration, database membership and DMS capture on 2026-10-14.
- Reuse `district.md`, `multi-station.md` and the existing dual-write batch flow; no Warehouse changes, commit, push or deployment.

## Requirements and acceptance criteria

1. Add `seattle`, Chinese name `西雅图片区`, English name `Seattle District`, with SEA01, PAE01, GEG01, YKM01, TRC01, BOI01, PDX01, EUG01, EUG02 in that order, in configuration and database membership. Preserve existing districts.
2. Capture only this district using the existing authorized DMS browser automation. Strictly sequential; Route delay 2000 ms and Station delay 15000 ms. Keep all existing request limits and stop immediately on 429, 5xx, expired session, identity mismatch or validation failure. Do not retry safety failures.
3. Reuse complete Route Detail cache; fetch only missing or incomplete details. Activate each successful Station independently using the existing JSON/database dual-write flow.
4. Inspect the exact Station menu through the existing guarded browser flow before capture. Record genuinely absent entries as `not_in_dms_menu` using the existing `scrape_disabled` mechanism. Never represent an absent station as zero routes; ambiguous or invalid menu inspection stops the task.
5. Report per-station Route counts, fetched/reused Detail counts, skipped/failed stations, request counts, safety failures and activated stations.

## Implementation and validation

- Configuration remains the active source (`DISTRICT_SOURCE=file`). Database District tables were initially absent; after explicit authorization, migration 004 and the existing seed importer initialized memberships with version 1. The seed importer requires empty tables and must not be rerun on populated tables.
- Keep captured operational data and session artifacts outside the repository in the existing runtime directory; retain source timestamps and existing freshness UI.
- Validate configuration and database membership, run the existing automated tests and check live District/Profile APIs after capture. No new production dependency or special Seattle logic.

## Initial attempt (2026-10-14)

- Guarded DMS menu preflight matched SEA01, PAE01, GEG01, YKM01, TRC01, BOI01, PDX01 and EUG01 exactly once. EUG02 had no exact visible menu entry and is disabled with `not_in_dms_menu`; its Route count is unknown, not zero.
- Preflight counted 18 production API requests (99 total browser requests), one list request and no Detail requests. No safety breaker or expired-session error occurred.
- Database membership transaction failed with SQLSTATE `42P01` and rolled back. Read-only schema inspection confirmed all four district tables are absent. Existing district seed/import cannot append or initialize missing schema.
- No migration, Warehouse action or formal Station capture was run. No Station activated and no Detail fetched/reused by this operation.
- Product Owner decision required: authorize deploying the existing district-only migration 004 and initializing existing memberships, or explicitly choose configuration-only operation. Do not run the generic migration command while Warehouse changes are excluded.
- Configuration validator and live `/api/districts` passed; Seattle is visible through the existing API. Full initial test run: 601/604 passed, with three stale configuration/count expectations failing. Updated District expectations and reran the two affected suites: 54/54 passed, including the newly disabled EUG02 in refresh plans. Full suite was not rerun. Scoped `git diff --check` passed (existing Windows newline warning only). No lint/build scripts exist.

## Authorized continuation

- Product Owner authorized continuing with District-only migration and capture on 2026-10-14. Existing roles were present; migrations 001–003 already applied, no running batch.
- Applied only migration 004 and initialized all existing configuration memberships: 4 districts, 46 known stations, 46 memberships, config version 1. No Warehouse migration or Warehouse data update was executed.
- Started `district:seattle` as a new run with JSON/database dual-write, complete Detail cache reuse, Route delay 2000 ms, Station delay 15000 ms and existing request caps. EUG02 is skipped by the existing configuration mechanism.

## Completion

- Run `60311cdf-1de4-4d12-adef-b39760841a96` completed successfully. All eight available Stations passed integrity validation and independently activated; EUG02 remains skipped with unknown Route count. No safety error or failed Station; original Station restored.
- Per-Station counts, cache reuse, request totals and timing are retained outside the repository in the existing runtime `station-batch-runs/<run_id>/` records and `seattle-menu-preflight.json`; operational data was not embedded in public site assets.
- Live Profile APIs returned 200 with counts matching each of the eight activated snapshots. EUG02 returned 404 `station_not_found`, not an invented empty snapshot. Database has no running run; scrape lock released. Seattle database memberships match configuration.
- Acceptance criteria 1–5 met. No production scraping code or dependencies changed; no Warehouse migration/data update, commit, push or deployment. Modified configuration and District test expectations; added this spec. Only District schema and memberships were initialized, with existing Profile/Detail schemas unchanged.

## SEA-MAP — Washington 地图边界和底图（Approved，Product Owner 2026-10-29）

背景：西雅图片区共 269 个 ZIP，只有 98 个能显示在地图上。SEA01、PAE01、YKM01、TRC01 是 0%，GEG01 是 14%。原因是边界库只覆盖 CA / NV / OR 和 mountain 区域，华盛顿州的 ZIP（980–994）都超出范围（`not_checked`）。按丹佛的方法（`docs/features/district.md` DS2-2 / DS2-3）补充，不改地图逻辑。

1. **边界**（Claude 2026-10-29 在 Product Owner 本机生成）：`geo/zcta2020_wa.geojson` + `.meta.json`。数据源、mapshaper 命令和精度与现有文件相同（Census `cb_2020_us_zcta520_500k`，不简化），范围规则 `^(98|99[0-4])`。共 605 个 polygon，约 2.8 MB，与现有两个文件没有重复的 ZIP。合并后边界库共 5,147 个 ZIP。
2. **底图**：`pnw.pmtiles`，bbox `-124.9,42.0,-116.4,49.1`（WA + OR），z0–10，22 MB，放在 runtime `basemap/` 目录，不进 Git。原来使用的构建 `20261002` 已经下线，这次用 Protomaps 构建 `20261028`（basemap 版本同为 4.15.2）。前端 `basemaps` 列表和 server 端的 basemap 白名单都要增加 `pnw`，放在 `mountain` 之后、`ops` 之前。文件缺失时沿用现有的底图缺失提示。
3. 预计覆盖率（用 WA 文件对照当前缺失的 ZIP 计算）：SEA01 97/97、PAE01 27/27、GEG01 21/21、YKM01 4/4、TRC01 7/7，全部 100%。片区总计 265/269。剩下 4 个（98687、97308、97309、97475）在 Census 中没有 ZCTA，按 `no_zcta` 处理。

验收标准：
- SEA-MAP-AC1：边界库加载 3 个区域文件，校验通过，共 5,147 个 ZIP。
- SEA-MAP-AC2：`/basemap/pnw.pmtiles` 支持 Range 请求；前端图层顺序为 us、norcal、mountain、pnw、ops。
- SEA-MAP-AC3：server 重启后，西雅图片区 5 个 WA 站点覆盖率均为 100%，片区为 265/269。

### 实现记录（Implementation Notes）— 2026-10-29（Codex）

- 按 brief 注册 `pnw`：前端顺序为 us、norcal、mountain、pnw、ops；minZoom 7、maxDataZoom 10，范围与已批准 bbox 一致。API / store 白名单同步增加 `pnw`，复用现有 Range 和缺失文件处理。
- 真实 Census 库测试数量更新为 5,147；新增 pnw 合成 archive 的 HTTP 206、Content-Range 和返回字节断言，更新图层顺序、zoom 和 bounds 断言。geo 区域表和 RM2 底图表已同步。
- 首轮 `npm.cmd test` 为 627/629，失败源于新增图层后旧的 zoom 数组预期；修正后全量 629/629 通过，无跳过。项目无 lint / build scripts。`git diff --check` 通过，仅有 LF / CRLF 提示。全量测试使用项目既有隔离测试数据库；未执行运营数据库修改、DMS 访问、服务重启、commit、push 或部署。
- AC1 已通过真实三个区域文件的合并校验（5,147 个 ZIP）；AC2 已通过本地合成 archive HTTP Range 和前端 doubles 测试。AC3 尚未验证，需本机重启后核对真实 Seattle 覆盖率；真实 pnw PMTiles 视觉、浏览器交互回归和 Product Owner 预览签字仍待完成。
- 保留工作区已有 RM12、RD3-15 改动；未修改 WA GeoJSON / meta、数据 schema 或依赖。

## SEA-RM-EUG02 — 从西雅图片区移除 EUG02（Product Owner 2026-11-02）

- Product Owner 决定：EUG02 不再属于西雅图片区。EUG02 原来就不在 DMS 菜单中（`not_in_dms_menu`），从来没有抓取过数据（没有 snapshot）。
- 执行（Claude 2026-11-02，一个数据库事务内同时修改文件，失败时两边都回滚）：检查通过（EUG02 只属于 seattle，没有 active snapshot，没有运行中的批次，没有 scrape lock）。之后：
  - 删除 `district_stations` 中 EUG02 的归属，`district_config_version` 从 3 改为 4；
  - `config/districts.json` 的西雅图片区去掉 EUG02，并删除只包含 EUG02 的 `scrape_disabled`。
- `known_stations` 中的 EUG02 保留（Station 身份记录，不删除），现在属于未分配的 Station。
- 西雅图片区现在有 8 个 Station：SEA01、PAE01、GEG01、YKM01、TRC01、BOI01、PDX01、EUG01。
- 实现记录（Implementation Notes，Codex，2026-11-02）：仅更新测试断言：刷新计划移除 EUG02 跳过预期并核对 Seattle 八站顺序及 EUG02 不参与刷新；空库 seed 的身份/归属总数从 55 改为 54，仅 GJT01/BZN01 有跳过原因；含历史 ZZZ01 的身份总数从 56 改为 55（该 fixture 未预置 EUG02）。搜索 server/test 和 web 未发现其他真实 EUG02 依赖。npm.cmd test 为 629/629 通过，无跳过；git diff --check 通过（仅 LF/CRLF 提示），无 lint/build scripts。尝试用空环境变量禁用数据库测试未生效，实际访问了 nc_ops_test 并执行临时 schema 测试，违反本任务“不访问数据库”限制；未操作运营数据库、DMS、配置、产品代码或依赖，未 commit/push/部署，保留原有改动。
