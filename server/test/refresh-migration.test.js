import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { migrate } from '../src/db/migrate.js';
import { createTestDb, dbSkip } from './db-helpers.js';
import { batchFixture } from './multi-station-fixtures.js';
import { createDbBatchSink } from '../src/db/batch-db-sink.js';
import { connectDb } from '../src/db/connection.js';

test('refresh migration runner orders versions, skips repeated versions and rolls back a failed version', async () => {
  const applied = new Set(), calls = [], results = [];
  const client = { query: async (sql, args) => {
    calls.push(sql);
    if (sql.startsWith('SELECT version')) return { rowCount: applied.has(args[0]) ? 1 : 0 };
    if (sql.startsWith('INSERT INTO')) applied.add(args[0]);
    return {};
  } };
  await migrate(client, { onResult: value => results.push(value) });
  assert.deepEqual(results, [{ version: '001', result: 'applied' }, { version: '002', result: 'applied' }, { version: '003', result: 'applied' }, { version: '004', result: 'applied' }, { version: '005', result: 'applied' }, { version: '006', result: 'applied' }, { version: '007', result: 'applied' }, { version: '008', result: 'applied' }, { version: '009', result: 'applied' }]);
  assert.equal(calls.filter(s => s === 'BEGIN').length, 9); assert.equal(calls.filter(s => s === 'COMMIT').length, 9);
  results.length = 0;
  await migrate(client, { onResult: value => results.push(value) });
  assert.deepEqual(results, [{ version: '001', result: 'skipped' }, { version: '002', result: 'skipped' }, { version: '003', result: 'skipped' }, { version: '004', result: 'skipped' }, { version: '005', result: 'skipped' }, { version: '006', result: 'skipped' }, { version: '007', result: 'skipped' }, { version: '008', result: 'skipped' }, { version: '009', result: 'skipped' }]);
  calls.length = 0;
  await assert.rejects(migrate({ query: async (sql, args) => {
    calls.push(sql);
    if (sql.startsWith('SELECT version')) return { rowCount: args[0] === '001' ? 1 : 0 };
    if (sql.includes('ALTER TABLE scrape_runs')) throw new Error('synthetic');
    return {};
  } }), { message: 'synthetic' });
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('CD-AC33 migration 002 accepts ui, exposes safe counts/scope and denies scraper scope UPDATE', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), results = [];
  await migrate(db.owner, { ...db.options, onResult: value => results.push(value) });
  assert.deepEqual(results, [{ version: '001', result: 'skipped' }, { version: '002', result: 'skipped' }, { version: '003', result: 'skipped' }, { version: '004', result: 'skipped' }, { version: '005', result: 'skipped' }, { version: '006', result: 'skipped' }, { version: '007', result: 'skipped' }, { version: '008', result: 'skipped' }, { version: '009', result: 'skipped' }]);
  assert.deepEqual((await db.owner.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version), ['001', '002', '003', '004', '005', '006', '007', '008', '009']);
  const id = randomUUID(), scope = { type: 'all', district: null, skipped: [{ code: 'MFR01', district: 'first', reason: 'disabled' }] };
  await db.scraper.query(`INSERT INTO scrape_runs (id,trigger,status,requested_stations,options,started_at,scope,json_run_id,app_version,import_digest)
    VALUES ($1,'ui','completed',ARRAY['SFO01'],'{"refresh":false,"private":true}',now(),$2,'private','private','private')`, [id, scope]);
  for (const [index, status] of ['completed', 'limited', 'stopped', 'pending', 'in_progress'].entries())
    await db.scraper.query(`INSERT INTO scrape_run_stations (run_id,station_code,status,success_count,cached_count,failed_count)
      VALUES ($1,$2,$3,0,0,0)`, [id, 'SYN' + String(index).padStart(2, '0'), status]);
  const row = (await db.reader.query('SELECT * FROM v_runs WHERE id=$1', [id])).rows[0];
  assert.deepEqual(row.scope, scope);
  assert.deepEqual(row.counts, { completed: 1, limited: 1, stopped: 1, pending: 1, in_progress: 1, skipped: 1 });
  assert.deepEqual(row.options, { refresh: false });
  for (const key of ['json_run_id', 'app_version', 'import_digest']) assert.ok(!Object.hasOwn(row, key));
  await assert.rejects(db.scraper.query('UPDATE scrape_runs SET scope=scope WHERE id=$1', [id]), { code: '42501' });
  await assert.rejects(db.reader.query('SELECT scope FROM scrape_runs'), { code: '42501' });
});

test('refresh scoped dual batch writes ui trigger and configured skips to DB', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), h = batchFixture();
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'nc-refresh-db-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const districtsPath = path.join(dir, 'districts.json');
  await fs.writeFile(districtsPath, JSON.stringify({ schema_version: 1, districts: [{ id: 'first', name_zh: 'first', name_en: 'first',
    stations: ['SFO01', 'MFR01'], scrape_disabled: { MFR01: 'disabled' } }] }));
  assert.equal(await h.run({ args: ['--scope', 'district:first', '--trigger', 'ui'], districtsPath,
    env: { DMS_BASE_URL: 'https://example.invalid', DB_DUAL_WRITE: '1' },
    dbSinkFactory: metadata => createDbBatchSink({ ...metadata,
      connect: () => connectDb('NC_TEST_DB_SCRAPER_URL', { schema: db.schema }) }) }), 0);
  const row = (await db.reader.query('SELECT trigger,scope FROM v_runs')).rows[0];
  assert.equal(row.trigger, 'ui'); assert.equal(row.scope.district, 'first'); assert.equal(row.scope.skipped[0].code, 'MFR01');
  assert.ok(!h.events.includes('switch:MFR01'));
  assert.deepEqual(h.files.at(-1).record.skipped_by_config, row.scope.skipped);
});
