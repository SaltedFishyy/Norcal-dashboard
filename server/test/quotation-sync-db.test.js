import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbSkip } from './db-helpers.js';
import { sfoHeader, syntheticCells } from './lark-quotation-fixtures.js';
import { parseQuotationSheet, quotationBands } from '../src/quotations/lark-sheet-parse.js';
import { planQuotationSync } from '../src/quotations/quotation-sync-plan.js';
import { applyQuotationSync, readActiveRoutes, readScopeLines, readOtherSourceKeys } from '../src/quotations/quotation-sync-db.js';

const sourceRef = 'lark:synthetic/sheet-a';
const cells = (zip = '12345', start = '01/01/2000', price = 900) => {
  const row = syntheticCells();
  row[3] = zip; row[19] = start; row[5] = price;
  return row;
};
const parsed = rows => parseQuotationSheet([...sfoHeader, ...rows]);

test('LQ-T6 quotation writer has only required object and column privileges', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), writer = db.quotation;
  const tables = ['route_quotation_imports', 'route_quotation_lines', 'route_quotation_prices'];
  for (const table of tables) {
    await writer.query(`SELECT * FROM ${table}`);
    for (const sql of [`DELETE FROM ${table}`, `TRUNCATE ${table}`])
      await assert.rejects(writer.query(sql), { code: '42501' });
    const privileges = (await db.owner.query(`SELECT
      has_table_privilege('nc_test_quotation',$1,'REFERENCES') AS references,
      has_table_privilege('nc_test_quotation',$1,'TRIGGER') AS trigger`, [`${db.schema}.${table}`])).rows[0];
    assert.deepEqual(privileges, { references: false, trigger: false });
    for (const role of ['scraper', 'reader', 'warehouse', 'district']) {
      for (const sql of [`INSERT INTO ${table} DEFAULT VALUES`, `DELETE FROM ${table}`, `TRUNCATE ${table}`])
        await assert.rejects(db[role].query(sql), { code: '42501' });
    }
  }
  for (const sql of [
    'UPDATE route_quotation_lines SET route_name=route_name',
    'UPDATE route_quotation_prices SET price=price',
    'UPDATE route_quotation_imports SET status=status',
    'SELECT * FROM quotation_weight_bands',
    'SELECT * FROM v_route_detail_zips',
  ]) await assert.rejects(writer.query(sql), { code: '42501' });
  for (const table of ['known_stations', 'snapshot_routes', 'stations', 'scrape_runs', 'station_snapshots',
    'route_detail_versions', 'route_detail_zips', 'warehouses', 'districts', 'district_stations', 'district_config_version']) {
    for (const sql of [`SELECT * FROM ${table}`, `INSERT INTO ${table} DEFAULT VALUES`])
      await assert.rejects(writer.query(sql), { code: '42501' });
  }
  for (const sql of ['UPDATE known_stations SET code=code', 'UPDATE snapshot_routes SET route_name=route_name',
    'UPDATE warehouses SET warehouse_name=warehouse_name', 'UPDATE districts SET name_zh=name_zh'])
    await assert.rejects(writer.query(sql), { code: '42501' });
  const sequence = (await db.owner.query("SELECT pg_get_serial_sequence('route_quotation_lines','id') AS name")).rows[0].name;
  assert.equal(sequence, `${db.schema}.route_quotation_lines_id_seq`);
  const access = (await db.owner.query(`SELECT
    has_sequence_privilege('nc_test_quotation',$1,'USAGE') AS usage,
    has_sequence_privilege('nc_test_quotation',$1,'SELECT') AS select,
    has_sequence_privilege('nc_test_quotation',$1,'UPDATE') AS update`, [sequence])).rows[0];
  assert.deepEqual(access, { usage: true, select: false, update: false });
});

