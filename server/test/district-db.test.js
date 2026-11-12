import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, dbSkip } from './db-helpers.js';
import { migrate } from '../src/db/migrate.js';
import { importDistricts, assembleDistrictConfig } from '../src/db/district-import.js';
import { defaultDistrictsPath, validateDistricts } from '../src/store/districts-file.js';
import { checkDistrictPrivileges, checkReaderDistrictIsolation } from '../src/districts/district-privileges.js';

const tables = ['known_stations', 'districts', 'district_stations', 'district_config_version'];
const denied = (client, sql) => assert.rejects(client.query(sql), { code: '42501' });
const seed = db => importDistricts({ client: db.owner });
async function viewRows(client) {
  const rows = {};
  for (const name of tables) rows[name] = (await client.query(`SELECT * FROM v_${name}`)).rows;
  return rows;
}

test('DA-T1 migrations 001–006 apply in order and skip on repetition', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), schema = db.schema + '_order', results = [];
  try {
    await migrate(db.owner, { ...db.options, schema, onResult: row => results.push(row) });
    assert.deepEqual(results, ['001', '002', '003', '004', '005', '006', '007', '008'].map(version => ({ version, result: 'applied' })));
    results.length = 0;
    await migrate(db.owner, { ...db.options, schema, onResult: row => results.push(row) });
    assert.deepEqual(results, ['001', '002', '003', '004', '005', '006', '007', '008'].map(version => ({ version, result: 'skipped' })));
  } finally { await db.owner.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`); }
});

test('DA-T1 station identity, district, foreign key and singleton constraints', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  await seed(db);
  const member = (await db.owner.query('SELECT * FROM district_stations LIMIT 1')).rows[0];
  const other = (await db.owner.query('SELECT id FROM districts WHERE id<>$1 LIMIT 1', [member.district_id])).rows[0].id;
  await assert.rejects(db.owner.query('INSERT INTO district_stations VALUES ($1,$2,0)',
    [member.station_code, other]), { code: '23505' });
  await assert.rejects(db.owner.query('INSERT INTO district_stations VALUES ($1,$2,0)',
    ['ZZZ99', member.district_id]), { code: '23503' });
  for (const sql of ["INSERT INTO known_stations(code) VALUES ('bad')",
    "INSERT INTO districts VALUES ('unassigned','x','x',99)",
    "INSERT INTO districts VALUES ('BAD','x','x',99)",
    "INSERT INTO districts VALUES ('empty',' ','x',99)",
    "INSERT INTO known_stations VALUES ('ZZZ99','invalid',now())",
    'INSERT INTO district_config_version VALUES (false,2,now())'])
    await assert.rejects(db.owner.query(sql), { code: '23514' });
  await assert.rejects(db.owner.query('INSERT INTO district_config_version VALUES (true,2,now())'), { code: '23505' });
});

test('DA-T1 district role permits membership CRUD, version update and four views', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  await seed(db);
  await db.district.query("DELETE FROM district_stations WHERE station_code='GJT01'");
  await db.district.query("INSERT INTO district_stations VALUES ('GJT01','denver',99)");
  await db.district.query("UPDATE district_stations SET district_id='denver',ordinal=98 WHERE station_code='GJT01'");
  await db.district.query('UPDATE district_config_version SET version=version+1,updated_at=now()');
  assert.equal((await db.district.query('SELECT version FROM v_district_config_version')).rows[0].version, '2');
  for (const name of tables) await db.district.query(`SELECT * FROM v_${name}`);
});

test('DA-T1 district role denies other writes and DDL', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  await seed(db);
  for (const table of [...tables, 'warehouses', 'stations', 'scrape_runs', 'station_snapshots',
    'snapshot_routes', 'route_detail_versions', 'schema_migrations']) {
    await denied(db.district, `TRUNCATE ${table}`);
    await denied(db.district, `ALTER TABLE ${table} ADD COLUMN forbidden int`);
    await denied(db.district, `DROP TABLE ${table}`);
    if (table === 'district_stations') continue;
    await denied(db.district, `INSERT INTO ${table} DEFAULT VALUES`);
    await denied(db.district, `DELETE FROM ${table}`);
    if (table === 'district_config_version') {
      await denied(db.district, 'UPDATE district_config_version SET id=id');
      continue;
    }
    const columns = (await db.owner.query(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
      AND attnum>0 AND NOT attisdropped`, [table])).rows;
    for (const { attname } of columns)
      await denied(db.district, `UPDATE ${table} SET ${pg.escapeIdentifier(attname)}=${pg.escapeIdentifier(attname)}`);
  }
  await denied(db.district, 'UPDATE district_stations SET station_code=station_code');
  await denied(db.district, 'CREATE TABLE forbidden(id int)');
});

