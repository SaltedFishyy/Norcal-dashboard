import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { createApiServer } from '../src/api/server.js';
import { createJsonDataSource, DataSourceUnavailableError } from '../src/store/data-source.js';
import { centralFixture } from './central-db-fixtures.js';
import { SnapshotNotFoundError } from '../src/store/route-profiles-file.js';
import { RouteZipConflictError } from '../src/route-map/route-map.js';
import { setupWarehouses } from '../src/warehouses/warehouse-setup.js';

const input = { warehouse_name: 'Mock warehouse', address: '1 Mock Street', district_id: 'mock' };
export async function warehouseFixture(t, options = {}) {
  const f = await centralFixture(t), rows = [], logs = [], calls = [];
  let version = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ++version)).toISOString();
  const store = {
    get: async id => rows.find(row => row.id === id) ?? null,
    findByAddressKey: async (key, { excludeId }) => rows.filter(row => row.address_key === key && row.id !== excludeId),
    findByName: async (name, { excludeId }) => rows.filter(row => row.warehouse_name === name && row.id !== excludeId),
    insert: async values => { const row = { ...values, id: randomUUID(), created_at: stamp(), updated_at: stamp(), raw: 'private' }; rows.push(row); return row; },
    update: async (id, values, expected) => {
      const row = rows.find(r => r.id === id);
      if (!row) return { error: 'warehouse_not_found' };
      if (row.updated_at !== expected) return { error: 'warehouse_changed' };
      Object.assign(row, values, { updated_at: stamp() }); return { row };
    },
    remove: async id => { const index = rows.findIndex(row => row.id === id); if (index < 0) return false; rows.splice(index, 1); return true; },
  };
  const geocoder = { geocode: async address => { calls.push(address); return { status: 'ok', latitude: 38, longitude: -122, matched_address: 'MOCK MATCH' }; } };
  const source = { ...createJsonDataSource(f), source: 'db', readWarehouses: async () => rows };
  let server;
  const create = options.worker ? (await import('../src/worker/worker.js')).createWorkerServer : createApiServer;
  server = create({ ...f, log: line => logs.push(line), repoRoot: '.', dataSource: options.dataSource ?? source,
    ...(options.readonly ? {} : { warehouses: { store, geocoder, writeEnabled: true, ...(options.realExtent ? {} : { getDistrictExtent: async () => null }),
      allowedHosts: () => [`127.0.0.1:${server.address().port}`], ...options.warehouses } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (pathname = '/api/warehouses', method = 'GET', body, headers = {}) => {
    const { res, text } = await new Promise((resolve, reject) => {
      const req = http.request(url + pathname, { method, agent: false,
        headers: { Origin: url, 'X-NC-Warehouse': '1', 'Content-Type': 'application/json', ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ res, text }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
    assert.doesNotMatch(text, /address_key|stack|postgres(?:ql)?:\/\/|"raw"/);
    return { status: res.statusCode, body: text ? JSON.parse(text) : null, allow: res.headers.allow };
  };
  return { ...f, rows, logs, calls, store, geocoder, source, request, url };
}
test('WH CRUD reader GET, PATCH unchanged address, warning, stale version, invalid id and DELETE', async t => {
  const f = await warehouseFixture(t);
  const added = await f.request(undefined, 'POST', input);
  assert.equal(added.status, 201); assert.equal(f.calls.length, 1);
  const w = added.body.warehouse;
  assert.equal(w.station_id, null); assert.equal(w.station_known, true);
  assert.equal((await f.request('/api/warehouses?district=mock')).body.warehouses.length, 1);
  const edited = await f.request(`/api/warehouses?id=${w.id}`, 'PATCH', { ...input, warehouse_name: 'Changed', expected_updated_at: w.updated_at });
  assert.equal(edited.status, 200); assert.equal(edited.body.geocode, null); assert.equal(f.calls.length, 1);
  assert.equal((await f.request(`/api/warehouses?id=${w.id}`, 'PATCH', { ...input, expected_updated_at: w.updated_at })).body.error, 'warehouse_changed');
  const duplicateName = await f.request(undefined, 'POST', { ...input, warehouse_name: 'Changed', address: '2 Mock Street' });
  assert.deepEqual(duplicateName.body.warnings, ['duplicate_name']);
  assert.equal((await f.request(`/api/warehouses?id=${randomUUID()}`, 'PATCH', { ...input, expected_updated_at: w.updated_at })).status, 404);
  for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request('/api/warehouses?id=bad', method, method === 'PATCH' ? input : undefined)).body.error, 'invalid_warehouse_id');
  assert.equal((await f.request(`/api/warehouses?id=${w.id}`, 'DELETE')).status, 204);
  assert.equal((await f.request(`/api/warehouses?id=${w.id}`, 'DELETE')).status, 404);
  assert.ok(f.logs.every(line => /^HTTP \d+$/.test(line)));
});
test('WH duplicate address and far district confirmations; PATCH district changes distance only', async t => {
  let extents = 0;
  const f = await warehouseFixture(t, { warehouses: { getDistrictExtent: async () => { extents++; return [[0, 0], [1, 1]]; } } });
  const far = await f.request(undefined, 'POST', input);
  assert.deepEqual(far.body.reasons, ['far_from_district']); assert.equal(f.rows.length, 0);
  const saved = await f.request(undefined, 'POST', { ...input, confirm: ['far_from_district'] });
  assert.equal(saved.status, 201);
  const duplicate = await f.request(undefined, 'POST', { ...input, address: '1 Mock St.', confirm: ['far_from_district'] });
  assert.deepEqual(duplicate.body.reasons, ['duplicate_address']);
  assert.deepEqual(Object.keys(duplicate.body.duplicates[0]).sort(), ['address', 'district_id', 'warehouse_name']);
  assert.equal((await f.request(undefined, 'POST', { ...input, confirm: ['duplicate_address', 'far_from_district'] })).status, 201);
  const w = saved.body.warehouse, count = extents, calls = f.calls.length;
  assert.equal((await f.request(`/api/warehouses?id=${w.id}`, 'PATCH', { ...input, expected_updated_at: w.updated_at })).status, 200);
  assert.equal(extents, count); assert.equal(f.calls.length, calls);
  await writeFile(f.districtsPath, JSON.stringify({ schema_version: 1, districts: [
    { id: 'mock', name_zh: '模拟', name_en: 'Mock', stations: [] }, { id: 'other', name_zh: '其他', name_en: 'Other', stations: [] } ] }));
  const changed = await f.request(`/api/warehouses?id=${w.id}`, 'PATCH', { ...input, district_id: 'other', expected_updated_at: f.rows[0].updated_at });
  assert.equal(changed.body.error, 'confirmation_required'); assert.equal(extents, count + 1); assert.equal(f.calls.length, calls);
});
test('WH all geocode failures never write, manual coordinates skip Census, changed address calls Census', async t => {
  for (const status of ['failed', 'ambiguous', 'unavailable']) {
    const f = await warehouseFixture(t, { warehouses: { geocoder: { geocode: async () => ({ status }) } } });
    const result = await f.request(undefined, 'POST', input);
    assert.equal(result.body.error, `geocode_${status}`); assert.equal(f.rows.length, 0);
    assert.equal((await f.request(undefined, 'POST', { ...input, manual_coordinates: { latitude: 38, longitude: -122 } })).status, 201);
  }
  const f = await warehouseFixture(t);
  const added = await f.request(undefined, 'POST', { ...input, manual_coordinates: { latitude: 38, longitude: -122 } });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(`/api/warehouses?id=${added.body.warehouse.id}`, 'PATCH', {
    ...input, address: '2 Mock Street', expected_updated_at: added.body.warehouse.updated_at })).status, 200);
  assert.equal(f.calls.length, 1);
});
test('WH assignment, query validation, unknown district projection and disabled station', async t => {
  const f = await warehouseFixture(t);
  for (const station_id of ['BBB01', 'ZZZ01']) assert.equal((await f.request(undefined, 'POST', { ...input, station_id })).body.error, 'station_not_in_district');
  assert.equal((await f.request(undefined, 'POST', { ...input, district_id: 'deleted' })).body.error, 'district_not_found');
  await writeFile(f.districtsPath, JSON.stringify({ schema_version: 1, districts: [{ id: 'mock', name_zh: '模拟', name_en: 'Mock', stations: ['AAA01'], scrape_disabled: { AAA01: 'disabled' } }] }));
  const added = await f.request(undefined, 'POST', { ...input, station_id: 'AAA01' });
  assert.equal(added.status, 201);
  f.rows[0].district_id = 'deleted';
  assert.equal((await f.request()).body.warehouses[0].district_known, false);
  assert.equal((await f.request('/api/warehouses?district=mock')).body.warehouses.length, 0);
  assert.equal((await f.request('/api/warehouses?district=deleted')).status, 404);
  for (const query of ['?district=mock&district=mock', '?unknown=1']) assert.equal((await f.request('/api/warehouses' + query)).status, 400);
  assert.equal((await f.request(`/api/warehouses?id=${added.body.warehouse.id}`, 'DELETE')).status, 204);
});
test('WH protection rejects bad host/origin/header/content-type/body, and other routes stay GET only', async t => {
  const f = await warehouseFixture(t);
  for (const [headers, error] of [[{ Host: 'evil.invalid:3000' }, 'forbidden_host'], [{ Origin: 'http://evil.invalid' }, 'forbidden_origin'],
    [{ Origin: '' }, 'forbidden_origin'], [{ 'X-NC-Warehouse': '' }, 'forbidden_header'], [{ 'Content-Type': 'text/plain' }, 'invalid_content_type']])
    assert.equal((await f.request(undefined, 'POST', input, headers)).body.error, error);
  for (const body of ['[1]', 'null', '{', '"str"', JSON.stringify({ ...input, address: 'x'.repeat(5000) })])
    assert.equal((await f.request(undefined, 'POST', body)).body.error, 'invalid_body');
  assert.equal((await f.request(undefined, 'POST', { ...input, unknown: true })).body.error, 'invalid_body');
  assert.equal((await f.request(undefined, 'POST', { ...input, address: ' ' })).body.error, 'invalid_warehouse');
  for (const pathname of ['/api/route-profiles', '/api/route-map', '/api/districts', '/api/route-details', '/api/freshness', '/api/runs', '/api/route-map/district', '/api/route-map/zip'])
    for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await f.request(pathname, method, method === 'DELETE' ? undefined : {})).status, 405);
  assert.equal(f.rows.length, 0);
});
test('WH writes disabled give Allow GET; JSON and DB failures return sanitized 503', async t => {
  const f = await warehouseFixture(t, { warehouses: { writeEnabled: false } });
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const r = await f.request(undefined, method, method === 'DELETE' ? undefined : input);
    assert.equal(r.status, 405); assert.equal(r.allow, 'GET');
  }
  for (const dataSource of [createJsonDataSource({ runtimeDir: f.runtimeDir }), { readWarehouses: async () => { throw new DataSourceUnavailableError(); } }]) {
    const failed = await warehouseFixture(t, { dataSource });
    assert.deepEqual((await failed.request()).body, { error: 'data_source_unavailable' });
  }
  const failed = await warehouseFixture(t, { warehouses: { store: { findByAddressKey: async () => { throw new DataSourceUnavailableError(); } } } });
  assert.equal((await failed.request(undefined, 'POST', input)).status, 503);
});
test('WH actual district map bbox warns for far coordinates and absent snapshot skips warning', async t => {
  const f = await warehouseFixture(t, { realExtent: true });
  const result = await f.request(undefined, 'POST', { ...input, manual_coordinates: { latitude: -80, longitude: 100 } });
  assert.equal(result.body.error, 'confirmation_required'); assert.deepEqual(result.body.reasons, ['far_from_district']);
  f.source.readRouteProfiles = async () => { throw new SnapshotNotFoundError(); };
  assert.equal((await f.request(undefined, 'POST', { ...input, manual_coordinates: { latitude: -80, longitude: 100 } })).status, 201);
  f.source.readRouteProfiles = async () => ({ stations: { AAA01: { rows: [], fetched_at: '2026-01-01T00:00:00Z' } } });
  assert.equal((await f.request(undefined, 'POST', { ...input, address: '2 Mock Road', manual_coordinates: { latitude: -80, longitude: 100 } })).status, 201);
});
test('WH PATCH retains atomic store conflict after successful preflight; GET is sorted', async t => {
  const f = await warehouseFixture(t);
  const added = await f.request(undefined, 'POST', input);
  f.store.update = async () => ({ error: 'warehouse_changed' });
  assert.equal((await f.request(`/api/warehouses?id=${added.body.warehouse.id}`, 'PATCH', {
    ...input, expected_updated_at: added.body.warehouse.updated_at })).body.error, 'warehouse_changed');
  await f.request(undefined, 'POST', { ...input, warehouse_name: 'A Mock', address: '2 Mock St' });
  assert.deepEqual((await f.request()).body.warehouses.map(w => w.warehouse_name), ['A Mock', 'Mock warehouse']);
});

