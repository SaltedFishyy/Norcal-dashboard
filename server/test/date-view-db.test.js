import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { performance } from 'node:perf_hooks';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { startApiServer } from '../src/api/server.js';
import { centralFixture } from './central-db-fixtures.js';
import { details } from './route-map-fixtures.js';
import { createTestDb, dbSkip } from './db-helpers.js';
import { migrate } from '../src/db/migrate.js';

test('DV-T2 historical HTTP, linked details, empty days and 30x533 API performance', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), f = await centralFixture(t), run = randomUUID();
  await db.scraper.query(`INSERT INTO scrape_runs (id,trigger,status,requested_stations,options,started_at)
    VALUES ($1,'cli','completed',ARRAY['AAA01','ZZZ01'],'{}',now())`, [run]);
  await db.scraper.query("INSERT INTO stations(code) VALUES ('AAA01'),('ZZZ01')");
  const versions = [];
  for (const name of ['Historical detail', 'Latest detail']) {
    const detail = { ...details().routes['1'], station: 'AAA01', route_name: name };
    const id = (await db.scraper.query(`INSERT INTO route_detail_versions
      (route_id,station_code,run_id,origin,status,fetched_at,detail)
      VALUES (1,'AAA01',$1,'dms','committed','synthetic',$2) RETURNING id`, [run, detail])).rows[0].id;
    versions.push(id);
    await db.scraper.query(`INSERT INTO route_detail_zips(detail_version_id,ordinal,postal_code,zip)
      VALUES ($1,0,'00123',$2)`, [id, { ...detail.zips[0], postal_code: '00123', experienced_pph: versions.length * 10 }]);
  }
  // Synthetic 30 days, 533 routes per day. Unique ZIP coverage avoids conflicts in map builders.
  await db.owner.query(`INSERT INTO station_snapshots
    (station_code,run_id,status,origin,fetched_at,source_as_of,source,total,activated_at,created_at)
    SELECT 'AAA01',$1,CASE WHEN day::date='2026-11-11' THEN 'active' ELSE 'superseded' END,
      'dms',day::date::text,day::date::text,'dms-playwright',533,
      day::date + time '12:00' AT TIME ZONE 'America/Los_Angeles',
      day::date + time '12:00' AT TIME ZONE 'America/Los_Angeles'
    FROM generate_series(timestamp '2026-10-13',timestamp '2026-11-11',interval '1 day') day`, [run]);
  await db.scraper.query(`INSERT INTO snapshot_routes
    (snapshot_id,route_id,ordinal,route_name,profile,detail_version_id)
    SELECT s.id,r,r-1,'Synthetic-' || r,
      jsonb_build_object('route_id',r,'route_name','Synthetic-' || r,'station','AAA01',
        'dsp_name',s.fetched_at,'pph',extract(day FROM s.activated_at), 'pickup_volume',120,
        'postal_codes',CASE WHEN r=1 THEN jsonb_build_array('00123') ELSE '[]'::jsonb END),
      CASE WHEN r=1 AND s.fetched_at<>'2026-10-14'
        THEN CASE WHEN s.fetched_at='2026-11-11' THEN $2::bigint ELSE $1::bigint END END
    FROM station_snapshots s CROSS JOIN generate_series(1,533) r`, versions);
  const source = createDbDataSource({ schema: db.schema,
    env: { NC_DB_READER_URL: process.env.NC_TEST_DB_READER_URL } });
  t.after(() => source.close());
  const server = await startApiServer({ ...f, dataSource: source, port: 0,
    now: () => new Date('2026-11-12T00:01Z') });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: response.status, body: await response.json() };
  };
  const historical = source.atDay('2026-10-13');
  assert.ok(Object.isFrozen(historical));
  assert.equal(historical.source, 'db');
  assert.equal(historical.readCurrentFirstPrices, source.readCurrentFirstPrices);
  const profiles = await historical.readRouteProfiles();
  assert.equal(profiles.stations.AAA01.source, 'dms-playwright');
  assert.equal(profiles.stations.AAA01.rows.length, 533);
  const first = await get('/api/route-profiles?station=AAA01&date=2026-10-13');
  assert.equal(first.status, 200);
  assert.equal(first.body.fetched_at, '2026-10-13');
  assert.equal(first.body.total, 533);
  assert.equal(first.body.rows[0].pph, 13);
  assert.equal(first.body.rows[0].dsp_name, '2026-10-13');
  const latest = await get('/api/route-profiles?station=AAA01');
  assert.equal(latest.body.fetched_at, '2026-11-11');
  assert.deepEqual(await get('/api/route-profiles?station=AAA01&date=2026-11-11'), latest);
  const detail = await get('/api/route-details?route_id=1&date=2026-10-13');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.route_name, 'Historical detail');
  assert.equal(detail.body.zips[0].experienced_pph, 10);
  assert.equal((await get('/api/route-details?route_id=1')).body.route_name, 'Latest detail');
  assert.equal((await get('/api/route-details?route_id=1&date=2026-10-14')).status, 404);
  assert.deepEqual(await source.atDay('2026-10-14').readRouteDetailsForMap(), { status: 'none', routes: {} });
  assert.equal((await get('/api/route-details?route_id=2&date=2026-10-13')).status, 404);
  assert.equal((await get('/api/route-details?route_id=9999&date=2026-10-13')).status, 404);
  const mapDetails = await historical.readRouteDetailsForMap();
  assert.deepEqual(Object.keys(mapDetails.routes), ['1']);
  assert.equal(mapDetails.routes['1'].route_name, 'Historical detail');
  assert.deepEqual(await source.atDay('2026-10-12').readRouteProfiles(), { schema_version: 1, stations: {} });
  const empty = await get('/api/route-profiles?station=AAA01&date=2026-10-12');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.empty, true);
  assert.equal((await get('/api/districts?date=2026-10-12')).body.districts[0].stations[0].has_snapshot, false);
  assert.deepEqual(await source.readSnapshotDays({ stations: ['ZZZ01'] }), []);
  const calendar = await get('/api/snapshot-days?district=mock');
  assert.equal(calendar.body.days.length, 30);
  assert.deepEqual(calendar.body.days[0], { day: '2026-11-11', has_data: true, stations_with_data: ['AAA01'] });
  for (const path of ['/api/route-profiles?station=AAA01', '/api/route-map/district?district=mock']) {
    const start = performance.now();
    const response = await get(`${path}&date=2026-10-13`);
    const elapsed = performance.now() - start;
    t.diagnostic(`DV-T2 30x533 ${path.split('?')[0]}: ${elapsed.toFixed(1)} ms`);
    assert.equal(response.status, 200);
    assert.ok(elapsed < 500, `Daily API exceeded 500 ms: ${elapsed.toFixed(1)}`);
  }
});

