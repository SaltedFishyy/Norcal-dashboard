import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbSkip } from './db-helpers.js';
import { connectDb } from '../src/db/connection.js';
import { createDbBatchSink } from '../src/db/batch-db-sink.js';
import { createDualBatchSink, DbStoreError } from '../src/batch/dual-batch-sink.js';
import { batchFixture } from './multi-station-fixtures.js';

test('dual sink preserves JSON results, action order and fixed safe errors including finish', async () => {
  for (const action of ['startRun', 'writeState', 'writeStationSummary', 'writeRouteDetail', 'activateStationSnapshot', 'finishRun']) {
    const calls = [], cause = new Error('driver-sensitive-content');
    const sink = createDualBatchSink({ [action]: async value => { calls.push(['json', value]); return 'json-result'; } },
      { [action]: async value => { calls.push(['db', value]); } });
    assert.equal(await sink[action](1), 'json-result'); assert.deepEqual(calls, [['json', 1], ['db', 1]]);
    const failure = createDualBatchSink({ [action]: async () => {} }, { [action]: async () => { throw cause; } });
    await assert.rejects(failure[action](), error => error instanceof DbStoreError && error.cause === cause
      && !error.message.includes(cause.message));
  }
});

test('CD-AC18 dual batch missing/invalid configuration makes zero DMS requests', async () => {
  for (const value of [undefined, 'invalid']) {
    const h = batchFixture();
    assert.equal(await h.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', DB_DUAL_WRITE: '1', NC_DB_SCRAPER_URL: value } }), 1);
    assert.equal(h.pageHarness.requests, 0);
    assert.match(h.files.at(-1).record.stop_reason, /:DbStoreError$/);
  }
});

test('CD-AC18 synthetic multi-station dual success writes JSON and DB', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), h = batchFixture();
  assert.equal(await h.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', DB_DUAL_WRITE: '1' },
    dbSinkFactory: metadata => createDbBatchSink({ ...metadata, connect: () => connectDb('NC_TEST_DB_SCRAPER_URL', { schema: db.schema }) }) }), 0);
  assert.deepEqual(h.saves, ['SFO01', 'MFR01']); assert.equal(Object.keys(h.details).length, 2);
  assert.equal((await db.reader.query('SELECT * FROM v_active_snapshots')).rowCount, 2);
  assert.equal((await db.owner.query('SELECT status FROM scrape_runs')).rows[0].status, 'completed');
  assert.equal((await db.owner.query('SELECT * FROM scrape_run_stations WHERE snapshot_id IS NOT NULL')).rowCount, 2);
});

for (const action of ['startRun', 'writeRouteDetail', 'activateStationSnapshot', 'writeState', 'writeStationSummary', 'finishRun']) {
  test(`CD-AC18 ${action} DB failure stops without leaking cause`, { skip: dbSkip }, async t => {
    const db = await createTestDb(t), h = batchFixture(), diagnostics = [];
    let oldPointer = null;
    if (['writeRouteDetail', 'activateStationSnapshot'].includes(action)) {
      const prior = createDbBatchSink({ connect: () => connectDb('NC_TEST_DB_SCRAPER_URL', { schema: db.schema }), requestedStations: ['SFO01'] });
      await prior.startRun({ run_id: 'mock-prior', started_at: '2026-10-07T00:00:00Z' });
      await prior.activateStationSnapshot({ station: 'SFO01', stationSnapshot: {
        fetched_at: '2026-10-07T00:00:00Z', source: 'mock', total: 0, rows: [],
      } });
      await prior.finishRun({ record: { status: 'completed', end_time: '2026-10-07T00:00:00Z', request_count: 0, batch_request_cap: 0 } });
      oldPointer = (await db.owner.query("SELECT active_snapshot_id FROM stations WHERE code='SFO01'")).rows[0].active_snapshot_id;
    }
    const result = await h.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', DB_DUAL_WRITE: '1' },
      diagnosticFileOps: { mkdir: async () => {}, rename: async () => {}, rm: async () => {}, writeFile: async (_, data) => diagnostics.push(data) },
      dbSinkFactory: metadata => {
        const sink = createDbBatchSink({ ...metadata, connect: () => connectDb('NC_TEST_DB_SCRAPER_URL', { schema: db.schema }) });
        const original = sink[action]; let failed = false;
        sink[action] = async (...args) => {
          if (!failed) {
            failed = true;
            if (action === 'finishRun') await original(...args);
            throw new Error('driver-sensitive-content');
          }
          return original(...args);
        };
        return sink;
      } });
    assert.equal(result, 1); assert.match(h.files.at(-1).record.stop_reason, /:DbStoreError$/);
    assert.doesNotMatch([...h.logs, ...diagnostics].join('\n'), /driver-sensitive-content/);
    if (action === 'startRun') { assert.equal(h.pageHarness.requests, 0); assert.equal((await db.owner.query('SELECT * FROM scrape_runs')).rowCount, 0); }
    if (['startRun', 'writeRouteDetail', 'activateStationSnapshot', 'writeState'].includes(action))
      assert.equal((await db.reader.query('SELECT * FROM v_active_snapshots')).rowCount, oldPointer ? 1 : 0);
    if (oldPointer) assert.equal((await db.owner.query("SELECT active_snapshot_id FROM stations WHERE code='SFO01'")).rows[0].active_snapshot_id, oldPointer);
    if (['writeStationSummary', 'finishRun'].includes(action)) assert.ok((await db.reader.query('SELECT * FROM v_active_snapshots')).rowCount > 0);
  });
}

test('CD-AC18 later Station activation failure preserves earlier committed Station', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), h = batchFixture();
  assert.equal(await h.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', DB_DUAL_WRITE: '1' },
    dbSinkFactory: metadata => {
      const sink = createDbBatchSink({ ...metadata, connect: () => connectDb('NC_TEST_DB_SCRAPER_URL', { schema: db.schema }) });
      const activate = sink.activateStationSnapshot;
      sink.activateStationSnapshot = params => activate({ ...params, beforeCommit: async () => {
        if (params.station === 'MFR01') throw new Error('mock activation failure');
        await params.beforeCommit();
      } });
      return sink;
    } }), 1);
  assert.deepEqual((await db.reader.query('SELECT station_code FROM v_active_snapshots')).rows, [{ station_code: 'SFO01' }]);
  assert.equal((await db.owner.query("SELECT status FROM station_snapshots WHERE station_code='MFR01'")).rows[0].status, 'rejected');
  assert.equal((await db.owner.query('SELECT status FROM scrape_runs')).rows[0].status, 'stopped');
  assert.match(h.files.at(-1).record.stop_reason, /:DbStoreError$/);
});