test('WH extent data errors skip distance checks, while DB and unknown errors propagate', async t => {
  for (const error of [new RouteZipConflictError([]), new DataSourceUnavailableError(), new Error('mock unknown')]) {
    const f = await warehouseFixture(t, { realExtent: true });
    f.source.readRouteDetailsForMap = async () => { throw error; };
    const result = await f.request(undefined, 'POST', { ...input, manual_coordinates: { latitude: -80, longitude: 100 } });
    if (error instanceof RouteZipConflictError) {
      assert.equal(result.status, 201);
      assert.deepEqual(result.body.warnings, []);
      assert.equal(result.body.reasons, undefined);
      assert.equal(f.rows.length, 1);
    } else {
      assert.equal(result.status, error instanceof DataSourceUnavailableError ? 503 : 500);
      assert.equal(result.body.error, error instanceof DataSourceUnavailableError ? 'data_source_unavailable' : 'internal_error');
      assert.equal(f.rows.length, 0);
    }
  }
});

test('WH loopback whitelist accepts case-insensitive Host/Origin and rejects LAN', async t => {
  const setup = await setupWarehouses({ env: { DATA_SOURCE: 'db', NC_DB_WAREHOUSE_URL: 'mock' },
    port: 3100, createStore: () => ({ checkPrivileges: async () => ({ ok: true, problems: [] }), close: async () => {} }) });
  t.after(() => setup.close());
  assert.deepEqual(setup.allowedHosts(), ['127.0.0.1:3100', 'localhost:3100']);
  const f = await warehouseFixture(t, { warehouses: { allowedHosts: setup.allowedHosts } });
  assert.equal((await f.request(undefined, 'POST', input, { Host: 'localhost:3100', Origin: 'http://localhost:3100' })).status, 201);
  assert.equal((await f.request(undefined, 'POST', { ...input, address: '2 Mock Street' }, { Host: 'LOCALHOST:3100', Origin: 'HTTP://LOCALHOST:3100' })).status, 201);
  const rejected = await f.request(undefined, 'POST', input, { Host: 'kenny:3100', Origin: 'http://kenny:3100' });
  assert.equal(rejected.status, 403); assert.equal(rejected.body.error, 'forbidden_host');
});


