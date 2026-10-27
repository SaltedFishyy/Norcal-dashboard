# SFO02 Station

- Status: Implemented; capture complete; awaiting Product Owner preview sign-off
- Product Owner authorized adding and capturing SFO02 on 2026-10-26.
- Follow the existing District configuration, database membership and multi-station safe capture mechanisms. No special Station logic, Warehouse change, commit or push.

## Scope and acceptance criteria

1. Check file/database membership before writing; stop and report conflicts. Append SFO02 to the end of North Cal's existing order, preserving the other Stations and Districts. North Cal now has ten Stations. Maintain matching database membership and increment configuration version.
2. Profile, Map, Warehouse assignment validation and Refresh preview continue to use the shared District configuration. No new UI or data schema.
3. Capture only SFO02 via the existing `dms:scrape-stations` entry point using `--stations SFO02 --new-run`; do not use legacy single-Station scrapers or refresh the whole District.
4. Use JSON/database dual-write, complete Detail cache reuse and sequential Route processing with 2000 ms Route delay and 15000 ms Station delay. Preserve all request caps, identity checks and integrity validation. Stop on 429/5xx/session expiry/Station mismatch/validation failure; do not retry safety errors or invent missing Station data.
5. Keep DMS session and operational datasets outside the repository. Preserve existing snapshots on failure; activate SFO02 only after integrity passes. Report Route/Detail/request counts, failures and activation status.
6. Update affected configuration tests, run `npm test` and `git diff --check`, and verify live APIs after capture. Product Owner preview sign-off remains separate.

## Initial checks

- File/database membership conflict checks passed: SFO02 has no existing membership. No running run or scrape lock.
- Existing seed import is for empty tables only; add this membership with a scoped transaction. Do not change default legacy batch Station order; District Refresh scope reads the maintained configuration.

## Implementation and validation

- Added SFO02 at ordinal 9 (tenth Station) in `north-cal`, preserving prior order. File and database membership checks passed and configuration version incremented to 3.
- Ran the existing `runStationsBatch` implementation from `server/bin/dms-scrape-stations.js` with `--stations SFO02 --new-run --headless`, dual-write enabled and specified delays, without `--refresh`. No legacy scraper or other Station capture was run.
- Run `c5337144-687c-4e41-a207-9c01a4746e93` completed successfully. All Details and Station integrity checks passed; SFO02 independently activated, original Station restored, no safety stop. Per-Route business data, Detail counts and request totals remain in the private runtime summary files rather than repository assets. Boundary coverage produced missing-ZCTA warnings; no polygons or operational values were invented.
- Live Profile API returned 200 with the active snapshot's Route count. District API exposes ten North Cal Stations with SFO02 available; Worker Refresh preview includes all ten in order. Real Playwright Profile/Map verification selected SFO02, loaded Profile rows and map polygons, and observed no `pageerror`.
- Updated District seed counts, real configuration order and two old nine-Station Map/API assertions. Final `npm.cmd test` (`npm test` on Windows): 605/605 passed, 0 failed/skipped. No lint/build scripts configured. `git diff --check` passed with only existing Windows newline warnings.
- Changed files: `config/districts.json`, `docs/data-schema.md`, `docs/features/district.md`, this spec, `server/test/district-config.test.js`, `server/test/district-db.test.js`, `server/test/district-map.test.js`, `server/test/route-map-api.test.js`. Ignored `.handoff/` holds local operation/preview scripts and check logs.
- Acceptance criteria 1–6 met. Existing snapshot/Detail schemas unchanged; source remains authorized DMS browser automation with existing `fetched_at` freshness. No Warehouse records changed, no commit/push, and no special production scraping logic added.
