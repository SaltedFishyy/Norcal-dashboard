import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPriceIndex, zipFirstPrice, routePriceSummary, buildRouteQuotation, quotationFields } from '../src/quotations/quotations.js';
import { centralFixture } from './central-db-fixtures.js';
import { createJsonDataSource } from '../src/store/data-source.js';
import { startApiServer } from '../src/api/server.js';
import { startWorkerServer } from '../src/worker/worker.js';
import { compareDataSources } from '../src/db/parity.js';
import { createTestDb, dbSkip } from './db-helpers.js';
import { importJson } from '../src/db/json-import.js';
import { createDbDataSource } from '../src/db/db-data-source.js';

const bands = ['0_1', '1_5', '5_10', '10_20', '20_30', '30_40', '40_plus'];
const weightBands = bands.map((code, ordinal) => ({ code, ordinal, label_zh: code, label_en: code }));
const route = { route_id: 1, route_name: 'Mock', postal_codes: ['00123', '00002', '00004'] };
const line = (zip, overrides = {}) => ({ postal_code: zip, effective_from: '2026-01-01', end_date: null,
  fleet_name: 'Mock', remarks: null, quotation_date: null, imported_at: '2026-01-01T00:00:00Z',
  first_prices: Object.fromEntries(bands.map(code => [code, 1.75])),
  additional_prices: Object.fromEntries(bands.map(code => [code, 0.25])), ...overrides });
const allNull = row => { for (const field of quotationFields) assert.equal(row[field], null, field); };

test('RQ-T2 summary distinguishes unavailable, empty, partial, uniform, range and moved ZIP', () => {
  allNull(routePriceSummary(null, route));
  allNull(routePriceSummary(buildPriceIndex([]), {}));
  for (const [prices, expected] of [[[], [null, null, null, 0, 3]], [[1.75], [1.75, 1.75, 1.75, 1, 2]],
    [[1.75, 1.75, 1.75], [1.75, 1.75, 1.75, 3, 0]], [[1.75, 1.95], [null, 1.75, 1.95, 2, 1]]]) {
    const index = buildPriceIndex(prices.map((price, i) => ({ route_id: 1, postal_code: route.postal_codes[i], price })));
    assert.deepEqual(Object.values(routePriceSummary(index, route)), expected);
    assert.equal(zipFirstPrice(index, 2, '00123'), null);
  }
});

test('RQ-T2 detail groups all fourteen prices and metadata, sorts, and separates extra/unquoted/upcoming freshness', () => {
  const build = (current, upcoming = []) => buildRouteQuotation({ route, station: 'MOCK', current, upcoming, weightBands });
  const extra = line('99999', { imported_at: '2026-02-01T00:00:00Z' });
  const future = [{ postal_code: '00004', effective_from: '2027-01-01', imported_at: '2028-01-01T00:00:00Z' }];
  const result = build([line('00123'), line('00002'), extra], future);
  assert.deepEqual(result.groups[0].postal_codes, ['00002', '00123']);
  assert.deepEqual(result.groups[0].first, line('').first_prices);
  assert.deepEqual(result.groups[0].additional, line('').additional_prices);
  assert.deepEqual(result.unquoted_postal_codes, ['00004']);
  assert.deepEqual(result.extra_quoted_postal_codes, ['99999']);
  assert.deepEqual(result.upcoming, [{ postal_codes: ['00004'], effective_from: '2027-01-01' }]);
  assert.equal(result.updated_at, '2026-02-01T00:00:00.000Z');
  assert.equal(build([], future).updated_at, null);
  assert.equal(build([line('00123')], future).updated_at, '2026-01-01T00:00:00.000Z');
  for (const field of ['fleet_name', 'remarks', 'quotation_date', 'effective_from', 'end_date'])
    assert.equal(build([line('00123'), line('00002', { [field]: 'different' })]).groups.length, 2);
  for (const kind of ['first_prices', 'additional_prices']) for (const band of bands)
    assert.equal(build([line('00123'), line('00002', { [kind]: { ...line('')[kind], [band]: 9 } })]).groups.length, 2);
});

