import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteHistory } from '../src/api/route-history.js';
import { createJsonDataSource, DataSourceUnavailableError } from '../src/store/data-source.js';
import { startApiServer } from '../src/api/server.js';
import { startWorkerServer } from '../src/worker/worker.js';
import { centralFixture } from './central-db-fixtures.js';

const row = (day, overrides = {}) => ({ day, station: 'MOCK', route_name: 'New', dsp_name: 'A',
  pickup_volume: 120, pph: 18.5, first_mile_distance: 12.3, zip_count: 2,
  route_difficulty: '3', postal_codes: ['00123', '94005'], snapshot_id: 'private', ...overrides });

test('RH-T1 changes compare adjacent known values and ZIP sets; output uses safe projection', () => {
  const rows = [row('2026-11-01', { route_name: 'Old' }),
    row('2026-11-02', { postal_codes: ['94005', '00123', '00123'] }),
    row('2026-11-04', { dsp_name: 'B', route_difficulty: '4', postal_codes: ['00001', '00002', '94005'] }),
    row('2026-11-05', { dsp_name: null, route_difficulty: null, postal_codes: null }),
    row('2026-11-06', { postal_codes: [] }), row('2026-11-07')];
  const before = structuredClone(rows);
  const result = buildRouteHistory(rows, { routeId: 1, days: 7, formerNames: ['Old'],
    firstSeen: '2026-10-01', lastSeen: '2026-11-07', latestDay: '2026-11-08' });
  assert.deepEqual(result.changes, [
    { day: '2026-11-04', field: 'route_difficulty', from: '3', to: '4' },
    { day: '2026-11-04', field: 'dsp_name', from: 'A', to: 'B' },
    { day: '2026-11-04', field: 'zip_set', from: null, to: null, added: 2, removed: 1 },
    { day: '2026-11-07', field: 'zip_set', from: null, to: null, added: 2, removed: 0 },
  ]);
  assert.deepEqual(result.former_names, ['Old']);
  assert.equal(result.first_seen, '2026-10-01');
  assert.equal(result.last_seen, '2026-11-07');
  assert.equal(result.latest_day, '2026-11-08');
  assert.ok(!/postal_codes|snapshot_id/.test(JSON.stringify(result)));
  assert.deepEqual(rows, before);
  assert.deepEqual(buildRouteHistory([], { routeId: 9, days: 7 }), {
    available: true, route_id: 9, days: 7, points: [], changes: [], first_seen: null,
    last_seen: null, latest_day: null, former_names: [],
  });
});

async function open(t, options, worker = false) {
  const server = await (worker ? startWorkerServer : startApiServer)({ ...options, port: 0 });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (query, method = 'GET') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/route-history${query}`, { method });
    return { status: res.status, body: await res.json() };
  };
}

test('RH-T1 HTTP validates inputs, Pacific today, unavailable/empty history and sanitized errors', async t => {
  const calls = [];
  let instant = '2026-11-11T00:01:00Z';
  const dataSource = { source: 'db', readRouteHistory: async args => {
    calls.push(args);
    return { rows: args.routeId === 1 ? [row('2026-11-10')] : [], firstSeen: args.routeId === 1 ? '2026-11-10' : null };
  } };
  const get = await open(t, { dataSource, now: () => new Date(instant) });
  for (const [query, days] of [['?route_id=1', 7], ['?route_id=1&days=7', 7], ['?route_id=1&days=30', 30]]) {
    const res = await get(query);
    assert.equal(res.status, 200);
    assert.equal(res.body.days, days);
    assert.equal(res.body.points.length, 1);
    assert.deepEqual(calls.at(-1), { routeId: 1, days, today: '2026-11-10' });
  }
  instant = '2026-11-11T08:01:00Z';
  await get('?route_id=1');
  assert.equal(calls.at(-1).today, '2026-11-11');
  instant = '2026-07-11T06:59:00Z';
  await get('?route_id=1');
  assert.equal(calls.at(-1).today, '2026-07-10');
  for (const query of ['', '?route_id=0', '?route_id=-1', '?route_id=1.5', '?route_id=abc',
    '?route_id=9007199254740992', '?route_id=1&route_id=1'])
    assert.deepEqual(await get(query), { status: 400, body: { error: 'invalid_route_id' } });
  for (const days of ['', '8', '07', '7.0', 'abc', '7&days=7', '7&days=30'])
    assert.deepEqual(await get(`?route_id=1&days=${days}`), { status: 400, body: { error: 'invalid_days' } });
  const empty = await get('?route_id=999');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.points, []);
  assert.equal(empty.body.first_seen, null);
  assert.equal((await get('?route_id=1', 'POST')).status, 405);
  const json = createJsonDataSource({});
  assert.equal(await json.readRouteHistory({ routeId: 1 }), null);
  const unavailable = await open(t, { dataSource: json });
  assert.deepEqual(await unavailable('?route_id=1'), { status: 200, body: { available: false } });
  const failed = await open(t, { dataSource: { ...dataSource, readRouteHistory: async () => { throw new DataSourceUnavailableError(); } } });
  assert.deepEqual(await failed('?route_id=1'), { status: 503, body: { error: 'data_source_unavailable' } });
  const f = await centralFixture(t);
  const worker = await open(t, { ...f, dataSource: createJsonDataSource(f) }, true);
  assert.deepEqual(await worker('?route_id=1&days=30'), { status: 200, body: { available: false } });
});