test('DA-T1 A17 skip reason survives moves, removal and readdition', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  await seed(db);
  const other = (await db.district.query("SELECT id FROM v_districts WHERE id<>'denver' LIMIT 1")).rows[0].id;
  const reason = async () => assert.equal((await db.district.query(
    "SELECT scrape_disabled_reason FROM v_known_stations WHERE code='GJT01'")).rows[0].scrape_disabled_reason, 'not_in_dms_menu');
  for (const id of [other, 'denver']) {
    await db.district.query("UPDATE district_stations SET district_id=$1,ordinal=99 WHERE station_code='GJT01'", [id]);
    await reason();
  }
  await db.district.query("DELETE FROM district_stations WHERE station_code='GJT01'");
  await reason();
  await db.district.query("INSERT INTO district_stations VALUES ('GJT01','denver',99)");
  await reason();
});

test('DA-T1 atomic movement retains exactly one membership inside transaction', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  await seed(db);
  const other = (await db.district.query("SELECT id FROM v_districts WHERE id<>'denver' LIMIT 1")).rows[0].id;
  const count = async () => assert.equal((await db.district.query(
    "SELECT * FROM district_stations WHERE station_code='GJT01'")).rowCount, 1);
  await count();
  await db.district.query('BEGIN');
  try {
    await db.district.query("UPDATE district_stations SET district_id=$1,ordinal=99 WHERE station_code='GJT01'", [other]);
    await count();
    await db.district.query('COMMIT');
  } catch (error) { await db.district.query('ROLLBACK'); throw error; }
  await count();
});

test('DA-T1 reader scraper and warehouse district isolation', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  for (const client of [db.reader, db.scraper, db.warehouse]) {
    for (const name of tables) {
      if (client !== db.warehouse || ['districts', 'district_stations'].includes(name))
        await client.query(`SELECT * FROM v_${name}`);
      else await denied(client, `SELECT * FROM v_${name}`);
      await denied(client, `SELECT * FROM ${name}`);
      for (const sql of [`INSERT INTO ${name} DEFAULT VALUES`, `DELETE FROM ${name}`, `TRUNCATE ${name}`]) await denied(client, sql);
      const column = name === 'known_stations' ? 'code' : name === 'district_stations' ? 'district_id' : 'id';
      await denied(client, `UPDATE ${name} SET ${column}=${column}`);
    }
  }
});

test('DA-T1 privilege checks detect correct, excessive and missing permissions', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  assert.deepEqual(await checkDistrictPrivileges(db.district, db.options), { ok: true, problems: [] });
  assert.ok((await checkDistrictPrivileges(db.owner, db.options)).problems.includes('owns_objects'));
  for (const client of [db.scraper, db.warehouse]) assert.equal((await checkDistrictPrivileges(client, db.options)).ok, false);
  assert.deepEqual(await checkReaderDistrictIsolation(db.reader), { ok: true, problems: [] });
  assert.equal((await checkReaderDistrictIsolation(db.warehouse)).ok, false);
  for (const [grant, problem] of [['INSERT (scrape_disabled_reason) ON known_stations', 'other_relation_write'],
    ['UPDATE (station_code) ON district_stations', 'extra_district_privilege'],
    ['INSERT ON stations', 'other_relation_write'], ['UPDATE (id) ON district_config_version', 'extra_district_privilege']]) {
    await db.owner.query(`GRANT ${grant} TO nc_test_district`);
    assert.ok((await checkDistrictPrivileges(db.district, db.options)).problems.includes(problem));
    await db.owner.query(`REVOKE ${grant} FROM nc_test_district`);
  }
  await db.owner.query('CREATE SEQUENCE district_test_sequence');
  await db.owner.query('GRANT SELECT ON district_test_sequence TO nc_test_district');
  assert.ok((await checkDistrictPrivileges(db.district, db.options)).problems.includes('sequence_privilege'));
  await db.owner.query('REVOKE SELECT ON district_test_sequence FROM nc_test_district');
  await db.owner.query('ALTER TABLE district_stations ADD COLUMN future_column text');
  await db.owner.query('GRANT INSERT (future_column) ON district_stations TO nc_test_district');
  assert.ok((await checkDistrictPrivileges(db.district, db.options)).problems.includes('extra_district_privilege'));
  await db.owner.query('REVOKE INSERT (future_column) ON district_stations FROM nc_test_district');
  await db.owner.query('REVOKE UPDATE (ordinal) ON district_stations FROM nc_test_district');
  assert.deepEqual(await checkDistrictPrivileges(db.district, db.options), { ok: false, problems: ['missing_district_privilege'] });
});