async function open(t, fixture, dataSource, worker = false) {
  const server = await (worker ? startWorkerServer : startApiServer)({ ...fixture, dataSource, port: 0 });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async path => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  };
}
const endpoints = ['/api/route-profiles?station=AAA01', '/api/route-map?station=AAA01',
  '/api/route-map/district?district=mock', '/api/route-map/zip?postal_code=00123', '/api/route-map/zip?postal_code=00002'];
function checkUnavailable(path, body) {
  if (path.includes('route-profiles')) body.rows.forEach(allNull);
  else if (body.routes) {
    body.routes.forEach(allNull);
    body.features.features.forEach(feature => assert.equal(feature.properties.current_first_0_1lb_price, null));
  } else if (body.owners) body.owners.forEach(owner => assert.equal(owner.current_first_0_1lb_price, null));
  else { allNull(body.route); assert.equal(body.current_first_0_1lb_price, null); }
}

test('RQ-T2 HTTP merge, JSON/failure degradation, errors and both server capabilities', async t => {
  const f = await centralFixture(t), json = createJsonDataSource(f);
  const priced = { ...json, source: 'db', readCurrentFirstPrices: async () => [
    { route_id: 1, postal_code: '00123', price: 1.75 }, { route_id: 3, postal_code: '00002', price: 2 }],
    readRouteQuotation: async () => ({ current: [line('00123')], upcoming: [], weightBands }) };
  const get = await open(t, f, priced);
  for (const path of endpoints) {
    const { status, body } = await get(path); assert.equal(status, 200);
    if (body.rows) assert.equal(body.rows.find(row => row.route_id === 1).current_first_0_1lb_price, 1.75);
    if (body.routes) {
      assert.equal(body.routes.find(row => row.route_id === 1).quoted_zip_count, 1);
      assert.equal(body.features.features.find(feature => feature.properties.postal_code === '00123').properties.current_first_0_1lb_price, 1.75);
    }
    if (body.route) assert.equal(body.route.quoted_zip_count, 1);
    if (body.owners) assert.deepEqual(body.owners.map(owner => owner.current_first_0_1lb_price), [null, 2]);
  }
  assert.equal((await get('/api/route-quotations?route_id=1')).body.groups.length, 1);
  for (const query of ['', '?route_id=0', '?route_id=-1', '?route_id=1.2', '?route_id=9007199254740992', '?route_id=1&route_id=2'])
    assert.deepEqual(await get('/api/route-quotations' + query), { status: 400, body: { error: 'invalid_route_id' } });
  assert.deepEqual(await get('/api/route-quotations?route_id=831'), { status: 404, body: { error: 'route_not_found' } });
  for (const source of [json, { ...priced, readCurrentFirstPrices: async () => { throw Error('private'); },
    readRouteQuotation: async () => { throw Error('private'); } }]) {
    const request = await open(t, f, source);
    for (const path of endpoints) { const res = await request(path); assert.equal(res.status, 200); checkUnavailable(path, res.body); }
    assert.deepEqual(await request('/api/route-quotations?route_id=1'), { status: 503, body: { error: 'data_source_unavailable' } });
  }
  const empty = await open(t, f, { ...priced, readCurrentFirstPrices: async () => [],
    readRouteQuotation: async () => ({ current: [], upcoming: [], weightBands }) });
  const noQuotes = (await empty('/api/route-quotations?route_id=1')).body;
  assert.deepEqual(noQuotes.groups, []); assert.deepEqual(noQuotes.unquoted_postal_codes, ['00002', '00123']);
  assert.equal(noQuotes.updated_at, null);
  assert.equal((await empty(endpoints[0])).body.rows.find(row => row.route_id === 1).unquoted_zip_count, 2);
  for (const worker of [false, true]) for (const source of [json, priced])
    assert.equal((await (await open(t, f, source, worker))('/api/capabilities')).body.route_quotation, source.source === 'db');
  const brokenDms = await open(t, f, { ...priced, getStationSnapshot: async () => { throw Error('private'); } });
  assert.equal((await brokenDms(endpoints[0])).status, 500);
});