test('T4 3000 GET reads warehouses without write setup; warehouse and operational writes are rejected', async t => {
  const f = await warehouseFixture(t, { readonly: true });
  await writeFile(f.districtsPath, JSON.stringify({ schema_version: 1, districts: [
    { id: 'north-cal', name_zh: '模拟北加', name_en: 'Mock North', stations: [] },
    { id: 'other', name_zh: '模拟其他', name_en: 'Mock Other', stations: [] } ] }));
  f.rows.push({ ...input, id: randomUUID(), district_id: 'north-cal', latitude: 38, longitude: -122 },
    { ...input, id: randomUUID(), district_id: 'other', latitude: 37, longitude: -121 });
  const filtered = await f.request('/api/warehouses?district=north-cal');
  assert.equal(filtered.status, 200); assert.equal(filtered.body.warehouses.length, 1);
  assert.equal(filtered.body.warehouses[0].district_id, 'north-cal');
  const all = await f.request(); assert.equal(all.status, 200); assert.equal(all.body.warehouses.length, 2);
  assert.equal((await f.request('/api/capabilities')).body.warehouse_write, false);
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const result = await f.request(undefined, method, input);
    assert.equal(result.status, 405); assert.equal(result.allow, 'GET');
    for (const pathname of ['/api/route-profiles', '/api/route-map', '/api/route-map/district', '/api/route-map/zip',
      '/api/districts', '/api/route-details', '/api/freshness', '/api/runs', '/api/refresh', '/api/refresh/status']) {
      const r = await f.request(pathname, method, {});
      assert.equal(r.status, pathname.startsWith('/api/refresh') ? 404 : 405, pathname);
    }
  }
  assert.equal(f.rows.length, 2); assert.equal(f.calls.length, 0);
});

test('T4 worker CRUD and capabilities remain writable; non-loopback Host is rejected', async t => {
  const f = await warehouseFixture(t, { worker: true });
  assert.equal((await f.request('/api/capabilities')).body.warehouse_write, true);
  const added = await f.request(undefined, 'POST', input); assert.equal(added.status, 201);
  const row = added.body.warehouse;
  assert.equal((await f.request('/api/warehouses?id=' + row.id, 'PATCH', { ...input, warehouse_name: 'Edited', expected_updated_at: row.updated_at })).status, 200);
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const r = await f.request('/api/warehouses?id=' + row.id, method, input, { Host: 'kenny:3100', Origin: 'http://kenny:3100' });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'forbidden_host');
  }
  assert.equal((await f.request('/api/warehouses?id=' + row.id, 'DELETE')).status, 204);
});
