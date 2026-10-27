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
