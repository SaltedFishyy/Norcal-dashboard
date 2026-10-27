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
