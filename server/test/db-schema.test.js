import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { dbConfig } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { createTestDb, dbSkip } from './db-helpers.js';

const tables = ['schema_migrations', 'stations', 'scrape_runs', 'scrape_run_stations', 'station_snapshots',
  'snapshot_routes', 'snapshot_route_zips', 'route_detail_versions', 'route_detail_zips'];
const views = ['v_active_snapshots', 'v_active_routes', 'v_route_details', 'v_route_detail_zips', 'v_runs'];
const denied = (client, sql, params = []) => assert.rejects(client.query(sql, params), { code: '42501' });
const runSql = `INSERT INTO scrape_runs (id, trigger, status, requested_stations, options, started_at, import_digest)
  VALUES ($1, 'cli', $2, ARRAY['TST01'], '{"refresh":false,"new_run":true,"max_routes_per_station":1,"private":true}', now(), 'synthetic-digest')`;
const snapshotSql = `INSERT INTO station_snapshots (station_code, run_id, status, origin, fetched_at, source, total)
  VALUES ('TST01', $1, $2, 'dms', 'synthetic-time', 'dms-playwright', 1) RETURNING id`;

test('DB config: missing and invalid values produce fixed safe errors', () => {
  for (const value of [undefined, '', 'invalid', 'https://invalid.example', 'postgres:///']) {
    assert.throws(() => dbConfig('URL', { env: { URL: value } }),
      { message: '数据库连接配置缺失或无效，请检查本地环境变量。' });
  }
});