async function fixture(t, writerRole = 'owner') {
  const db = await createTestDb(t), client = db.owner;
  await client.query("INSERT INTO known_stations(code) VALUES ('ZZZ01') ON CONFLICT DO NOTHING");
  await client.query("INSERT INTO stations(code) VALUES ('ZZZ01')");
  const run = (await client.query(`INSERT INTO scrape_runs
    (id,trigger,status,requested_stations,options,started_at) VALUES
    (gen_random_uuid(),'json_import','completed',ARRAY['ZZZ01'],'{}',now()) RETURNING id`)).rows[0].id;
  const snapshot = (await client.query(`INSERT INTO station_snapshots
    (station_code,run_id,status,origin,fetched_at,source,total)
    VALUES ('ZZZ01',$1,'active','json_import','synthetic','synthetic',1) RETURNING id`, [run])).rows[0].id;
  await client.query(`INSERT INTO snapshot_routes(snapshot_id,route_id,ordinal,route_name,profile)
    VALUES ($1,1,0,'Mock Route',$2)`, [snapshot, JSON.stringify({ postal_codes: ['12345', '01234'] })]);
  // Deliberately different: quotation ZIPs must come from profile, not detail or snapshot ZIP rows.
  const detail = (await client.query(`INSERT INTO route_detail_versions
    (route_id,station_code,run_id,origin,status,fetched_at,detail)
    VALUES (1,'ZZZ01',$1,'json_import','committed','synthetic','{}') RETURNING id`, [run])).rows[0].id;
  await client.query(`INSERT INTO route_detail_zips VALUES ($1,0,'99999','{"postal_code":"99999"}')`, [detail]);
  const sync = (rows, options = {}) => applyQuotationSync({ client: db[writerRole], sourceRef, parsed: parsed(rows), ...options });
  const state = async () => {
    const result = {};
    for (const table of ['route_quotation_imports', 'route_quotation_lines', 'route_quotation_prices'])
      result[table] = (await client.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;
    return result;
  };
  return { ...db, client, sync, state };
}

test('LQ-T2 first sync, reader route ZIP source, normalized round trip and replacement history', { skip: dbSkip }, async t => {
  const db = await fixture(t, 'quotation');
  assert.deepEqual(await readActiveRoutes(db.reader), [{ route_id: 1, route_name: 'Mock Route', station_code: 'ZZZ01', postal_codes: ['12345', '01234'] }]);
  const first = await db.sync([cells()]);
  assert.equal(first.result, 'completed'); assert.ok(first.importId);
  const entry = (await db.client.query('SELECT * FROM route_quotation_imports')).rows[0];
  assert.equal(entry.source_ref, sourceRef); assert.equal(entry.source, 'lark_sheet');
  assert.equal(entry.quotation_date, null); assert.equal(entry.imported_by, 'lark-sync');
  assert.deepEqual([entry.row_count, entry.accepted_count, entry.duplicate_count, entry.rejected_count], [1, 1, 0, 0]);
  const lines = await readScopeLines(db.client, sourceRef);
  assert.equal(typeof lines[0].line_id, 'string'); assert.equal(lines[0].route_id, 1);
  assert.equal(lines[0].effective_from, '2000-01-01'); assert.equal(lines[0].end_date, null);
  assert.equal(lines[0].source_row, 4); assert.equal(lines[0].second_parcel_half_price_raw, '是');
  for (const [index, band] of quotationBands.entries()) {
    assert.equal(lines[0].first[band], 900 + index);
    assert.equal(lines[0].additional[band], 907 + index);
  }
  assert.equal(planQuotationSync({ parsed: parsed([cells()]), activeRoutes: await readActiveRoutes(db.client),
    scopeLines: lines, otherSourceKeys: [] }).result, 'unchanged');
  const before = await db.state();
  assert.equal((await db.sync([cells()])).result, 'unchanged');
  assert.deepEqual(await db.state(), before);
  const replacement = await db.sync([cells('12345', '01/01/2000', 901)]);
  assert.equal(replacement.plan.counts.replaced, 1);
  const old = (await db.client.query('SELECT * FROM route_quotation_lines WHERE id=$1', [lines[0].line_id])).rows[0];
  assert.equal(old.void_reason, 'lark_replaced'); assert.ok(old.voided_at);
  assert.equal((await db.reader.query('SELECT price FROM v_route_quotation_first_0_1lb')).rows[0].price, '901.00');
  assert.equal((await db.reader.query('SELECT first_prices FROM v_route_quotation_current')).rows[0].first_prices['0_1'], 901);
});

test('LQ-T2 multiple dates in one import, removal fallback and missing current price', { skip: dbSkip }, async t => {
  const db = await fixture(t, 'quotation');
  const today = (await db.client.query("SELECT to_char((now() AT TIME ZONE 'America/Los_Angeles')::date,'MM/DD/YYYY') AS day")).rows[0].day;
  const permanent = cells(), temporary = cells('12345', today, 950), other = cells('01234');
  temporary[20] = today;
  const first = await db.sync([permanent, temporary, other]);
  assert.equal(first.plan.counts.inserted, 3);
  assert.equal((await db.reader.query("SELECT price FROM v_route_quotation_first_0_1lb WHERE postal_code='12345'")).rows[0].price, '950.00');
  await db.sync([permanent], { maxRemovalRatio: 1 });
  const voids = (await db.client.query("SELECT void_reason FROM route_quotation_lines WHERE voided_at IS NOT NULL")).rows;
  assert.deepEqual(voids, [{ void_reason: 'lark_removed' }, { void_reason: 'lark_removed' }]);
  const current = (await db.reader.query('SELECT postal_code,price FROM v_route_quotation_first_0_1lb')).rows;
  assert.deepEqual(current, [{ postal_code: '12345', price: '900.00' }]);
  assert.equal((await db.client.query('SELECT count(*) FROM route_quotation_lines')).rows[0].count, '3');
});

test('LQ-T2 manual and different sheet scopes remain intact and conflicting keys are rejected', { skip: dbSkip }, async t => {
  const db = await fixture(t);
  await db.sync([cells()]);
  await db.client.query("UPDATE route_quotation_imports SET source='manual_file',source_ref=NULL");
  const secondRef = 'lark:synthetic/sheet-b';
  await db.sync([cells('01234')], { sourceRef: secondRef });
  assert.equal((await readOtherSourceKeys(db.client, sourceRef)).length, 2);
  const result = await db.sync([cells(), cells('01234'), cells('54321')]);
  assert.equal(result.result, 'partial');
  assert.deepEqual(result.plan.rejected.map(row => row.reason), ['conflict_other_source', 'conflict_other_source']);
  const entry = (await db.client.query('SELECT * FROM route_quotation_imports WHERE id=$1', [result.importId])).rows[0];
  assert.deepEqual([entry.row_count, entry.accepted_count, entry.rejected_count], [3, 1, 2]);
  assert.deepEqual(entry.errors, result.plan.rejected); assert.deepEqual(entry.warnings, result.plan.warnings);
  await db.sync([], { maxRemovalRatio: 1 });
  assert.equal((await readScopeLines(db.client, secondRef)).length, 1);
  assert.equal((await db.client.query(`SELECT count(*) FROM route_quotation_lines l JOIN route_quotation_imports i
    ON i.id=l.import_id WHERE i.source='manual_file' AND l.voided_at IS NULL`)).rows[0].count, '1');
});

test('LQ-T2 rejected row protection, invalid ZIP skips removal, mass removal and dry run write nothing', { skip: dbSkip }, async t => {
  const db = await fixture(t), zero = cells(); zero[5] = 0;
  await db.sync([cells(), cells('01234')]);
  const protectedResult = await db.sync([zero, cells('01234', '01/01/2000', 901)]);
  assert.equal(protectedResult.result, 'partial');
  assert.equal(protectedResult.plan.counts.protected, 1);
  assert.equal((await readScopeLines(db.client, sourceRef)).find(row => row.postal_code === '12345').first['0_1'], 900);
  const invalid = await db.sync([cells('1234'), cells('01234', '01/01/2000', 902)]);
  assert.equal(invalid.plan.counts.removed, 0);
  assert.ok(invalid.plan.warnings.some(row => row.code === 'removals_skipped'));
  const before = await db.state();
  for (const [rows, options, expected] of [
    [[cells()], {}, 'aborted_mass_removal'], [[], {}, 'aborted_mass_removal'],
    [[zero], {}, 'rejected'], [[cells('54321')], { dryRun: true, maxRemovalRatio: 1 }, 'completed'],
  ]) {
    const result = await db.sync(rows, options);
    assert.equal(result.result, expected); assert.equal(result.importId, null);
    assert.deepEqual(await db.state(), before);
    if (options.dryRun) assert.equal(result.plan.counts.inserted, 1);
  }
});

test('LQ-T2 errors after voids or prices roll back all writes and sanitize driver errors', { skip: dbSkip }, async t => {
  const db = await fixture(t);
  await db.sync([cells()]);
  const before = await db.state();
  for (const mode of ['price', 'concurrent']) {
    const queries = [];
    const client = { query: async (sql, args) => {
      queries.push([sql, args]);
      if (mode === 'price' && sql.includes('INSERT INTO route_quotation_prices')) throw new Error('synthetic price 901 postgresql://private');
      if (mode === 'concurrent' && sql.includes('UPDATE route_quotation_lines')) return { rowCount: 0 };
      return db.client.query(sql, args);
    } };
    await assert.rejects(db.sync([cells('12345', '01/01/2000', 901)], { client }),
      { message: mode === 'price' ? 'quotation_sync_failed' : 'quotation_sync_concurrent_modification' });
    assert.equal(queries[0][0], 'BEGIN');
    assert.deepEqual(queries[1], ['SELECT pg_advisory_xact_lock(hashtext($1))', ['nc:quotation-sync:' + sourceRef]]);
    assert.equal(queries.at(-1)[0], 'ROLLBACK');
    assert.deepEqual(await db.state(), before);
  }
  assert.equal((await db.sync([cells('12345', '01/01/2000', 902)])).result, 'completed');
});
