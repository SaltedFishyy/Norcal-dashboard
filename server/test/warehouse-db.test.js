import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestDb, dbSkip } from './db-helpers.js';
import { migrate } from '../src/db/migrate.js';
import { connectDb } from '../src/db/connection.js';
import { checkWarehousePrivileges, checkReaderWarehouseIsolation } from '../src/warehouses/warehouse-privileges.js';

const insert = `INSERT INTO warehouses (warehouse_name,address,address_key,district_id,station_id,latitude,longitude)
  VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`;
const values = ['Synthetic warehouse', 'Synthetic address', 'synthetic address', 'mock', null, 37, -122];
const denied = (client, sql) => assert.rejects(client.query(sql), { code: '42501' });

test('WH-T1 real migrations apply in order and temporary schema cleanup removes all objects', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  const schema = db.schema + '_migration';
  const inspector = await connectDb('NC_TEST_DB_OWNER_URL', { schema: db.schema });
  t.after(() => inspector.end());
  // All additional objects stay within the disposable schema, even if an assertion fails.
  try {
    const results = [];
    await migrate(db.owner, { ...db.options, schema, onResult: r => results.push(r) });
    assert.deepEqual(results, ['001', '002', '003', '004', '005', '006', '007', '008', '009'].map(version => ({ version, result: 'applied' })));
  } finally {
    await db.owner.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
  }
  assert.equal((await inspector.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
});

test('WH-T1 migration, warehouse CRUD, constraints and role isolation', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), results = [];
  assert.deepEqual((await db.owner.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version), ['001', '002', '003', '004', '005', '006', '007', '008', '009']);
  await migrate(db.owner, { ...db.options, onResult: r => results.push(r) });
  assert.deepEqual(results, ['001', '002', '003', '004', '005', '006', '007', '008', '009'].map(version => ({ version, result: 'skipped' })));
  const row = (await db.warehouse.query(insert, values)).rows[0];
  assert.match(row.id, /^[a-f0-9-]{36}$/);
  assert.ok(row.created_at instanceof Date); assert.ok(row.updated_at instanceof Date);
  await db.warehouse.query(insert, values); // Duplicate addresses remain allowed.
  for (const column of ['warehouse_name', 'address', 'address_key', 'district_id', 'station_id', 'latitude', 'longitude', 'updated_at'])
    await db.warehouse.query(`UPDATE warehouses SET ${column}=${column} WHERE id=$1`, [row.id]);
  assert.equal((await db.warehouse.query('SELECT * FROM warehouses')).rowCount, 2);
  for (const client of [db.reader, db.warehouse]) {
    const view = await client.query('SELECT * FROM v_warehouses');
    assert.equal(view.rowCount, 2); assert.equal(view.fields.length, 9);
    assert.ok(!view.fields.some(f => f.name === 'address_key'));
  }
  for (const column of ['id', 'created_at']) await denied(db.warehouse, `UPDATE warehouses SET ${column}=${column}`);
  for (const sql of ['TRUNCATE warehouses', 'CREATE TABLE forbidden(id int)',
    'ALTER TABLE warehouses ADD COLUMN forbidden int', 'DROP TABLE warehouses']) await denied(db.warehouse, sql);
  for (const table of ['stations', 'scrape_runs', 'station_snapshots', 'route_detail_versions', 'snapshot_routes', 'schema_migrations']) {
    const col = (await db.owner.query(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
      AND attnum>0 AND NOT attisdropped ORDER BY attnum LIMIT 1`, [table])).rows[0].attname;
    for (const sql of [`INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET ${pg.escapeIdentifier(col)}=${pg.escapeIdentifier(col)}`,
      `DELETE FROM ${table}`, `TRUNCATE ${table}`]) await denied(db.warehouse, sql);
  }
  for (const client of [db.reader, db.scraper]) {
    await denied(client, 'SELECT * FROM warehouses');
    await denied(client, 'INSERT INTO warehouses DEFAULT VALUES');
  }
  await denied(db.reader, 'DELETE FROM warehouses');
  await denied(db.reader, 'UPDATE warehouses SET warehouse_name=warehouse_name');
  for (const [index, value] of [[0, ''], [0, ' '.repeat(3)], [0, 'x'.repeat(121)], [1, '   '], [1, 'x'.repeat(301)],
    [3, 'Mock'], [3, 'mock district'], [3, ''], [3, 'x'.repeat(33)], [4, 'sfo01'], [5, 91], [6, -181]]) {
    const invalid = [...values]; invalid[index] = value;
    await assert.rejects(db.warehouse.query(insert, invalid), { code: '23514' });
  }
  const indexes = (await db.owner.query('SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2', [db.schema, 'warehouses'])).rows;
  for (const column of ['address_key', 'district_id']) {
    const index = indexes.find(r => r.indexdef.includes(`(${column})`));
    assert.ok(index); assert.doesNotMatch(index.indexdef, /UNIQUE/);
  }
  await db.warehouse.query('DELETE FROM warehouses WHERE id=$1', [row.id]);
  assert.equal((await db.warehouse.query('SELECT * FROM warehouses WHERE id=$1', [row.id])).rowCount, 0);
});

test('WH-T1 privilege checks reject incorrect roles and excessive temporary-schema grants', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  assert.deepEqual(await checkWarehousePrivileges(db.warehouse, db.options), { ok: true, problems: [] });
  const owner = await checkWarehousePrivileges(db.owner, db.options);
  assert.equal(owner.ok, false); assert.ok(owner.problems.includes('owns_objects'));
  assert.equal((await checkWarehousePrivileges(db.scraper, db.options)).ok, false);
  assert.deepEqual(await checkReaderWarehouseIsolation(db.reader), { ok: true, problems: [] });
  assert.equal((await checkReaderWarehouseIsolation(db.warehouse)).ok, false);
  await db.owner.query('GRANT INSERT ON stations TO nc_test_warehouse');
  let result = await checkWarehousePrivileges(db.warehouse, db.options);
  assert.equal(result.ok, false); assert.ok(result.problems.includes('other_relation_write'));
  await db.owner.query('REVOKE INSERT ON stations FROM nc_test_warehouse');
  await db.owner.query('GRANT UPDATE (created_at) ON warehouses TO nc_test_warehouse');
  result = await checkWarehousePrivileges(db.warehouse, db.options);
  assert.equal(result.ok, false); assert.ok(result.problems.includes('extra_warehouse_privilege'));
  await db.owner.query('REVOKE UPDATE (created_at) ON warehouses FROM nc_test_warehouse');
  await db.owner.query('GRANT INSERT (code) ON stations TO nc_test_warehouse');
  assert.ok((await checkWarehousePrivileges(db.warehouse, db.options)).problems.includes('other_relation_write'));
  await db.owner.query('REVOKE INSERT (code) ON stations FROM nc_test_warehouse');
  await db.owner.query('CREATE SEQUENCE warehouse_test_sequence');
  await db.owner.query('GRANT USAGE ON warehouse_test_sequence TO nc_test_warehouse');
  assert.ok((await checkWarehousePrivileges(db.warehouse, db.options)).problems.includes('sequence_privilege'));
  await db.owner.query('GRANT UPDATE (warehouse_name) ON warehouses TO nc_test_reader');
  assert.equal((await checkReaderWarehouseIsolation(db.reader)).ok, false);
});

test('WH-T1 privilege query failures propagate without logging driver errors', async () => {
  const error = new Error('synthetic');
  const client = { query: async () => { throw error; } };
  await assert.rejects(checkWarehousePrivileges(client, { schema: 'mock' }), e => e === error);
  await assert.rejects(checkReaderWarehouseIsolation(client), e => e === error);
});
