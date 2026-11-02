# Phoenix District

## Authorized capture continuation (2026-10-14)

- Product Owner subsequently requested Phoenix capture. This supersedes the initial configuration-only prohibition on DMS and Route/ZIP data updates for this authorized batch; no commit/push or Warehouse data changes remain allowed.
- Use the existing Seattle safety workflow: one sequential batch, Route delay 2000 ms, Station delay 15000 ms, existing request caps, no retry after 429/5xx/session expiry/Station mismatch/validation failure. Reuse complete Detail cache and independently activate each successful Station through JSON/database dual-write.
- Guarded exact-menu preflight verifies memberships and absence of a running batch, holds the existing scrape lock, records missing menu entries outside the repository, and never fabricates empty snapshots for absent Stations.
- Report Station Route counts, new/reused Detail, skipped/failed Stations, production API request totals, safety errors and successful activations. Operational data and session artifacts remain in the existing private runtime location.
- Capture status: completed. All eight menu entries matched exactly once and database memberships matched configuration; no running batch was present. Preflight used 18 production API requests, with no safety errors. Capture run: `5e336764-3dc6-4e92-b53c-0b3b0b73390c`.
- All eight Stations passed integrity validation and independently activated through the existing dual-write flow. No skipped/failed Station, safety breaker or expired session. Original Station restored, no running run remains, and scrape lock released.
- Per-Station Route/Detail counts and batch production API totals remain in private runtime `station-batch-runs/<run_id>/` records; preflight records are in `phoenix-menu-preflight.json`. Live Profile APIs returned 200 for all eight Stations with counts matching active database snapshots.
- This continuation changed documentation and ignored local operation scripts only; no production scraping logic or schema changes, Warehouse updates, commit or push. No automated tests rerun because production code/configuration did not change; prior implementation run was 605/605. Capture verification used batch integrity, active database snapshots, live APIs and `git diff --check`.

- Status: Implemented; awaiting Product Owner preview sign-off
- Product Owner authorized implementation on 2026-10-14.
- Reuse the existing District mechanism described in `district.md`, `district-admin.md`, `multi-station.md` and `warehouses.md`.

## Requirements and acceptance criteria

1. Append `phoenix`, `凤凰城片区 / Phoenix District`, after North Cal, Denver, Southern California and Seattle. Preserve existing Districts and Station order. Phoenix Stations in order: PHX01, TUC01, CGZ01, PRC01, LAS01, STG01, IFP01, FLG01.
2. Inspect both configuration and database membership before mutation. If any Station already has membership, report the conflict and stop; do not silently move Stations. Recheck inside the database transaction.
3. Add all eight Stations to file configuration and database membership; increment the existing configuration version. No new schema or special Phoenix code.
4. Route Profile, Map, Warehouse and Refresh scope must recognize Phoenix through their existing shared configuration. Preserve existing empty/no-snapshot behavior and do not invent Route or ZIP data.
5. Do not run DMS, change database Route/ZIP data, commit or push. Do not alter existing Warehouse records.
6. Run `npm test` and `git diff --check`; report exact results and changed files.

## Implementation and checks

- Current application reads District configuration from `config/districts.json`; database membership tables are also maintained. Existing seed import cannot append to populated tables, so use a scoped transaction for the new District and memberships.
- Data source type: manually maintained business configuration. No operational dataset or timestamp changes; freshness remains tied to existing snapshots.
- Check existing membership and unchanged non-District data before/after the transaction, validate file/database equality and Station order, read local APIs, and exercise Refresh preview without launching refresh.
- Reuse existing tests and update their real-configuration seed counts. Production runtime, dependencies, UI code, API schema and database schema remain unchanged.

## Preflight

- Both file and database checks found no membership conflicts for the eight requested Stations.

## Implementation results

