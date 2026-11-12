import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbSkip } from './db-helpers.js';
import { centralFixture } from './central-db-fixtures.js';
import { importJson } from '../src/db/json-import.js';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { createJsonDataSource, DataSourceUnavailableError } from '../src/store/data-source.js';
import { SnapshotNotFoundError, StationNotFoundError } from '../src/store/route-profiles-file.js';
import { RouteDetailNotFoundError } from '../src/store/route-details-file.js';
import { createDbBatchSink } from '../src/db/batch-db-sink.js';
import { prepareStationBatchState } from '../src/store/station-batch-file.js';
import { startApiServer } from '../src/api/server.js';
import { runServer } from '../bin/server.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

test('readLastScrapeRun includes schedule and excludes newer JSON imports', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), source = testSource(t, db);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, trigger] of ['ui', 'schedule', 'json_import'].entries()) {
    await db.scraper.query(`INSERT INTO scrape_runs (id,trigger,status,requested_stations,options,started_at)
      VALUES ($1,$2,'completed',ARRAY['AAA01'],'{}',$3)`, [ids[index], trigger, new Date(Date.UTC(2026, 0, index + 1))]);
  }
  const last = await source.readLastScrapeRun();
  assert.equal(last.id, ids[1]);
  assert.equal(last.trigger, 'schedule');
});

export function testSource(t, db) {
  const source = createDbDataSource({ schema: db.schema, env: { NC_DB_READER_URL: process.env.NC_TEST_DB_READER_URL } });
  t.after(() => source.close()); return source;
}

test('AR-T3 readScheduleRuns reads recent schedules and completed recovery runs through reader view', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), source = testSource(t, db);
  const rows = [
    ['schedule', 'stopped', '2026-11-10T01:00:00Z'],
    ['schedule', 'stopped', '2026-11-12T01:00:00Z'],
    ['ui', 'completed', '2026-11-12T02:00:00Z'],
    ['ui', 'stopped', '2026-11-12T03:00:00Z'],
    ['cli', 'completed', '2026-11-12T04:00:00Z'],
  ];
  const ids = [];
  for (const [trigger, status, started_at] of rows) {
    const id = randomUUID(); ids.push(id);
    await db.scraper.query(`INSERT INTO scrape_runs (id,trigger,status,requested_stations,options,started_at,scope,stop_reason)
      VALUES ($1,$2,$3,'{}','{}',$4,$5,$6)`, [id, trigger, status, started_at,
      { type: 'district', district: 'mock' }, status === 'stopped' ? 'list:SelectorError' : null]);
  }
  const result = await source.readScheduleRuns({ since: new Date('2026-11-11T00:00:00Z') });
  assert.deepEqual(result.map(r => r.id), [ids[4], ids[2], ids[1]]);
  assert.deepEqual(result[2].scope, { type: 'district', district: 'mock' });
  assert.equal(result[2].stop_reason, 'list:SelectorError');
});

test('DB data source missing semantics and shared detail projection', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), source = testSource(t, db), fixture = await centralFixture(t);
  await assert.rejects(source.readRouteProfiles(), SnapshotNotFoundError);
  await assert.rejects(source.getStationSnapshot('AAA01'), SnapshotNotFoundError);
  await assert.rejects(source.getRouteDetail(1), RouteDetailNotFoundError);
  assert.deepEqual(await source.readRouteDetailsForMap(), { status: 'none', routes: {} });
  await importJson({ ...fixture, client: db.scraper });
  await assert.rejects(source.getStationSnapshot('BBB01'), StationNotFoundError);
  const json = createJsonDataSource(fixture);
  for (const id of [1, 831]) assert.deepEqual(await source.getRouteDetail(id), await json.getRouteDetail(id));
  const expected = structuredClone(fixture.profiles);
  for (const snapshot of Object.values(expected.stations)) for (const row of snapshot.rows) delete row.raw;
  assert.deepEqual(await source.readRouteProfiles(), expected);
});

