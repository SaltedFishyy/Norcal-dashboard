import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { centralFixture } from './central-db-fixtures.js';
import { sfoHeader, syntheticCells } from './lark-quotation-fixtures.js';
import { LarkError } from '../src/quotations/lark-client.js';
import { runScheduledQuotationSync } from '../src/quotations/quotation-sync-job.js';

const env = { LARK_APP_ID: 'fake', LARK_APP_SECRET: 'SECRET-SENTINEL',
  LARK_QUOTATION_SPREADSHEET_TOKEN: 'TOKEN-SENTINEL', LARK_QUOTATION_SHEET_ID: 'mock', NC_DB_QUOTATION_URL: 'WRITER-SENTINEL' };
const fakeLark = values => ({ querySheets: async () => [{ sheetId: 'mock', rowCount: 10, columnCount: 23 }],
  readValues: async () => ({ values, revision: 'TOKEN-SENTINEL' }) });

test('scheduled quotation config and missing writer never connect or call Lark', async t => {
  const f = await centralFixture(t);
  const base = { runtimeDir: f.runtimeDir, connect: () => assert.fail('no connection'), larkClientFactory: () => assert.fail('no Lark') };
  let result = await runScheduledQuotationSync({ ...base, env: {} });
  assert.equal(result.last_attempt.result, 'config_invalid');
  assert.ok(result.last_attempt.notes.includes('LARK_APP_SECRET'));
  result = await runScheduledQuotationSync({ ...base, env: { ...env, LARK_OPEN_API_BASE: 'http://invalid' } });
  assert.deepEqual(result.last_attempt.notes, ['LARK_OPEN_API_BASE']);
  result = await runScheduledQuotationSync({ ...base, env: { ...env, NC_DB_QUOTATION_URL: '', NC_DB_OWNER_URL: 'unused', NC_DB_READER_URL: 'unused' } });
  assert.equal(result.last_attempt.result, 'write_role_missing'); assert.equal(result.last_success, null);
});

test('scheduled quotation uses writer only, preserves success on failures and strips private data', async t => {
  const f = await centralFixture(t), connections = [], queries = []; let ended = 0;
  const cells = syntheticCells(); cells[5] = 987.65;
  const options = { env, runtimeDir: f.runtimeDir, now: () => new Date('2026-11-06T12:00:00Z'),
    connect: async variable => {
      connections.push(variable);
      return { end: async () => { ended++; }, query: async sql => {
        queries.push(sql);
        if (sql.includes('v_active_routes')) return { rows: [{ route_id: 1, route_name: 'Mock Route', station_code: 'MOCK1', profile: { postal_codes: ['12345'] } }] };
        if (sql.includes('RETURNING id')) return { rows: [{ id: '42' }] };
        return { rows: [], rowCount: 1 };
      } };
    }, larkClientFactory: () => fakeLark([...sfoHeader, cells]) };
  let result = await runScheduledQuotationSync(options);
  assert.equal(result.last_attempt.result, 'completed'); assert.equal(result.last_success.import_id, '42');
  assert.equal(result.last_success.counts.inserted, 1); assert.equal(ended, 1);
  assert.deepEqual(connections, ['NC_DB_QUOTATION_URL']); assert.ok(queries.includes('COMMIT'));
  const success = result.last_success;
  for (const [factory, expected] of [
    [() => ({ querySheets: async () => { throw new LarkError('values', 'permission', 403, 7); } }), 'fetch_failed'],
    [() => fakeLark([['invalid']]), 'header_invalid'],
  ]) {
    result = await runScheduledQuotationSync({ ...options, larkClientFactory: factory });
    assert.equal(result.last_attempt.result, expected); assert.deepEqual(result.last_success, success);
  }
  result = await runScheduledQuotationSync({ ...options, connect: async () => { throw Object.assign(new Error('SECRET-SENTINEL'), { code: '42501' }); } });
  assert.equal(result.last_attempt.result, 'db_failed'); assert.equal(result.last_attempt.db_code, '42501');
  assert.deepEqual(result.last_success, success);
  const invalid = syntheticCells(); invalid[5] = 0;
  result = await runScheduledQuotationSync({ ...options, larkClientFactory: () => fakeLark([...sfoHeader, cells, invalid]) });
  assert.equal(result.last_attempt.result, 'partial'); assert.equal(result.last_attempt.rejected_count, 1);
  assert.equal(result.last_success.result, 'partial');
  result = await runScheduledQuotationSync({ ...options, larkClientFactory: () => fakeLark(sfoHeader) });
  assert.equal(result.last_attempt.result, 'unchanged'); assert.equal(result.last_success.result, 'unchanged');
  const failedQueries = [];
  result = await runScheduledQuotationSync({ ...options, connect: async () => ({ end: async () => {}, query: async sql => {
    failedQueries.push(sql);
    if (sql.includes('v_active_routes')) throw Object.assign(new Error('SECRET-SENTINEL'), { code: '42501' });
    return { rows: [] };
  } }) });
  assert.equal(result.last_attempt.result, 'db_failed'); assert.equal(result.last_attempt.db_code, '42501');
  assert.ok(failedQueries.includes('ROLLBACK')); assert.ok(!failedQueries.some(sql => /INSERT|UPDATE|COMMIT/.test(sql)));
  assert.equal(result.last_success.result, 'unchanged');
  const text = await readFile(path.join(f.runtimeDir, 'quotation-sync-status.json'), 'utf8');
  assert.doesNotMatch(text, /SECRET-SENTINEL|TOKEN-SENTINEL|WRITER-SENTINEL|987\.65|Mock Route|rejected"\s*:\s*\[/);
  // Even existing status files are projected before being carried forward.
  await writeFile(path.join(f.runtimeDir, 'quotation-sync-status.json'), JSON.stringify({ ...result,
    last_success: { ...success, token: 'TOKEN-SENTINEL', counts: { ...success.counts, price: 987.65 } } }));
  result = await runScheduledQuotationSync({ ...options, env: {} });
  assert.deepEqual(result.last_success, success);
});
