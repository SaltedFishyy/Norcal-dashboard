import test from 'node:test';
import assert from 'node:assert/strict';
import { readLarkQuotationConfig } from '../src/quotations/lark-config.js';
import { LarkError } from '../src/quotations/lark-client.js';
import { runLarkQuotationSync, runLarkQuotationSheets, columnLetters } from '../src/quotations/lark-sync.js';
import { runLarkCommand } from '../src/quotations/lark-cli.js';
import { applyQuotationSync } from '../src/quotations/quotation-sync-db.js';
import { sfoHeader, summaryHeader, syntheticCells } from './lark-quotation-fixtures.js';
import { createTestDb, dbSkip } from './db-helpers.js';

const env = { LARK_APP_ID: 'fake', LARK_APP_SECRET: 'SECRET-SENTINEL-123',
  LARK_QUOTATION_SPREADSHEET_TOKEN: 'fake-book', LARK_QUOTATION_SHEET_ID: 'uAaPvG' };
const config = readLarkQuotationConfig(env);
const fake = (values = [...sfoHeader, syntheticCells()]) => ({
  querySheets: async () => [{ sheetId: 'uAaPvG', title: 'Mock', rowCount: 427, columnCount: 30 }],
  readValues: async (_book, range) => { assert.equal(range, 'uAaPvG!A1:AD427'); return { values, revision: 7 }; }
});
test('Lark sync missing sheet, oversized sheet, invalid header and fetch errors', async () => {
  for (const [sheets, kind] of [[[], 'not_found'], [[{ sheetId: 'uAaPvG', rowCount: 5001 }], 'sheet_too_large']]) {
    const result = await runLarkQuotationSync({ config, larkClient: { querySheets: async () => sheets } });
    assert.equal(result.result, 'fetch_failed'); assert.equal(result.errorKind, kind); assert.equal(result.stage, 'sheet_query');
    assert.ok(result.finishedAt);
  }
  const invalid = await runLarkQuotationSync({ config, larkClient: fake(summaryHeader) });
  assert.equal(invalid.result, 'header_invalid'); assert.ok(invalid.missingColumns.includes('effective_from'));
  const failed = await runLarkQuotationSync({ config, larkClient: { querySheets: async () => { throw new LarkError('token', 'credentials', 200, 7); } } });
  assert.equal(failed.result, 'fetch_failed'); assert.equal(failed.larkCode, 7);
  assert.equal(columnLetters(30), 'AD'); assert.equal(columnLetters(703), 'AAA');
});
test('Lark dry run falls back only for unavailable scope and never starts a transaction', async () => {
  for (const code of ['42501', '42P01']) {
    const queries = [];
    const readerClient = { query: async sql => {
      queries.push(sql);
      if (sql.includes('v_active_routes')) return { rows: [{ route_id: 1, route_name: 'Mock Route', station_code: 'ZZZ01', profile: { postal_codes: ['12345'] } }] };
      throw Object.assign(new Error('ECHO-SENTINEL'), { code });
    } };
    const result = await runLarkQuotationSync({ config, larkClient: fake(), readerClient, dryRun: true });
    assert.equal(result.counts.inserted, 1); assert.deepEqual(result.notes, ['scope_unavailable']);
    assert.ok(!JSON.stringify(result).includes('SENTINEL')); assert.ok(!JSON.stringify(result).includes('900'));
    assert.ok(queries.every(sql => !/BEGIN|INSERT|UPDATE/.test(sql)));
  }
  await assert.rejects(runLarkQuotationSync({ config, larkClient: fake(), dryRun: true,
    readerClient: { query: async () => { throw Object.assign(new Error('private'), { code: '08006' }); } } }), { code: '08006' });
});
test('Lark commands refuse missing writer before any connection and sanitize failures', async () => {
  const outputs = []; let connected = false;
  assert.equal(await runLarkCommand({ env: { ...env, NC_DB_OWNER_URL: 'unused', NC_DB_READER_URL: 'unused' },
    log: value => outputs.push(value), connect: async () => { connected = true; }, makeClient: () => { throw new Error('must not run'); } }), 1);
  assert.equal(connected, false); assert.deepEqual(outputs, ['NC_DB_QUOTATION_URL required']);
  outputs.length = 0;
  assert.equal(await runLarkCommand({ check: true, env, log: value => outputs.push(value), makeClient: () => fake(),
    connect: () => { throw new Error('must not connect'); } }), 0);
  assert.equal(JSON.parse(outputs[0]).sheets[0].dataRows, 1);
  assert.ok(!outputs.join('').includes('900')); assert.ok(!outputs.join('').includes('SENTINEL'));
  outputs.length = 0;
  await runLarkCommand({ env: { ...env, NC_DB_QUOTATION_URL: 'unused' }, log: value => outputs.push(value), makeClient: () => fake(),
    connect: async () => { throw Object.assign(new Error('SECRET-SENTINEL-123'), { code: '23505' }); } });
  assert.deepEqual(JSON.parse(outputs[0]), { result: 'quotation_sync_failed', sqlstate: '23505' });
  outputs.length = 0;
  await runLarkCommand({ check: true, env, log: value => outputs.push(value), makeClient: () => ({
    querySheets: async () => { throw new LarkError('sheet_query', 'permission', 403, 7); }
  }) });
  assert.deepEqual(JSON.parse(outputs[0]), { sheets: [{ sheet: { sheetId: 'uAaPvG' }, connected: false, stage: 'sheet_query', errorKind: 'permission' }] });
});
test('Lark dry-run command uses only reader and optional dedicated writer and closes both', async () => {
  const calls = [], closed = [], outputs = [];
  const connect = async variable => {
    calls.push(variable);
    return { query: async sql => {
      if (sql.includes('v_active_routes')) return { rows: [] };
      return { rows: [] };
    }, end: async () => { closed.push(variable); } };
  };
  assert.equal(await runLarkCommand({ args: ['--dry-run'], env: { ...env, NC_DB_READER_URL: 'unused', NC_DB_QUOTATION_URL: 'unused' },
    log: value => outputs.push(value), connect, makeClient: () => fake() }), 1);
  assert.deepEqual(calls, ['NC_DB_READER_URL', 'NC_DB_QUOTATION_URL']); assert.deepEqual(closed, calls);
  const output = JSON.parse(outputs[0]);
  assert.equal(output.result, 'failed'); assert.equal(output.sheets[0].rejected[0].reason, 'route_not_found');
  assert.ok(!outputs.join('').includes('900')); assert.ok(!outputs.join('').includes('SENTINEL'));
});
test('Lark DB wrapper retains only SQLSTATE', async () => {
  await assert.rejects(applyQuotationSync({ client: { query: async () => {
    throw Object.assign(new Error('ECHO-SENTINEL'), { code: '23505', detail: 'SECRET-SENTINEL-123' });
  } } }), error => {
    assert.equal(error.message, 'quotation_sync_failed'); assert.equal(error.code, '23505');
    assert.equal(error.cause, undefined); assert.equal(error.detail, undefined);
    assert.ok(!String(error).includes('SENTINEL')); return true;
  });
});
test('Lark sync test DB reader fallback and owner write integration', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  await db.owner.query("INSERT INTO known_stations(code) VALUES ('ZZZ01') ON CONFLICT DO NOTHING");
  await db.owner.query("INSERT INTO stations(code) VALUES ('ZZZ01')");
  const run = (await db.owner.query(`INSERT INTO scrape_runs(id,trigger,status,requested_stations,options,started_at)
    VALUES(gen_random_uuid(),'json_import','completed',ARRAY['ZZZ01'],'{}',now()) RETURNING id`)).rows[0].id;
  const snapshot = (await db.owner.query(`INSERT INTO station_snapshots(station_code,run_id,status,origin,fetched_at,source,total)
    VALUES('ZZZ01',$1,'active','json_import','synthetic','synthetic',1) RETURNING id`, [run])).rows[0].id;
  await db.owner.query(`INSERT INTO snapshot_routes(snapshot_id,route_id,ordinal,route_name,profile)
    VALUES($1,1,0,'Mock Route','{"postal_codes":["12345"]}')`, [snapshot]);
  const preview = await runLarkQuotationSync({ config, larkClient: fake(), readerClient: db.reader, dryRun: true });
  assert.deepEqual(preview.notes, ['scope_unavailable']); assert.equal(preview.counts.inserted, 1);
  assert.equal((await db.owner.query('SELECT count(*) FROM route_quotation_imports')).rows[0].count, '0');
  const applied = await runLarkQuotationSync({ config, larkClient: fake(), writeClient: db.owner });
  assert.equal(applied.result, 'completed'); assert.ok(applied.importId);
  const unchanged = await runLarkQuotationSync({ config, larkClient: fake(), readerClient: db.reader, writeClient: db.owner, dryRun: true });
  assert.equal(unchanged.result, 'unchanged'); assert.deepEqual(unchanged.notes, []);
});