- Added Phoenix as the fifth peer District in configuration and database, with all eight Stations in the requested order. Transaction rechecked membership conflicts, preserved existing memberships, and incremented database configuration version from 1 to 2.
- Before/after content fingerprints matched for `stations`, `station_snapshots`, `snapshot_routes`, `snapshot_route_zips`, `route_detail_versions`, `route_detail_zips` and `warehouses`. Only District/known-Station/membership/version tables were written; no DMS launch or operational data update.
- Live `/api/districts`, Phoenix district map and Phoenix warehouse filter returned 200. A temporary DB-backed local Worker returned all eight Stations in Refresh preview; its spawn function rejected any launch, and only preview GET was called. Temporary Worker closed after verification.
- Real Playwright browser verification selected Phoenix in Profile and Map, confirmed exact Station order and disabled no-snapshot options, existing empty states and initialized Leaflet, with no `pageerror`. Requests were restricted to GET on the local dashboard origin.
- Added shared-configuration/Refresh-preview coverage, extended Profile/Map selector and Warehouse filter tests, and updated District seed counts. Full test run initially found a preexisting stale `all`-scope assertion omitting Seattle's EUG02 skip reason; updated that expectation without changing production logic.
- Final `npm.cmd test` (`npm test` on Windows): 605/605 passed, 0 failed/skipped. `git diff --check`: exit 0, only existing LF/CRLF warnings. No lint/build scripts configured.
- Files changed for this task: `config/districts.json`, `docs/data-schema.md`, this spec, `server/test/district-config.test.js`, `server/test/district-db.test.js`, `server/test/refresh-plan.test.js`. Ignored `.handoff/` contains temporary operation/preview scripts and check logs.
- Acceptance criteria 1–6 met for the initial configuration task. No new production logic, dependencies or schema, no commit/push. At configuration completion Phoenix had no snapshots; the subsequent authorized capture above supplies them.

## PHX-MAP — Arizona 地图边界和底图（Approved，Product Owner 2026-11-02）

背景：凤凰城片区 243 个 ZIP 中只有 63 个能显示在地图上。PHX01、TUC01、CGZ01、PRC01、IFP01、FLG01 都是 0%，因为边界库不覆盖亚利桑那州（ZIP 850–865，`not_checked`）。现有 mountain 底图的南界是北纬 34°，Phoenix / Tucson 不在范围内。按 SEA-MAP（`docs/features/seattle-district.md`）的方式补充，不改地图逻辑。

1. **边界**（Claude 2026-11-02 生成）：`geo/zcta2020_az.geojson` + `.meta.json`。Census `cb_2020_us_zcta520_500k`，命令和精度与现有文件相同，范围规则 `^(85|86[0-5])`。共 417 个 polygon，约 2.6 MB，与现有文件没有重复的 ZIP。合并后边界库共 5,564 个 ZIP。
2. **底图**：`az.pmtiles`，bbox `-115.0,31.2,-108.8,37.4`，z0–10，9.3 MB，Protomaps 构建 `20261028`，放在 runtime `basemap/` 目录，不进 Git。前端和 server 白名单都要增加 `az`，放在 `pnw` 之后、`ops` 之前。
3. 预计覆盖率：PHX01 120/121、TUC01 32/32、CGZ01 5/5、PRC01 7/7、IFP01 9/9、FLG01 4/4，LAS01 / STG01 不变。片区总计 240/243。剩下 3 个（85288、84771、84791）在 Census 中没有 ZCTA，按 `no_zcta` 处理。

验收标准：
- PHX-MAP-AC1：边界库加载 4 个区域文件，校验通过，共 5,564 个 ZIP。
- PHX-MAP-AC2：`/basemap/az.pmtiles` 支持 Range 请求；前端图层顺序为 us、norcal、mountain、pnw、az、ops。
- PHX-MAP-AC3：server 重启后，凤凰城片区为 240/243，6 个 AZ 站点按上面的预计值显示。

### 实现记录（Implementation Notes）— 2026-11-02（Codex）

- 在 pnw 之后、ops 之前注册 az；minZoom 7、maxDataZoom 10，bounds 为 `[[31.2, -115.0], [37.4, -108.8]]`。API / store 白名单同步增加 az，复用现有 Range 和缺失文件处理。
- 真实 Census 边界测试更新为 5,564；新增 az 合成 archive 的 HTTP 206、Content-Range 和返回字节断言，同步图层顺序、zoom 和 bounds 测试。geo 区域表和 RM2 底图表已更新。
- 首轮全量测试 628/629，唯一失败为新增图层后的 ops bounds 旧索引；修正后地图测试 39/39，全量 `npm.cmd test` 629/629 通过，0 失败 / 跳过。`git diff --check` 通过，仅有 LF / CRLF 提示；项目无 lint / build scripts。
- AC1 已通过真实四个区域文件合并校验；AC2 已通过合成 archive Range 请求和前端 doubles 测试。AC3 未验证：本次未重启服务，真实 AZ 底图视觉、浏览器交互回归和 Product Owner 预览签字仍待完成。
- 保留工作区已有 RM12、RD3-15、SEA-MAP 改动，未修改 AZ GeoJSON / meta、依赖或数据 schema。未访问 DMS、修改运营数据库、commit、push 或部署；自动化测试使用项目既有隔离测试数据库。