test('DA-T1 real seed counts order skip reasons and rejection of existing targets', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  assert.deepEqual(await seed(db), { districts: 5, known_stations: 54, district_stations: 54, version: 1 });
  const before = await viewRows(db.reader);
  for (const station of before.known_stations)
    assert.equal(station.scrape_disabled_reason, ['GJT01', 'BZN01'].includes(station.code) ? 'not_in_dms_menu' : null);
  await assert.rejects(seed(db));
  assert.deepEqual(await viewRows(db.reader), before);
  // Independent targets prevent import; membership rows also require their FK parents.
  for (const name of tables) {
    await db.owner.query('TRUNCATE route_quotation_prices, route_quotation_lines, route_quotation_imports, district_stations, known_stations, districts, district_config_version');
    if (name === 'districts') await db.owner.query("INSERT INTO districts VALUES ('fixture','x','x',0)");
    if (name === 'known_stations') await db.owner.query("INSERT INTO known_stations(code) VALUES ('ZZZ01')");
    if (name === 'district_stations') {
      await seed(db);
      await db.owner.query('DELETE FROM district_config_version');
    }
    if (name === 'district_config_version') await db.owner.query('INSERT INTO district_config_version VALUES (true,7,now())');
    await assert.rejects(seed(db));
  }
});

test('DA-T1 seed includes historical unassigned codes and rolls back database failure', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  await db.owner.query("INSERT INTO stations(code) VALUES ('ZZZ01')");
  assert.equal((await seed(db)).known_stations, 55);
  assert.equal((await db.reader.query("SELECT * FROM v_known_stations WHERE code='ZZZ01'")).rowCount, 1);
  assert.equal((await db.reader.query("SELECT * FROM v_district_stations WHERE station_code='ZZZ01'")).rowCount, 0);
  await db.owner.query('TRUNCATE route_quotation_prices, route_quotation_lines, route_quotation_imports, district_stations, known_stations, districts, district_config_version');
  // Force a late database failure after inserts, rather than failing file validation before BEGIN.
  await db.owner.query('ALTER TABLE district_config_version ADD CHECK (version > 1)');
  await assert.rejects(seed(db), { code: '23514' });
  for (const name of tables) assert.equal((await db.owner.query(`SELECT * FROM ${name}`)).rowCount, 0);
  const dir = await mkdtemp(path.join(tmpdir(), 'nc-district-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'invalid.json');
  await writeFile(fixture, JSON.stringify({ schema_version: 1, districts: [{ id: 'bad', name_zh: 'x', name_en: 'x', stations: ['invalid'] }] }));
  await assert.rejects(importDistricts({ client: db.owner, districtsPath: fixture }));
  for (const name of tables) assert.equal((await db.owner.query(`SELECT * FROM ${name}`)).rowCount, 0);
});

test('DA-T1 four views reconstruct validated file configuration exactly', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  await seed(db);
  const expected = validateDistricts(JSON.parse(await readFile(defaultDistrictsPath, 'utf8')));
  assert.deepEqual(assembleDistrictConfig(await viewRows(db.reader)), expected);
});

test('DA-T1 privilege query failures propagate without logging', async () => {
  const error = new Error('synthetic');
  const client = { query: async () => { throw error; } };
  await assert.rejects(checkDistrictPrivileges(client, { schema: 'mock' }), e => e === error);
  await assert.rejects(checkReaderDistrictIsolation(client), e => e === error);
});