test('multi sheet serial isolation, query once, safe database errors and aggregation', async () => {
  let queries = 0, active = 0;
  const events = [];
  const larkClient = { querySheets: async () => { queries++; return ['A', 'B', 'C'].map(sheetId => ({ sheetId, title: sheetId, rowCount: 4, columnCount: 23 })); },
    readValues: async (_, range) => {
      assert.equal(active++, 0); events.push(range[0]); await Promise.resolve(); active--;
      if (range.startsWith('B!')) throw new LarkError('values', 'permission');
      return { values: sfoHeader };
    } };
  const readerClient = { query: async () => ({ rows: [] }) };
  const result = await runLarkQuotationSheets({ config: { ...config, sheetIds: ['A', 'B', 'C'] }, larkClient, readerClient, dryRun: true });
  assert.equal(queries, 1); assert.deepEqual(events, ['A', 'B', 'C']);
  assert.equal(result.result, 'partial_failure'); assert.deepEqual(result.sheets.map(s => s.result), ['unchanged', 'fetch_failed', 'unchanged']);
  assert.equal((await runLarkQuotationSheets({ config: { ...config, sheetIds: ['B'] }, larkClient })).result, 'failed');
  let failed = false;
  const writeClient = { query: async sql => {
    if (sql.includes('v_active_routes') && !failed) { failed = true; throw Object.assign(new Error('PRIVATE-SENTINEL'), { code: '42501' }); }
    return { rows: [] };
  } };
  const isolated = await runLarkQuotationSheets({ config: { ...config, sheetIds: ['A', 'C'] }, larkClient, writeClient });
  assert.deepEqual(isolated.sheets.map(s => s.result), ['db_failed', 'unchanged']);
  assert.equal(isolated.result, 'partial_failure'); assert.doesNotMatch(JSON.stringify(isolated), /PRIVATE-SENTINEL/);
  assert.equal((await runLarkQuotationSheets({ config: { ...config, sheetIds: ['A', 'C'] }, larkClient, writeClient })).result, 'unchanged');

});