test('DV-T1: daily selection, version projections, 008 parity and privileges', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), run = randomUUID();
  await db.scraper.query(`INSERT INTO scrape_runs (id, trigger, status, requested_stations, options, started_at)
    VALUES ($1, 'cli', 'completed', ARRAY['TST01','TST02'], '{}', now())`, [run]);
  await db.scraper.query("INSERT INTO stations(code) VALUES ('TST01'), ('TST02')");
  const versions = [];
  for (const status of ['committed', 'committed', 'pending']) {
    const id = (await db.scraper.query(`INSERT INTO route_detail_versions
      (route_id, station_code, run_id, origin, status, fetched_at, detail)
      VALUES (1,'TST01',$1,'dms',$2,'synthetic', $3) RETURNING id`,
    [run, status, { label: status, capacity_raw: { synthetic: true } }])).rows[0].id;
    versions.push(id);
    await db.scraper.query(`INSERT INTO route_detail_zips (detail_version_id, ordinal, postal_code, zip)
      VALUES ($1,0,'00123',$2)`, [id, { postal_code: '00123', raw: { synthetic: true } }]);
  }
  const profiles = [
    { dsp_name: 'Synthetic DSP', pickup_volume: 120, pph: 12.5, first_mile_distance: 3.25,
      route_difficulty: 'synthetic', postal_codes: ['00123'], raw: { synthetic: true } },
    { pickup_volume: '120', pph: {}, first_mile_distance: false, postal_codes: '00123' },
    { pickup_volume: null, postal_codes: [] }, {}
  ];
  async function snapshot(station, status, at, created = at) {
    const id = (await db.owner.query(`INSERT INTO station_snapshots
      (station_code,run_id,status,origin,fetched_at,source_as_of,source,total,activated_at,created_at)
      VALUES ($1,$2,$3,'dms','synthetic-fetched','synthetic-as-of','dms-playwright',4,$4,$5) RETURNING id`,
    [station, run, status, at, created])).rows[0].id;
    for (const [ordinal, profile] of profiles.entries()) {
      await db.scraper.query(`INSERT INTO snapshot_routes
        (snapshot_id,route_id,ordinal,route_name,profile,detail_version_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, ordinal + 1, ordinal, `Synthetic ${ordinal}`, profile, ordinal === 0 ? versions[0] : null]);
    }
    return id;
  }
  const previous = await snapshot('TST01', 'superseded', '2026-11-10T07:30:00Z');
  await snapshot('TST01', 'superseded', '2026-11-10T08:30:00Z');
  await snapshot('TST01', 'superseded', '2026-11-10T20:00:00Z');
  const latest = await snapshot('TST01', 'active', '2026-11-10T20:00:00Z');
  await snapshot('TST01', 'pending', '2026-11-10T23:00:00Z');
  await snapshot('TST01', 'rejected', '2026-11-11T23:00:00Z');
  const fallback = await snapshot('TST02', 'superseded', null, '2026-11-10T08:30:00Z');
  const daily = await db.reader.query(`SELECT *, day::text AS day_text FROM v_daily_snapshots ORDER BY station, day`);
  assert.deepEqual(daily.rows.map(r => [r.station, r.day_text, r.snapshot_id]), [
    ['TST01', '2026-11-09', previous], ['TST01', '2026-11-10', latest], ['TST02', '2026-11-10', fallback]
  ]);
  assert.equal(daily.fields.at(-2).name, 'source'); // day_text is appended by this test query.
  assert.ok(daily.rows.every(row => row.source === 'dms-playwright'));
  assert.equal(daily.rows[0].snapshot_at.toISOString(), '2026-11-10T07:30:00.000Z');
  assert.equal(daily.rows[2].snapshot_at.toISOString(), '2026-11-10T08:30:00.000Z');
  assert.ok(daily.rows.every(r => r.fetched_at === 'synthetic-fetched' && r.source_as_of === 'synthetic-as-of' && r.total === 4));
  const routes = (await db.reader.query('SELECT * FROM v_daily_snapshot_routes ORDER BY station, day, ordinal')).rows;
  assert.equal(routes.length, 12);
  assert.ok(routes.every(r => !Object.hasOwn(r.profile, 'raw')));
  assert.deepEqual(routes.slice(0, 4).map(r => r.detail_version_id), [versions[0], null, null, null]);
  assert.deepEqual(routes[0].profile, Object.fromEntries(Object.entries(profiles[0]).filter(([key]) => key !== 'raw')));
  const details = (await db.reader.query('SELECT * FROM v_route_detail_versions ORDER BY id')).rows;
  assert.deepEqual(details.map(r => r.id), versions.slice(0, 2));
  assert.ok(details.every(r => !Object.hasOwn(r.detail, 'capacity_raw')));
  assert.equal((await db.reader.query('SELECT * FROM v_route_detail_versions WHERE id=$1', [versions[0]])).rowCount, 1);
  const zips = (await db.reader.query('SELECT * FROM v_route_detail_version_zips ORDER BY detail_version_id')).rows;
  assert.deepEqual(zips.map(r => r.detail_version_id), versions.slice(0, 2));
  assert.ok(zips.every(r => r.route_id === '1' && r.postal_code === '00123' && !Object.hasOwn(r.zip, 'raw')));

  // Reinstall the exact 008 view definition, preserving grants, then apply 009 in a transaction.
  // No table data or migration ledger is changed, and no view is dropped.
  const oldSql = await readFile(new URL('../db/migrations/008_route_history.sql', import.meta.url), 'utf8');
  const oldView = oldSql.slice(oldSql.indexOf('CREATE VIEW v_route_history_daily'), oldSql.indexOf('\nCREATE INDEX'))
    .replace('CREATE VIEW', 'CREATE OR REPLACE VIEW');
  const template = await readFile(new URL('../db/migrations/009_date_view.sql', import.meta.url), 'utf8');
  const identifiers = { schema: db.schema, scraper_role: db.options.scraperRole, reader_role: db.options.readerRole };
  const sql = template.replace(/\{\{(\w+)\}\}/g, (_, key) => pg.escapeIdentifier(identifiers[key]));
  const historyQuery = 'SELECT * FROM v_route_history_daily ORDER BY station, day, route_id';
  await db.owner.query('BEGIN');
  try {
    await db.owner.query(oldView);
    const before = await db.owner.query(historyQuery);
    // Other 009 views already exist from createTestDb; replace them to exercise the full SQL again.
    await db.owner.query(sql.replaceAll('CREATE VIEW', 'CREATE OR REPLACE VIEW'));
    const after = await db.owner.query(historyQuery);
    const columns = result => result.fields.map(({ name, dataTypeID, dataTypeSize, dataTypeModifier }) =>
      ({ name, dataTypeID, dataTypeSize, dataTypeModifier }));
    assert.deepEqual(columns(after), columns(before));
    assert.deepEqual(after.rows, before.rows);
    await db.owner.query('COMMIT');
  } catch (error) {
    await db.owner.query('ROLLBACK');
    throw error;
  }
  const results = [];
  await migrate(db.owner, { ...db.options, onResult: r => results.push(r) });
  assert.deepEqual(results.at(-1), { version: '009', result: 'skipped' });
  assert.ok(results.every(r => r.result === 'skipped'));
  for (const view of ['v_daily_snapshots', 'v_daily_snapshot_routes', 'v_route_detail_versions', 'v_route_detail_version_zips', 'v_route_history_daily']) {
    assert.ok((await db.reader.query(`SELECT * FROM ${view}`)).rowCount > 0);
    assert.ok((await db.scraper.query(`SELECT * FROM ${view}`)).rowCount > 0);
    const publicGrant = await db.owner.query(`SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
      WHERE c.relnamespace=$1::regnamespace AND c.relname=$2 AND a.grantee=0`, [db.schema, view]);
    assert.equal(publicGrant.rowCount, 0);
  }
  for (const table of ['station_snapshots', 'snapshot_routes', 'route_detail_versions', 'route_detail_zips']) {
    await assert.rejects(db.reader.query(`SELECT * FROM ${table}`), { code: '42501' });
  }
});