test('RQ-T2 parity ignores only quotation fields and still detects DMS changes', async t => {
  const f = await centralFixture(t), jsonSource = createJsonDataSource(f);
  const dbSource = { ...jsonSource, source: 'db', readCurrentFirstPrices: async () => [{ route_id: 1, postal_code: '00123', price: 9 }] };
  assert.equal((await compareDataSources({ ...f, jsonSource, dbSource })).exitCode, 0);
  dbSource.getStationSnapshot = async station => ({ ...await jsonSource.getStationSnapshot(station), fetched_at: 'different' });
  assert.equal((await compareDataSources({ ...f, jsonSource, dbSource })).exitCode, 1);
});

test('RQ-T2 test DB reader normalizes types, separates quotation failure from DMS, and HTTP parity', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), f = await centralFixture(t);
  await importJson({ ...f, client: db.scraper });
  const source = createDbDataSource({ schema: db.schema, env: { NC_DB_READER_URL: process.env.NC_TEST_DB_READER_URL } });
  t.after(() => source.close());
  await db.owner.query("INSERT INTO known_stations(code) VALUES ('AAA01') ON CONFLICT DO NOTHING");
  const imported = (await db.owner.query(`INSERT INTO route_quotation_imports
    (source,status,row_count,accepted_count,duplicate_count,rejected_count,quotation_date,imported_at)
    VALUES ('manual_file','completed',1,1,0,0,'2026-01-01','2026-01-02T03:04:05Z') RETURNING id`)).rows[0].id;
  const insert = async future => (await db.owner.query(`INSERT INTO route_quotation_lines
    (import_id,station_code,route_id,route_name,postal_code,effective_from,end_date)
    VALUES ($1,'AAA01',1,'Mock',$2,(now() AT TIME ZONE 'America/Los_Angeles')::date+$3::int,
    (now() AT TIME ZONE 'America/Los_Angeles')::date+30) RETURNING id`, [imported, future ? '00002' : '00123', future ? 1 : -1])).rows[0].id;
  const id = await insert(false); await insert(true);
  for (const band of bands) for (const kind of ['first', 'additional'])
    await db.owner.query('INSERT INTO route_quotation_prices VALUES ($1,$2,$3,1.75)', [id, band, kind]);
  assert.deepEqual(await source.readCurrentFirstPrices(), [{ route_id: 1, postal_code: '00123', price: 1.75 }]);
  const data = await source.readRouteQuotation(1), row = data.current[0];
  assert.equal(typeof row.line_id, 'number'); assert.equal(row.route_id, 1);
  for (const field of ['effective_from', 'end_date', 'quotation_date']) assert.match(row[field], /^\d{4}-\d{2}-\d{2}$/);
  assert.match(data.upcoming[0].effective_from, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(row.imported_at, '2026-01-02T03:04:05.000Z');
  assert.equal(row.first_prices['0_1'], 1.75); assert.equal(data.weightBands.length, 7);
  assert.equal((await compareDataSources({ ...f, jsonSource: createJsonDataSource(f), dbSource: source })).exitCode, 0);
  await db.owner.query('DROP VIEW v_route_quotation_first_0_1lb');
  await db.owner.query('DROP VIEW v_route_quotation_current');
  const get = await open(t, f, source);
  for (const path of endpoints) { const res = await get(path); assert.equal(res.status, 200); checkUnavailable(path, res.body); }
  assert.equal((await get('/api/route-quotations?route_id=1')).status, 503);
});
