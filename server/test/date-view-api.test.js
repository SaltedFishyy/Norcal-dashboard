import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { centralFixture } from './central-db-fixtures.js';
import { createJsonDataSource, DataSourceUnavailableError } from '../src/store/data-source.js';
import { startApiServer } from '../src/api/server.js';
import { startWorkerServer } from '../src/worker/worker.js';

export async function openDateApi(t, options, worker = false) {
  const server = await (worker ? startWorkerServer : startApiServer)({ port: 0,
    now: () => new Date('2026-11-12T00:01Z'), ...options });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (path, method = 'GET') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
    return { status: res.status, body: await res.json() };
  };
}

const paths = ['/api/route-profiles?station=AAA01', '/api/route-details?route_id=1',
  '/api/route-map?station=AAA01', '/api/route-map/zip?postal_code=00123',
  '/api/route-map/stations?', '/api/districts?', '/api/route-map/district?district=mock'];

test('DV-T2 shared date validation, Pacific midnight, JSON history unavailable on all seven endpoints', async t => {
  const f = await centralFixture(t), json = createJsonDataSource(f);
  const get = await openDateApi(t, { ...f, dataSource: json });
  for (const path of paths) {
    for (const day of ['', 'bad', '0000-01-01', '2026-2-01', '2026-02-30', '2026-11-12', '2026-11-10&date=2026-11-11']) {
      assert.deepEqual(await get(`${path}&date=${day}`), { status: 400, body: { error: 'invalid_date' } });
    }
    assert.deepEqual(await get(`${path}&date=2026-11-11`), { status: 400, body: { error: 'history_unavailable' } });
    assert.deepEqual(await get(`${path}&date=2024-02-29`), { status: 400, body: { error: 'history_unavailable' } });
  }
  assert.equal(await json.readSnapshotDays({ stations: [] }), null);
  assert.deepEqual(await get('/api/snapshot-days?station=AAA01'), { status: 200, body: { available: false } });
});

test('DV-AC2 seven default HTTP responses are identical and never call atDay', async t => {
  const f = await centralFixture(t), json = createJsonDataSource(f);
  const baseline = await openDateApi(t, { ...f, dataSource: json });
  let calls = 0;
  const get = await openDateApi(t, { ...f, dataSource: { ...json, atDay: () => { calls++; throw new Error(); } } });
  for (const path of paths) {
    const expected = await baseline(path);
    assert.equal(expected.status, 200);
    assert.deepEqual(await get(path), expected);
  }
  assert.equal(calls, 0);
});

test('DV-T2 selects daily source for every builder, empty profiles and district membership', async t => {
  const f = await centralFixture(t), json = createJsonDataSource(f), selected = [];
  const get = await openDateApi(t, { ...f, dataSource: { ...json, source: 'db',
    readCurrentFirstPrices: async () => [{ route_id: 1, postal_code: '00123', price: 1.25 }],
    atDay: day => {
    selected.push(day);
    return day === '2026-11-10' ? { ...json,
      readRouteProfiles: async () => ({ schema_version: 1, stations: {} }),
      getStationSnapshot: async () => ({ fetched_at: null, source_as_of: null, total: 0, rows: [], empty: true }),
    } : json;
  } } });
  for (const path of paths) assert.equal((await get(`${path}&date=2026-11-11`)).status, 200);
  assert.deepEqual(selected, paths.map(() => '2026-11-11'));
  const priced = await get('/api/route-profiles?station=AAA01&date=2026-11-11');
  assert.equal(priced.body.rows.find(row => row.route_id === 1).current_first_0_1lb_price, 1.25);
  assert.deepEqual(await get('/api/route-profiles?station=AAA01&date=2026-11-10'), { status: 200,
    body: { station: 'AAA01', fetched_at: null, source_as_of: null, total: 0, rows: [], empty: true } });
  const districts = await get('/api/districts?date=2026-11-10');
  assert.equal(districts.body.districts[0].stations[0].has_snapshot, false);
});

test('DV-AC5 snapshot calendar has continuous descending days, filtered stations and read-only worker route', async t => {
  const f = await centralFixture(t), json = createJsonDataSource(f);
  const config = JSON.parse(await readFile(f.districtsPath, 'utf8'));
  config.districts[0].stations.push('ZZZ01');
  await writeFile(f.districtsPath, JSON.stringify(config));
  const calls = [];
  const source = { ...json, source: 'db', readSnapshotDays: async ({ stations }) => {
    calls.push(stations);
    return stations.includes('AAA01') ? [{ day: '2026-11-09', stations: ['AAA01'] },
      { day: '2026-11-11', stations: ['AAA01'] }] : [];
  } };
  const get = await openDateApi(t, { ...f, dataSource: source });
  const expected = { status: 200, body: { days: [
    { day: '2026-11-11', has_data: true, stations_with_data: ['AAA01'] },
    { day: '2026-11-10', has_data: false, stations_with_data: [] },
    { day: '2026-11-09', has_data: true, stations_with_data: ['AAA01'] },
  ] } };
  assert.deepEqual(await get('/api/snapshot-days?station=AAA01'), expected);
  assert.deepEqual(await get('/api/snapshot-days?district=mock'), expected);
  assert.deepEqual(calls, [['AAA01'], ['AAA01', 'ZZZ01']]);
  assert.deepEqual(await get('/api/snapshot-days?station=ZZZ01'), { status: 200, body: { days: [] } });
  assert.equal((await get('/api/snapshot-days?district=missing')).status, 404);
  for (const query of ['', '?station=', '?station=A&station=B', '?station=A&district=mock',
    '?district=mock&district=mock', '?district=INVALID']) {
    assert.equal((await get(`/api/snapshot-days${query}`)).status, 400);
  }
  const worker = await openDateApi(t, { ...f, dataSource: source }, true);
  assert.deepEqual(await worker('/api/snapshot-days?district=mock'), expected);
  assert.equal((await worker('/api/snapshot-days?station=AAA01', 'POST')).status, 405);
  const failed = await openDateApi(t, { ...f, dataSource: { ...source,
    readSnapshotDays: async () => { throw new DataSourceUnavailableError(); } } });
  assert.deepEqual(await failed('/api/snapshot-days?station=AAA01'), { status: 503,
    body: { error: 'data_source_unavailable' } });
});