test('multi sheet test DB isolates sources, transactions, conflicts and failed headers', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  await db.owner.query("INSERT INTO known_stations(code) VALUES ('ZZZ01') ON CONFLICT DO NOTHING");
  await db.owner.query("INSERT INTO stations(code) VALUES ('ZZZ01')");
  const run = (await db.owner.query(`INSERT INTO scrape_runs(id,trigger,status,requested_stations,options,started_at)
    VALUES(gen_random_uuid(),'json_import','completed',ARRAY['ZZZ01'],'{}',now()) RETURNING id`)).rows[0].id;
  const snapshot = (await db.owner.query(`INSERT INTO station_snapshots(station_code,run_id,status,origin,fetched_at,source,total)
    VALUES('ZZZ01',$1,'active','json_import','synthetic','synthetic',1) RETURNING id`, [run])).rows[0].id;
  await db.owner.query(`INSERT INTO snapshot_routes(snapshot_id,route_id,ordinal,route_name,profile)
    VALUES($1,1,0,'Mock Route','{"postal_codes":["12345","12346"]}')`, [snapshot]);
  let invalidA = false, conflict = false;
  const larkClient = { querySheets: async () => ['A', 'B'].map(sheetId => ({ sheetId, rowCount: 4, columnCount: 23 })),
    readValues: async (_, range) => {
      if (invalidA && range.startsWith('A!')) return { values: [['invalid']] };
      const row = syntheticCells(); if (range.startsWith('B!') && !conflict) row[3] = '12346';
      return { values: [...sfoHeader, row] };
    } };
  const options = { config: { ...config, sheetIds: ['A', 'B'] }, larkClient, writeClient: db.owner };
  assert.equal((await runLarkQuotationSheets(options)).result, 'completed');
  assert.equal((await db.owner.query('SELECT count(DISTINCT source_ref) FROM route_quotation_imports')).rows[0].count, '2');
  invalidA = true;
  const partial = await runLarkQuotationSheets(options);
  assert.equal(partial.result, 'partial_failure'); assert.equal(partial.sheets[1].result, 'unchanged');
  assert.equal((await db.owner.query('SELECT count(*) FROM route_quotation_lines WHERE voided_at IS NULL')).rows[0].count, '2');
  conflict = true;
  const rejected = await runLarkQuotationSheets(options);
  assert.equal(rejected.sheets[1].rejected[0].reason, 'conflict_other_source');
});

test('CLI sheet selection accepts dry run outside whitelist and rejects writes', async () => {
  const output = [];
  assert.equal(await runLarkCommand({ args: ['--sheet', 'Other'], env: { ...env, NC_DB_QUOTATION_URL: 'unused' }, log: v => output.push(v) }), 1);
  assert.deepEqual(output, ['invalid_arguments']);
  output.length = 0;
  await runLarkCommand({ args: ['--dry-run', '--sheet', 'Other'], env, log: v => output.push(v), makeClient: () => fake(),
    connect: async () => ({ end: async () => {}, query: async () => ({ rows: [] }) }) });
  const summary = JSON.parse(output[0]); assert.equal(summary.sheets[0].sheet.sheetId, 'Other'); assert.equal(summary.result, 'failed');
});
