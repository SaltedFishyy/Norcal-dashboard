import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestDb, dbSkip } from './db-helpers.js';
import { centralFixture } from './central-db-fixtures.js';
import { createWarehouseStore } from '../src/warehouses/warehouse-store.js';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { createApiServer } from '../src/api/server.js';

test('WH store CRUD, atomic stale protection, reader view and privileges', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  const store = createWarehouseStore({ schema: db.schema, connectionString: process.env.NC_TEST_DB_WAREHOUSE_URL });
  const source = createDbDataSource({ schema: db.schema, env: { NC_DB_READER_URL: process.env.NC_TEST_DB_READER_URL } });
  t.after(async () => { await store.close(); await source.close(); });
  const values = { warehouse_name: 'Mock', address: '1 Mock St', address_key: '1 mock st', district_id: 'mock', station_id: null, latitude: 38, longitude: -122 };
  assert.equal((await store.checkPrivileges()).ok, true);
  const row = await store.insert(values);
  assert.equal((await store.get(row.id)).warehouse_name, 'Mock');
  assert.equal((await store.list({ districtId: 'mock' })).length, 1);
  assert.equal((await store.list({ districtId: 'other' })).length, 0);
  assert.equal((await store.findByAddressKey(values.address_key)).length, 1);
  assert.equal((await store.findByAddressKey(values.address_key, { excludeId: row.id })).length, 0);
  assert.equal((await store.findByName('Mock')).length, 1);
  assert.equal((await store.findByName('  mOcK  ')).length, 1);
  assert.equal((await store.findByName('mock', { excludeId: row.id })).length, 0);
  await db.owner.query('UPDATE warehouses SET warehouse_name=$1 WHERE id=$2', ['  Mock  ', row.id]);
  assert.equal((await store.findByName('MOCK')).length, 1);
  const read = (await source.readWarehouses({ districtId: 'mock' }))[0];
  assert.equal(Object.hasOwn(read, 'address_key'), false);
  const updated = await store.update(row.id, { ...values, warehouse_name: 'Updated' }, row.updated_at.toISOString());
  assert.equal(updated.row.warehouse_name, 'Updated');
  assert.equal((await store.update(row.id, values, '2000-01-01T00:00:00Z')).error, 'warehouse_changed');
  assert.equal(await store.remove(row.id), true); assert.equal(await store.remove(row.id), false);
  assert.equal((await store.update(row.id, values, row.updated_at.toISOString())).error, 'warehouse_not_found');
  // Removing only warehouse objects models the interval before migration 003.
  await db.owner.query(`DROP VIEW ${pg.escapeIdentifier(db.schema)}.v_warehouses`);
  await db.owner.query(`DROP TABLE ${pg.escapeIdentifier(db.schema)}.warehouses`);
  assert.deepEqual(await store.checkPrivileges(), { ok: false, problems: ['missing_warehouse_privilege'] });
  assert.deepEqual(await source.checkReaderWarehouseIsolation(), { ok: false, problems: ['missing_warehouse_privilege'] });
  await assert.rejects(source.readWarehouses(), { name: 'DataSourceUnavailableError' });
});
test('WH owner microsecond timestamp survives real reader GET to atomic PATCH', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), f = await centralFixture(t);
  const store = createWarehouseStore({ schema: db.schema, connectionString: process.env.NC_TEST_DB_WAREHOUSE_URL });
  const dataSource = createDbDataSource({ schema: db.schema, env: { NC_DB_READER_URL: process.env.NC_TEST_DB_READER_URL } });
  t.after(async () => { await store.close(); await dataSource.close(); });
  const input = { warehouse_name: 'Mock', address: '1 Mock St', district_id: 'mock', station_id: null };
  const row = await store.insert({ ...input, address_key: '1 mock st', latitude: 38, longitude: -122 });
  await db.owner.query('UPDATE warehouses SET updated_at=$1 WHERE id=$2', ['2026-01-01T00:00:00.123456Z', row.id]);
  let server;
  server = createApiServer({ ...f, dataSource, warehouses: { store, writeEnabled: true,
    geocoder: { geocode: () => assert.fail('Unchanged address must not geocode') },
    allowedHosts: () => [`127.0.0.1:${server.address().port}`] } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = await (await fetch(url + '/api/warehouses')).json();
  assert.equal(get.warehouses[0].updated_at, '2026-01-01T00:00:00.123Z');
  const res = await fetch(`${url}/api/warehouses?id=${row.id}`, { method: 'PATCH',
    headers: { Origin: url, 'X-NC-Warehouse': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, warehouse_name: 'Changed', expected_updated_at: get.warehouses[0].updated_at }) });
  assert.equal(res.status, 200); assert.equal((await res.json()).warehouse.warehouse_name, 'Changed');
});
