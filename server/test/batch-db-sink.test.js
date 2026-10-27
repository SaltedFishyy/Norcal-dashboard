import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbSkip } from './db-helpers.js';
import { connectDb } from '../src/db/connection.js';
import { createDbBatchSink, DbIntegrityError } from '../src/db/batch-db-sink.js';
import { abandonRun } from '../bin/db-abandon-run.js';
import { prepareStationBatchState } from '../src/store/station-batch-file.js';

const at = '2026-10-07T12:00:00.000Z';
const row = (id = 1, station = 'SFO01') => ({ route_id: id, route_name: `MOCK-${id}`, station, postal_codes: ['94005'] });
const detail = profile => ({ ...profile, fetched_at: at, zips: profile.postal_codes.map(postal_code => ({ postal_code, pickup_volume_daily: 10 })) });
const snapshot = rows => ({ fetched_at: at, source: 'mock', source_as_of: null, total: rows.length, rows });
const finalRecord = { status: 'completed', end_time: at, request_count: 0, batch_request_cap: 100, stop_reason: null, original_station_restored: true };
const state = () => prepareStationBatchState(null, ['SFO01'], { at });
function sinkFor(t, db) {
  // createTestDb owns this connection and closes it after dropping the schema.
  const sink = createDbBatchSink({ connect: async () => ({ query: (...args) => db.scraper.query(...args), end: async () => {} }), requestedStations: ['SFO01'] });
  return sink;
}

test('CD-AC14 running uniqueness and guarded abandon command', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), first = sinkFor(t, db), second = sinkFor(t, db);
  await first.startRun(state());
  const existing = (await db.owner.query('SELECT id,started_at FROM scrape_runs')).rows[0];
  await assert.rejects(second.startRun(state()), error => error.message.includes(existing.id)
    && error.message.includes(existing.started_at.toISOString()) && error.message.includes('db:abandon-run'));
  await second.finishRun({ record: finalRecord });
  const invoke = args => abandonRun({ args, connect: () => connectDb('NC_TEST_DB_SCRAPER_URL', { schema: db.schema }), log: () => {}, errorLog: () => {} });
  assert.equal(await invoke([existing.id]), 1);
  assert.equal(await invoke(['bad', '--confirm-no-scrape-running']), 1);
  assert.equal(await invoke([existing.id, '--confirm-no-scrape-running']), 0);
  assert.equal((await db.owner.query('SELECT status,stop_reason FROM scrape_runs')).rows[0].status, 'abandoned');
  await db.owner.query("UPDATE scrape_runs SET status='completed' WHERE id=$1", [existing.id]);
  assert.equal(await invoke([existing.id, '--confirm-no-scrape-running']), 1);
});

test('CD-AC15/16 pending invisibility, atomic activation, hook and SQL rollback', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), sink = sinkFor(t, db), profile = row();
  await sink.startRun(state()); await sink.writeState(state());
  await assert.rejects(sink.writeRouteDetail({ route: detail(profile), beforeCommit: async () => { throw new Error('guard'); } }));
  assert.equal((await db.owner.query('SELECT * FROM route_detail_versions')).rowCount, 0);
  await sink.writeRouteDetail({ route: detail(profile) });
  assert.equal((await db.reader.query('SELECT * FROM v_route_details')).rowCount, 0);
  const activate = overrides => sink.activateStationSnapshot({ station: 'SFO01', stationSnapshot: snapshot([profile]), processedIds: new Set([1]), ...overrides });
  await activate({ beforeCommit: async () => {
    for (const view of ['v_active_snapshots', 'v_active_routes', 'v_route_details', 'v_route_detail_zips'])
      assert.equal((await db.reader.query(`SELECT * FROM ${view}`)).rowCount, 0);
  } });
  const old = (await db.owner.query('SELECT active_snapshot_id FROM stations')).rows[0].active_snapshot_id;
  const linked = (await db.owner.query('SELECT snapshot_id FROM scrape_run_stations')).rows[0].snapshot_id;
  assert.equal(linked, old);
  assert.equal((await db.reader.query('SELECT * FROM v_route_details')).rowCount, 1);
  await assert.rejects(activate({ beforeCommit: async () => { throw new Error('guard'); } }));
});

