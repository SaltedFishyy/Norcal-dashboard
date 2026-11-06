import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbSkip } from './db-helpers.js';

const bands = ['0_1', '1_5', '5_10', '10_20', '20_30', '30_40', '40_plus'];
const tables = ['quotation_weight_bands', 'route_quotation_imports', 'route_quotation_lines', 'route_quotation_prices'];
const views = ['v_route_quotation_current', 'v_route_quotation_first_0_1lb', 'v_route_quotation_upcoming', 'v_quotation_weight_bands'];
const denied = (client, sql) => assert.rejects(client.query(sql), { code: '42501' });

test('LQ-AC1 migration 006 adds nullable raw text without changing views or reader access', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  assert.equal((await db.owner.query("SELECT version FROM schema_migrations WHERE version='006'")).rowCount, 1);
  const column = (await db.owner.query(`SELECT data_type,is_nullable,column_default FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='route_quotation_lines' AND column_name='second_parcel_half_price_raw'`, [db.schema])).rows;
  assert.deepEqual(column, [{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  await denied(db.reader, 'SELECT second_parcel_half_price_raw FROM route_quotation_lines');
  const expected = [
    ['line_id', 'import_id', 'station_code', 'route_id', 'route_name', 'postal_code', 'fleet_name', 'effective_from',
      'end_date', 'remarks', 'quotation_date', 'imported_at', 'first_prices', 'additional_prices'],
    ['route_id', 'postal_code', 'price'],
    ['route_id', 'postal_code', 'station_code', 'effective_from'],
    ['code', 'ordinal', 'label_zh', 'label_en'],
  ];
  for (const [index, view] of views.entries())
    assert.deepEqual((await db.reader.query(`SELECT * FROM ${view}`)).fields.map(field => field.name), expected[index]);
});

async function fixture(t) {
  const db = await createTestDb(t);
  const today = (await db.owner.query("SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date::text AS today")).rows[0].today;
  await db.owner.query("INSERT INTO known_stations(code) VALUES ('ZZZ01')");
  const importRow = async (source = 'manual_file', status = 'completed') => (await db.owner.query(`
    INSERT INTO route_quotation_imports(source,status,row_count,accepted_count,duplicate_count,rejected_count)
    VALUES ($1,$2,1,1,0,0) RETURNING id`, [source, status])).rows[0].id;
  const line = async (route, start, end = null, voided = false, zip = '01234', importId = null, station = 'ZZZ01') => {
    const id = importId ?? await importRow();
    return (await db.owner.query(`INSERT INTO route_quotation_lines
      (import_id,station_code,route_id,route_name,postal_code,effective_from,end_date,voided_at)
      VALUES ($1,$8,$2,'Synthetic route',$3,$4::date+$5::int,
        CASE WHEN $6::int IS NULL THEN NULL ELSE $4::date+$6::int END,
        CASE WHEN $7 THEN now() ELSE NULL END) RETURNING id`,
    [id, route, zip, today, start, end, voided, station])).rows[0].id;
  };
  return { ...db, today, importRow, line };
}

test('RQ-T1 migration 005 seeds all seven ordered weight bands and isolates roles', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  assert.equal((await db.owner.query("SELECT version FROM schema_migrations WHERE version='005'")).rowCount, 1);
  const rows = (await db.reader.query('SELECT * FROM v_quotation_weight_bands ORDER BY ordinal')).rows;
  assert.deepEqual(rows, bands.map((code, index) => ({ code, ordinal: index + 1,
    label_zh: index === 6 ? '40(lb)以上' : code.replace('_', '-') + '(lb)',
    label_en: index === 6 ? 'Above 40(lb)' : code.replace('_', '-') + '(lb)' })));
  for (const view of views) {
    const result = await db.reader.query(`SELECT * FROM ${view}`);
    for (const name of ['voided_at', 'void_reason', 'errors', 'warnings'])
      assert.ok(!result.fields.some(field => field.name === name));
  }
  for (const [table, column] of tables.map((name, i) => [name, ['code', 'id', 'id', 'line_id'][i]])) {
    for (const sql of [`SELECT * FROM ${table}`, `INSERT INTO ${table} DEFAULT VALUES`,
      `UPDATE ${table} SET ${column}=${column}`, `DELETE FROM ${table}`]) await denied(db.reader, sql);
  }
  for (const client of [db.scraper, db.warehouse, db.district])
    for (const name of [...tables, ...views]) await denied(client, `SELECT * FROM ${name}`);
});

test('RQ-T1 current and upcoming honor LA dates, replacement, expiry, fallback and voids', { skip: dbSkip }, async t => {
  const db = await fixture(t);
  await db.line(1, -30);
  const newer = await db.line(1, -5);
  await db.line(1, 3); await db.line(1, 7); await db.line(1, 1, null, true);
  await db.line(2, -30);
  const temporary = await db.line(2, -1, 1);
  const fallback = await db.line(3, -30);
  await db.line(3, -3, -1);
  const endsToday = await db.line(4, -2, 0);
  await db.line(5, -2, -1);
  const indefinite = await db.line(6, -30);
  await db.line(6, -1, null, true);
  await db.line(7, -1, null, true); await db.line(7, 3, null, true);
  await db.line(8, 3);
  const current = (await db.reader.query('SELECT route_id,line_id FROM v_route_quotation_current ORDER BY route_id')).rows;
  assert.deepEqual(current, [[1, newer], [2, temporary], [3, fallback], [4, endsToday], [6, indefinite]]
    .map(([route, id]) => ({ route_id: String(route), line_id: id })));
  const upcoming = (await db.reader.query(`SELECT route_id,postal_code,station_code,
    effective_from=$1::date+3 AS correct_date FROM v_route_quotation_upcoming ORDER BY route_id`, [db.today])).rows;
  assert.deepEqual(upcoming, [1, 8].map(route => ({ route_id: String(route), postal_code: '01234', station_code: 'ZZZ01', correct_date: true })));
  // UTC midnight still belongs to the preceding Los Angeles natural day.
  const boundary = (await db.owner.query(`SELECT
    (($1::date+1)::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date=$1::date AS correct`, [db.today])).rows[0];
  assert.equal(boundary.correct, true);
});

test('RQ-T1 database rejects conflicting keys and invalid quotation values', { skip: dbSkip }, async t => {
  const db = await fixture(t);
  const first = await db.line(1, -1);
  await assert.rejects(db.line(1, -1), { code: '23505' });
  await db.owner.query("UPDATE route_quotation_lines SET voided_at=now(),void_reason='Synthetic correction' WHERE id=$1", [first]);
  const replacement = await db.line(1, -1);
  const sameImport = await db.importRow();
  await db.line(2, -2, null, false, '01234', sameImport);
  await db.line(2, -1, null, false, '01234', sameImport);
  // Even a voided duplicate is forbidden within one import; the active index is separate.
  await assert.rejects(db.line(2, -1, null, true, '01234', sameImport), { code: '23505', constraint: 'quotation_import_route_zip_day_key' });
  const constraints = (await db.owner.query(`SELECT conname,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='route_quotation_lines'::regclass AND contype='u'`)).rows;
  assert.deepEqual(constraints, [{ conname: 'quotation_import_route_zip_day_key',
    definition: 'UNIQUE (import_id, route_id, postal_code, effective_from)' }]);
  for (const zip of ['1234', '123456', 'abcde']) await assert.rejects(db.line(3, -1, null, false, zip), { code: '23514' });
  await assert.rejects(db.line(3, -1, -2), { code: '23514' });
  await assert.rejects(db.line(3, -1, null, false, '01234', null, 'ZZZ02'), { code: '23503' });
  await assert.rejects(db.importRow('invalid'), { code: '23514' });
  await assert.rejects(db.importRow('manual_file', 'invalid'), { code: '23514' });
  for (const column of ['row_count', 'accepted_count', 'duplicate_count', 'rejected_count'])
    await assert.rejects(db.owner.query(`UPDATE route_quotation_imports SET ${column}=-1`), { code: '23514' });
  await assert.rejects(db.owner.query("UPDATE route_quotation_lines SET void_reason='invalid' WHERE id=$1", [replacement]), { code: '23514' });
  for (const [band, type, price, code] of [['0_1', 'first', -1, '23514'], ['0_1', 'invalid', 1, '23514'], ['invalid', 'first', 1, '23503']])
    await assert.rejects(db.owner.query('INSERT INTO route_quotation_prices VALUES ($1,$2,$3,$4)', [replacement, band, type, price]), { code });
});

test('RQ-T1 current view preserves fourteen numeric prices and projects first 0-1lb', { skip: dbSkip }, async t => {
  const db = await fixture(t), id = await db.line(1, -1);
  const expected = { first: {}, additional: {} };
  for (const [index, band] of bands.entries()) {
    for (const [type, offset] of [['first', 1], ['additional', 0]]) {
      const price = index + offset + 0.25;
      expected[type][band] = price;
      await db.owner.query('INSERT INTO route_quotation_prices VALUES ($1,$2,$3,$4)', [id, band, type, price]);
    }
  }
  const row = (await db.reader.query('SELECT * FROM v_route_quotation_current')).rows[0];
  assert.deepEqual(row.first_prices, expected.first);
  assert.deepEqual(row.additional_prices, expected.additional);
  assert.equal(row.line_id, id);
  assert.equal(row.quotation_date, null);
  assert.equal((await db.reader.query('SELECT price FROM v_route_quotation_first_0_1lb')).rows[0].price, '1.25');
});