test('CD-AC15 DB source excludes pending and rejected snapshots and pending detail versions', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), source = testSource(t, db), fixture = await centralFixture(t);
  await importJson({ ...fixture, client: db.scraper });
  const previousProfiles = await source.readRouteProfiles(), previousDetails = await source.readRouteDetailsForMap();
  const sink = createDbBatchSink({ connect: async () => ({ query: (...args) => db.scraper.query(...args), end: async () => {} }), requestedStations: ['AAA01'] });
  await sink.startRun(prepareStationBatchState(null, ['AAA01'], {}));
  await sink.writeRouteDetail({ route: { ...fixture.routes.routes['1'], route_name: 'MOCK-PENDING' } });
  await sink.writeRouteDetail({ route: { ...fixture.routes.routes['1'], route_id: 999, route_name: 'MOCK-NEW-PENDING' } });
  const verify = async () => {
    assert.deepEqual(await source.readRouteProfiles(), previousProfiles);
    assert.deepEqual(await source.readRouteDetailsForMap(), previousDetails);
    await assert.rejects(source.getRouteDetail(999), RouteDetailNotFoundError);
  };
  await verify();
  await assert.rejects(sink.activateStationSnapshot({ station: 'AAA01', stationSnapshot: fixture.profiles.stations.AAA01,
    beforeCommit: async () => {
      // Pending snapshot was committed separately; the activation changes are uncommitted.
      assert.equal((await db.owner.query("SELECT * FROM station_snapshots WHERE status='pending'")).rowCount, 1);
      await verify(); throw new Error('mock guard');
    } }), /mock guard/);
  assert.equal((await db.owner.query("SELECT * FROM station_snapshots WHERE status='rejected'")).rowCount, 1);
  await verify();
  await sink.finishRun({ record: { status: 'stopped', end_time: new Date().toISOString() } });
});

test('unavailable DB produces sanitized errors and HTTP 503 on every data endpoint', async t => {
  // A closed local port uses only a synthetic, invalid identity; never production configuration.
  const source = createDbDataSource({ env: { NC_DB_READER_URL: 'postgresql://mock@127.0.0.1:1/mock' } });
  t.after(() => source.close());
  await assert.rejects(source.readRouteProfiles(), error => error instanceof DataSourceUnavailableError && !/mock|ECONN/.test(error.message));
  const fixture = await centralFixture(t), server = await startApiServer({ ...fixture, dataSource: source, port: 0 });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const pathname of ['/api/route-profiles?station=AAA01', '/api/route-details?route_id=1', '/api/route-map?station=AAA01',
    '/api/route-map/stations', '/api/districts', '/api/route-map/district?district=mock', '/api/route-map/zip?postal_code=00002']) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    assert.equal(res.status, 503); assert.deepEqual(await res.json(), { error: 'data_source_unavailable' });
  }
});

test('DATA_SOURCE invalid or missing DB configuration fails before startup without exposing values', async () => {
  for (const env of [{ DATA_SOURCE: 'private-invalid-value' }, { DATA_SOURCE: 'db' },
    { DATA_SOURCE: 'db', NC_DB_READER_URL: 'private-invalid-value' }]) {
    const logs = []; let started = false;
    assert.equal(await runServer({ env, errorLog: message => logs.push(message), start: async () => { started = true; } }), 1);
    assert.equal(started, false); assert.doesNotMatch(logs.join(''), /private-invalid-value/);
  }
});

test('server command exits 1 on invalid DATA_SOURCE and DB URL; default JSON logs source', async t => {
  const entry = fileURLToPath(new URL('../bin/server.js', import.meta.url));
  for (const values of [{ DATA_SOURCE: 'bad-secret' }, { DATA_SOURCE: 'db', NC_DB_READER_URL: '' },
    { DATA_SOURCE: 'db', NC_DB_READER_URL: 'bad-secret' }]) {
    const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ...values } });
    assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /bad-secret/);
    assert.match(result.stderr, /DATA_SOURCE|NC_DB_READER_URL/);
  }
  const fixture = await centralFixture(t), logs = [];
  assert.equal(await runServer({ env: { RUNTIME_DATA_DIR: fixture.runtimeDir }, log: value => logs.push(value), start: async () => {} }), 0);
  assert.ok(logs.includes('Data source: json'));
});
