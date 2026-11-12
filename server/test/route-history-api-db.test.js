import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createTestDb, dbSkip } from './db-helpers.js';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { startApiServer } from '../src/api/server.js';

test('RH-T1 reader history boundaries, metadata, names, numeric types and 30x550 API performance', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), run = randomUUID();
  // latest_day must use the history view: reader cannot query the base table.
  assert.equal((await db.reader.query(
    "SELECT has_table_privilege('station_snapshots', 'SELECT') AS can_read")).rows[0].can_read, false);
  await db.scraper.query(`INSERT INTO scrape_runs (id,trigger,status,requested_stations,options,started_at)
    VALUES ($1,'cli','completed',ARRAY['TST01'],'{}',now())`, [run]);
  await db.scraper.query("INSERT INTO stations(code) VALUES ('TST01')");
  // Synthetic fixture: 30 daily snapshots, each containing 550 routes.
  await db.owner.query(`INSERT INTO station_snapshots
    (station_code,run_id,status,origin,fetched_at,source,total,activated_at,created_at)
    SELECT 'TST01',$1,'superseded','dms','synthetic','dms-playwright',550,
      day::date + time '12:00' AT TIME ZONE 'America/Los_Angeles',
      day::date + time '12:00' AT TIME ZONE 'America/Los_Angeles'
    FROM generate_series(timestamp '2026-10-13',timestamp '2026-11-11',interval '1 day') day`, [run]);
  await db.scraper.query(`INSERT INTO snapshot_routes (snapshot_id,route_id,ordinal,route_name,profile)
    SELECT s.id,r,r-1,
      CASE WHEN s.activated_at < '2026-10-20T00:00Z' THEN 'Oldest-' || r
           WHEN s.activated_at < '2026-11-01T00:00Z' THEN 'Previous-' || r ELSE 'Current-' || r END,
      jsonb_build_object('pickup_volume',120,'pph',18.5,'first_mile_distance',12.3,
        'postal_codes',jsonb_build_array('00123','94005'),'route_difficulty','3','dsp_name','Synthetic')
    FROM station_snapshots s CROSS JOIN generate_series(1,550) r`);
  const source = createDbDataSource({ schema: db.schema,
    env: { NC_DB_READER_URL: process.env.NC_TEST_DB_READER_URL } });
  t.after(() => source.close());
  const seven = await source.readRouteHistory({ routeId: 1, days: 7, today: '2026-11-11' });
  assert.equal(seven.rows.length, 7);
  assert.equal(seven.rows[0].day, '2026-11-05');
  assert.equal(seven.rows.at(-1).day, '2026-11-11');
  assert.equal(seven.firstSeen, '2026-10-13');
  assert.equal(seven.lastSeen, '2026-11-11');
  assert.equal(seven.latestDay, '2026-11-11');
  assert.deepEqual(seven.formerNames, ['Previous-1', 'Oldest-1']);
  for (const field of ['pickup_volume', 'pph', 'first_mile_distance', 'zip_count'])
    assert.equal(typeof seven.rows[0][field], 'number');
  const missing = await source.readRouteHistory({ routeId: 999, days: 7, today: '2026-11-11' });
  assert.deepEqual(missing, { rows: [], firstSeen: null, lastSeen: null,
    latestDay: '2026-11-11', formerNames: [] });
  const server = await startApiServer({ dataSource: source, port: 0, now: () => new Date('2026-11-11T20:00Z') });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/route-history?route_id=1&days=30`);
  const body = await response.json(), elapsed = performance.now() - started;
  t.diagnostic(`RH-T1 30x550 API elapsed: ${elapsed.toFixed(1)} ms (local target <500 ms)`);
  assert.equal(response.status, 200);
  assert.equal(body.points.length, 30);
  assert.ok(elapsed < 2000, `API exceeded 2000 ms: ${elapsed.toFixed(1)}`);
  // A disappeared route retains metadata and former names outside the window.
  await db.owner.query(`DELETE FROM snapshot_routes WHERE route_id=2 AND snapshot_id IN
    (SELECT id FROM station_snapshots WHERE activated_at >= '2026-11-01T00:00Z')`);
  const gone = await source.readRouteHistory({ routeId: 2, days: 7, today: '2026-11-11' });
  assert.deepEqual(gone.rows, []);
  assert.equal(gone.lastSeen, '2026-10-31');
  assert.deepEqual(gone.formerNames, ['Oldest-2']);
  await db.owner.query(`UPDATE snapshot_routes SET profile='{}' WHERE route_id=3`);
  const nulls = await source.readRouteHistory({ routeId: 3, days: 7, today: '2026-11-11' });
  for (const field of ['pickup_volume', 'pph', 'first_mile_distance', 'zip_count'])
    assert.equal(nulls.rows[0][field], null);

});
