import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { startApiServer } from '../src/api/server.js';
import { createJsonDataSource, DataSourceUnavailableError } from '../src/store/data-source.js';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { centralFixture } from './central-db-fixtures.js';
import { createTestDb, dbSkip } from './db-helpers.js';
import { importJson } from '../src/db/json-import.js';

async function open(t, f, dataSource) {
  const server = await startApiServer({ ...f, dataSource, port: 0 });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (pathname, method = 'GET') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method });
    return { status: res.status, body: await res.json() };
  };
}
const allowedKeys = new Set(['runs', 'source', 'id', 'trigger', 'status', 'started_at', 'finished_at', 'scope',
  'type', 'district', 'skipped', 'code', 'reason', 'counts', 'completed', 'limited', 'stopped', 'pending', 'stop_reason', 'prod_api_requests']);
function scan(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) scan(item); return; }
  for (const [key, child] of Object.entries(value)) { assert.ok(allowedKeys.has(key), key); scan(child); }
}

test('CD-AC25/30 JSON capabilities, refresh absence, full station freshness, limits and 503', async t => {
  const f = await centralFixture(t);
  await fs.writeFile(f.districtsPath, JSON.stringify({ schema_version: 1, districts: [
    { id: 'mock', name_zh: '模拟', name_en: 'Mock', stations: ['AAA01', 'BBB01'], scrape_disabled: { BBB01: 'disabled' } },
    { id: 'empty', name_zh: '空', name_en: 'Empty', stations: ['CCC01'] },
  ] }));
  const get = await open(t, f, createJsonDataSource(f));
  assert.deepEqual((await get('/api/capabilities')).body, { refresh: false, warehouse_write: false, route_quotation: false });
  for (const [pathname, method] of [['/api/refresh', 'POST'], ['/api/refresh/status', 'GET'], ['/api/refresh/preview', 'GET']])
    assert.equal((await get(pathname, method)).status, 404);
  const result = (await get('/api/freshness')).body;
  assert.equal(result.source, 'json'); assert.equal(result.run, null); assert.equal(result.notice, '数据来自 DMS 抓取，非实时');
  assert.deepEqual(result.stations.find(s => s.code === 'BBB01'), { code: 'BBB01', district: 'mock', fetched_at: null, scrape_disabled: 'disabled' });
  assert.equal(result.stations.find(s => s.code === 'ZZZ01').district, 'unassigned');
  assert.equal(result.districts[0].station_count, 2); assert.equal(result.districts[0].stations_with_data, 1);
  assert.equal(result.districts[1].oldest_fetched_at, null);
  assert.equal(result.global.newest_fetched_at, f.profiles.stations.AAA01.fetched_at);
  assert.deepEqual((await get('/api/runs')).body, { runs: [], source: 'json' });
  for (const value of ['', '0', '51', '-1', 'abc', '1.2', '1&limit=2', '1e1'])
    assert.equal((await get('/api/runs?limit=' + value)).status, 400);
  for (const value of ['1', '20', '50']) assert.equal((await get('/api/runs?limit=' + value)).status, 200);
  const unavailable = { source: 'db', readRouteProfiles: async () => { throw new DataSourceUnavailableError(); },
    readRuns: async () => { throw new DataSourceUnavailableError(); } };
  const fail = await open(t, f, unavailable);
  for (const pathname of ['/api/freshness', '/api/runs'])
    assert.deepEqual(await fail(pathname), { status: 503, body: { error: 'data_source_unavailable' } });
});

test('CD-AC30 recursive run whitelist excludes nested view metadata', async t => {
  const f = await centralFixture(t);
  const run = { id: 1, trigger: 'ui', status: 'completed', started_at: '2026-10-08T00:00:00Z', finished_at: null,
    scope: { type: 'district', district: 'mock', options: { url: 'https://hidden.invalid' },
      skipped: [{ code: 'BBB01', district: 'mock', reason: 'disabled', hostname: 'hidden.invalid' }] },
    counts: { completed: 1, in_progress: 0, url: 'https://hidden.invalid' }, prod_api_requests: 5,
    json_run_id: 'hidden', app_version: 'hidden', import_digest: 'hidden', requested_stations: [],
    options: {}, original_station_restored: true, stop_reason: 'https://hidden.invalid' };
  const get = await open(t, f, { ...createJsonDataSource(f), source: 'db', readRuns: async () => [run] });
  const body = (await get('/api/runs')).body;
  scan(body); assert.doesNotMatch(JSON.stringify(body), /hidden|https?:|hostname|json_run_id|app_version|import_digest|requested_stations|options|original_station_restored/);
});

test('CD-AC30 real DB run ordering, limits, cli/ui freshness and whitelist', async t => {
  assert.equal(dbSkip, false, 'Test DB configuration is required; this test must not skip');
  const db = await createTestDb(t), f = await centralFixture(t);
  await importJson({ ...f, client: db.scraper });
  const source = createDbDataSource({ schema: db.schema, env: { NC_DB_READER_URL: process.env.NC_TEST_DB_READER_URL } });
  t.after(() => source.close());
  const get = await open(t, f, source);
  assert.equal((await get('/api/freshness')).body.run.last, null);
  await db.scraper.query(`INSERT INTO scrape_runs (id,trigger,status,requested_stations,options,started_at,scope,stop_reason)
    VALUES ('00000000-0000-4000-8000-000000000001','cli','stopped','{}','{}',now() + interval '1 day',
      '{"type":"all","skipped":[{"code":"BBB01","district":"mock","reason":"disabled"}]}', 'capture:NeedsLoginError')`);
  let result = (await get('/api/freshness')).body;
  assert.equal(result.run.running, false); assert.equal(result.run.last.needs_login, true);
  assert.equal(result.source, 'db'); assert.equal(result.stations.length, 2);
  assert.equal(result.global.newest_fetched_at, f.profiles.stations.AAA01.fetched_at);
  await db.scraper.query(`INSERT INTO scrape_runs (id,trigger,status,requested_stations,options,started_at)
    VALUES ('00000000-0000-4000-8000-000000000002','ui','running','{}','{}',now() + interval '2 days')`);
  result = (await get('/api/freshness')).body;
  assert.equal(result.run.running, true); assert.equal(result.run.last.trigger, 'ui');
  const runs = (await get('/api/runs?limit=2')).body;
  assert.equal(runs.runs.length, 2); assert.equal(runs.runs[0].trigger, 'ui'); scan(runs);
  assert.doesNotMatch(JSON.stringify(runs), /https?:|localhost|127\.0\.0\.1|json_run_id|app_version|import_digest|requested_stations|options|original_station_restored/);
  assert.equal((await source.readRuns({ limit: 1 })).length, 1);
  assert.equal((await source.readLastScrapeRun()).trigger, 'ui');
});