test('CD-AC11: migration, constraints and indexes', { skip: dbSkip }, async t => {
  const db = await createTestDb(t);
  assert.deepEqual(db.firstMigration, { version: '001', result: 'applied' });
  assert.deepEqual(await migrate(db.owner, db.options), { version: '001', result: 'skipped' });
  const failedSchema = `${db.schema}_"rollback`;
  await assert.rejects(migrate(db.owner, { ...db.options, schema: failedSchema, readerRole: `${db.schema}_missing` }),
    { code: '42704' });
  assert.equal((await db.owner.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [failedSchema])).rowCount, 0);
  const objects = await db.owner.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1`, [db.schema]);
  for (const name of [...tables, ...views, 'one_running_run', 'one_active_per_station'])
    assert.ok(objects.rows.some(row => row.relname === name), name);
  const indexes = await db.owner.query('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname=$1', [db.schema]);
  for (const name of ['one_running_run', 'one_active_per_station']) {
    const index = indexes.rows.find(row => row.indexname === name);
    assert.match(index.indexdef, /UNIQUE INDEX/);
    assert.match(index.indexdef, /WHERE/);
  }
  await assert.rejects(db.owner.query("INSERT INTO stations(code) VALUES ('invalid')"), { code: '23514' });
  const run = randomUUID();
  await assert.rejects(db.owner.query(runSql, [run, 'invalid']), { code: '23514' });
  await db.owner.query(runSql, [run, 'running']);
  await assert.rejects(db.owner.query(runSql, [randomUUID(), 'running']), { code: '23505' });
  await assert.rejects(db.owner.query("UPDATE scrape_runs SET trigger='invalid'"), { code: '23514' });
  await db.owner.query("INSERT INTO stations(code) VALUES ('TST01')");
  await assert.rejects(db.owner.query(snapshotSql, [run, 'invalid']), { code: '23514' });
  const snapshot = (await db.owner.query(snapshotSql, [run, 'active'])).rows[0].id;
  await assert.rejects(db.owner.query(snapshotSql, [run, 'active']), { code: '23505' });
  await assert.rejects(db.owner.query("UPDATE station_snapshots SET origin='invalid'"), { code: '23514' });
  await db.owner.query(`INSERT INTO snapshot_routes VALUES ($1, 1, 0, 'synthetic', '{}', NULL)`, [snapshot]);
  await assert.rejects(db.owner.query('INSERT INTO snapshot_route_zips VALUES ($1, 1, $2, 0)', [snapshot, '1234']), { code: '23514' });
  await assert.rejects(db.owner.query(`INSERT INTO scrape_run_stations (run_id,station_code,status,success_count,cached_count,failed_count)
    VALUES ($1,'TST01','invalid',0,0,0)`, [run]), { code: '23514' });
  await db.owner.query(`INSERT INTO route_detail_versions (route_id,station_code,run_id,origin,status,fetched_at,detail)
    VALUES (1,'TST01',$1,'dms','pending','synthetic','{}')`, [run]);
  for (const column of ['status', 'origin'])
    await assert.rejects(db.owner.query(`UPDATE route_detail_versions SET ${column}='invalid'`), { code: '23514' });
});

test('CD-AC12/13: actual reader and scraper privileges, sanitized latest views', { skip: dbSkip }, async t => {
  const { owner, scraper, reader, schema } = await createTestDb(t);
  const run = randomUUID();
  await scraper.query("INSERT INTO stations(code) VALUES ('TST01')");
  await scraper.query(runSql, [run, 'running']);
  const snapshot = (await scraper.query(snapshotSql, [run, 'pending'])).rows[0].id;
  await scraper.query(`INSERT INTO scrape_run_stations (run_id,station_code,status,success_count,cached_count,failed_count)
    VALUES ($1,'TST01','pending',0,0,0)`, [run]);
  const detailSql = `INSERT INTO route_detail_versions (route_id,station_code,run_id,origin,status,fetched_at,detail)
    VALUES (1,'TST01',$1,'dms',$2,'synthetic', $3) RETURNING id`;
  const first = (await scraper.query(detailSql, [run, 'pending', { capacity_raw: 'synthetic', marker: 'old' }])).rows[0].id;
  await scraper.query(`INSERT INTO snapshot_routes VALUES ($1,1,0,'synthetic',$2,$3)`,
    [snapshot, { raw: { synthetic: true }, postal_codes: ['00123'] }, first]);
  await scraper.query("INSERT INTO snapshot_route_zips VALUES ($1,1,'00123',0)", [snapshot]);
  await scraper.query('INSERT INTO route_detail_zips VALUES ($1,0,$2,$3)', [first, '00123', { raw: 'synthetic', marker: 'old' }]);
  assert.equal((await reader.query('SELECT * FROM v_route_details')).rowCount, 0);
  assert.equal((await reader.query('SELECT * FROM v_active_routes')).rowCount, 0);
  await scraper.query('UPDATE stations SET active_snapshot_id=$1', [snapshot]);
  await scraper.query(`UPDATE scrape_run_stations SET status='completed',route_total=1,success_count=1,cached_count=0,
    failed_count=0,request_count=1,started_at=now(),ended_at=now(),stop_reason=NULL,integrity='{}',snapshot_id=$1`, [snapshot]);
  await scraper.query("UPDATE station_snapshots SET status='active',activated_at=now(),superseded_at=NULL,rejected_reason=NULL");
  await scraper.query("UPDATE route_detail_versions SET status='committed',committed_at='2026-01-01T00:00:00Z'");
  const latest = (await scraper.query(detailSql, [run, 'committed', { capacity_raw: 'synthetic', marker: 'latest' }])).rows[0].id;
  await scraper.query("UPDATE route_detail_versions SET committed_at='2026-01-01T00:00:00Z' WHERE id=$1", [latest]);
  await scraper.query('INSERT INTO route_detail_zips VALUES ($1,0,$2,$3)', [latest, '00123', { raw: 'synthetic', marker: 'latest' }]);
  const older = (await scraper.query(detailSql, [run, 'committed', { marker: 'older timestamp' }])).rows[0].id;
  await scraper.query("UPDATE route_detail_versions SET committed_at='2025-01-01T00:00:00Z' WHERE id=$1", [older]);
  await scraper.query(detailSql, [run, 'pending', { marker: 'pending' }]);
  await scraper.query(`UPDATE scrape_runs SET status='completed',finished_at=now(),prod_api_requests=1,
    request_cap=10,stop_reason=NULL,original_station_restored=true`);
  for (const table of tables) {
    await scraper.query(`SELECT * FROM ${table}`);
    await denied(reader, `SELECT * FROM ${table}`);
    await denied(reader, `INSERT INTO ${table} DEFAULT VALUES`);
    const column = (await owner.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position LIMIT 1', [schema, table])).rows[0].column_name;
    await denied(reader, `UPDATE ${table} SET ${pg.escapeIdentifier(column)}=${pg.escapeIdentifier(column)}`);
    await denied(reader, `DELETE FROM ${table}`);
    await denied(scraper, `DELETE FROM ${table}`);
    await denied(scraper, `TRUNCATE ${table}`);
    await denied(scraper, `ALTER TABLE ${table} ADD COLUMN forbidden int`);
    await denied(scraper, `DROP TABLE ${table}`);
  }
  await denied(scraper, 'CREATE TABLE forbidden(id int)');
  await denied(reader, 'CREATE TABLE forbidden(id int)');
  await denied(scraper, 'INSERT INTO schema_migrations(version) VALUES (\'forbidden\')');
  // Verify every column against the exact allowed UPDATE list, including empty tables.
  const allowed = {
    stations: ['active_snapshot_id'],
    scrape_runs: ['status','finished_at','prod_api_requests','request_cap','stop_reason','original_station_restored'],
    scrape_run_stations: ['status','route_total','success_count','cached_count','failed_count','request_count','started_at','ended_at','stop_reason','integrity','snapshot_id'],
    station_snapshots: ['status','activated_at','superseded_at','rejected_reason'],
    route_detail_versions: ['status','committed_at'],
  };
  for (const table of tables) {
    const columns = await owner.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [schema, table]);
    for (const { column_name: column } of columns.rows) {
      const sql = `UPDATE ${table} SET ${pg.escapeIdentifier(column)}=${pg.escapeIdentifier(column)} WHERE false`;
      if (allowed[table]?.includes(column)) await scraper.query(sql);
      else await denied(scraper, sql);
    }
  }
  for (const view of views) {
    const result = await reader.query(`SELECT * FROM ${view}`);
    assert.ok(result.rowCount > 0, view);
    const serialized = JSON.stringify(result.rows);
    for (const field of ['raw','capacity_raw','import_digest']) assert.ok(!serialized.includes(`"${field}"`), view);
  }
  assert.equal((await reader.query('SELECT detail FROM v_route_details')).rows[0].detail.marker, 'latest');
  assert.equal((await reader.query('SELECT zip FROM v_route_detail_zips')).rows[0].zip.marker, 'latest');
  assert.deepEqual((await reader.query('SELECT options FROM v_runs')).rows[0].options,
    { refresh: false, new_run: true, max_routes_per_station: 1 });
});