test('CD-AC16 rejected snapshots retain pointer on hook and SQL failures; successful replacement', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), sink = sinkFor(t, db), profile = row();
  await sink.startRun(state()); await sink.writeRouteDetail({ route: detail(profile) });
  const activate = beforeCommit => sink.activateStationSnapshot({ station: 'SFO01', stationSnapshot: snapshot([profile]), processedIds: new Set([1]), beforeCommit });
  await activate();
  const pointer = async () => (await db.owner.query('SELECT active_snapshot_id FROM stations')).rows[0].active_snapshot_id;
  const old = await pointer();
  await assert.rejects(activate(async () => { throw new Error('guard'); }));
  assert.equal(await pointer(), old);
  assert.equal((await db.owner.query('SELECT status FROM station_snapshots WHERE id=$1', [old])).rows[0].status, 'active');
  assert.equal((await db.owner.query("SELECT * FROM station_snapshots WHERE status='rejected'")).rowCount, 1);
  await assert.rejects(activate(async () => {
    // The sink and hook share this connection: fail inside the actual SQL transaction.
    await db.scraper.query('SELECT * FROM cd_t3_missing_table');
  }), error => error.code === '42P01');
  assert.equal(await pointer(), old);
  assert.equal((await db.owner.query("SELECT * FROM station_snapshots WHERE status='rejected'")).rowCount, 2);
  await db.owner.query("UPDATE scrape_runs SET status='stopped'");
  await assert.rejects(activate(), DbIntegrityError);
  assert.equal(await pointer(), old);
  await db.owner.query("UPDATE scrape_runs SET status='running'");
  await activate();
  assert.notEqual(await pointer(), old);
  assert.equal((await db.owner.query('SELECT status FROM station_snapshots WHERE id=$1', [old])).rows[0].status, 'superseded');
  assert.equal((await db.reader.query('SELECT * FROM v_active_snapshots')).rowCount, 1);
  assert.equal((await db.reader.query('SELECT * FROM v_active_routes')).rowCount, 1);
});

test('CD-AC17 reuse completeRouteDetail, cached/fresh links, limited null and mismatched station rejection', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), sink = sinkFor(t, db);
  await sink.startRun(state());
  const cached = row(1), fresh = row(2), unprocessed = row(3), wrongStation = row(4);
  await sink.writeRouteDetail({ route: detail(cached) });
  await sink.activateStationSnapshot({ station: 'SFO01', stationSnapshot: snapshot([cached]), processedIds: new Set([1]) });
  const cachedId = (await db.owner.query('SELECT id FROM route_detail_versions WHERE route_id=1')).rows[0].id;
  await sink.writeRouteDetail({ route: detail({ ...fresh, postal_codes: ['94006'] }) });
  await sink.writeRouteDetail({ route: detail({ ...wrongStation, station: 'MFR01' }) });
  await sink.activateStationSnapshot({ station: 'SFO01', stationSnapshot: snapshot([cached, { ...fresh, postal_codes: ['94007'] },
    { ...unprocessed, postal_codes: ['94008'] }]), processedIds: new Set([1, 2]), freshIds: new Set([2]) });
  const links = (await db.reader.query('SELECT route_id,detail_version_id FROM v_active_routes ORDER BY ordinal')).rows;
  assert.equal(links[0].detail_version_id, cachedId); assert.ok(links[1].detail_version_id); assert.equal(links[2].detail_version_id, null);
  assert.equal((await db.owner.query('SELECT * FROM route_detail_versions WHERE route_id=1')).rowCount, 1);
  assert.equal((await db.owner.query('SELECT status FROM route_detail_versions WHERE route_id=2')).rows[0].status, 'committed');
  const old = (await db.owner.query('SELECT active_snapshot_id FROM stations')).rows[0].active_snapshot_id;
  await assert.rejects(sink.activateStationSnapshot({ station: 'SFO01', stationSnapshot: snapshot([wrongStation]), processedIds: new Set([4]) }), DbIntegrityError);
  assert.equal((await db.owner.query('SELECT active_snapshot_id FROM stations')).rows[0].active_snapshot_id, old);
  assert.equal((await db.owner.query('SELECT count(*) FROM station_snapshots')).rows[0].count, '2');
});
