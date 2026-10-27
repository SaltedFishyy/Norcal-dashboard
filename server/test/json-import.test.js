import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDb, dbSkip } from './db-helpers.js';
import { centralFixture } from './central-db-fixtures.js';
import { importJson, JsonImportError } from '../src/db/json-import.js';

test('CD-AC19 transactional import preserves source, history, links, ordinal and file bytes', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), fixture = await centralFixture(t);
  const files = ['route-profiles.json', 'route-details.json'].map(name => path.join(fixture.runtimeDir, name));
  const before = await Promise.all(files.map(file => readFile(file)));
  assert.deepEqual(await importJson({ ...fixture, client: db.scraper }), { stations: 2, routes: 103, details: 2 });
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
  const snapshots = (await db.scraper.query('SELECT * FROM station_snapshots')).rows;
  for (const snapshot of snapshots) {
    const original = fixture.profiles.stations[snapshot.station_code];
    for (const key of ['fetched_at', 'source_as_of', 'source', 'total']) assert.deepEqual(snapshot[key], original[key]);
    assert.equal(snapshot.status, 'active'); assert.equal(snapshot.origin, 'json_import');
    const rows = (await db.scraper.query('SELECT * FROM snapshot_routes WHERE snapshot_id=$1 ORDER BY ordinal', [snapshot.id])).rows;
    assert.deepEqual(rows.map(row => row.profile), original.rows);
    for (const row of rows) assert.equal(row.detail_version_id !== null, row.route_id === '1');
  }
  const run = (await db.scraper.query('SELECT * FROM scrape_runs')).rows[0];
  assert.equal(run.trigger, 'json_import'); assert.equal(run.status, 'completed');
  assert.deepEqual(run.requested_stations, ['ZZZ01', 'AAA01']); assert.deepEqual(run.options, {});
  assert.equal(run.started_at.toISOString(), run.finished_at.toISOString()); assert.match(run.import_digest, /^[a-f0-9]{64}$/);
  assert.equal((await db.reader.query('SELECT * FROM v_route_details WHERE route_id=831')).rowCount, 1);
  assert.equal((await db.scraper.query('SELECT * FROM snapshot_route_zips WHERE route_id=2')).rowCount, 2);
  await assert.rejects(importJson({ ...fixture, client: db.scraper }), error => error instanceof JsonImportError && /已导入过/.test(error.message));
  fixture.profiles.stations.AAA01.source = 'changed-mock'; await fixture.write();
  await assert.rejects(importJson({ ...fixture, client: db.scraper }), /已有 snapshot/);
  const changed = await Promise.all(files.map(file => readFile(file)));
  await assert.rejects(importJson({ ...fixture, client: db.scraper }), /已有 snapshot/);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), changed);
});

test('CD-AC19 invalid inputs and SQL failure leave all tables empty; legacy missing ZIP retained', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), fixture = await centralFixture(t);
  const original = structuredClone(fixture.profiles);
  for (const mutate of [
    () => fixture.profiles.stations.AAA01.rows[0].postal_codes = ['bad'],
    () => fixture.profiles.stations.AAA01.rows[0].route_id = 'bad',
    () => fixture.profiles.stations.AAA01.rows[0].postal_codes = ['00002'],
    () => fixture.routes.routes['831'].source = 'invalid',
  ]) {
    mutate(); await fixture.write();
    const before = await Promise.all(['route-profiles.json', 'route-details.json'].map(name => readFile(path.join(fixture.runtimeDir, name))));
    await assert.rejects(importJson({ ...fixture, client: db.scraper }), JsonImportError);
    assert.deepEqual(await Promise.all(['route-profiles.json', 'route-details.json'].map(name => readFile(path.join(fixture.runtimeDir, name)))), before);
    assert.equal((await db.scraper.query('SELECT * FROM scrape_runs')).rowCount, 0);
    Object.assign(fixture.profiles, structuredClone(original)); fixture.routes.routes['831'].source = 'dms-playwright';
  }
  // Constraint failure happens after inserts, proving full transaction rollback.
  fixture.profiles.stations.AAA01.rows[0].route_id = null; await fixture.write();
  await assert.rejects(importJson({ ...fixture, client: db.scraper }), JsonImportError);
  for (const table of ['scrape_runs', 'stations', 'station_snapshots', 'route_detail_versions', 'route_detail_zips', 'snapshot_routes', 'snapshot_route_zips'])
    assert.equal((await db.scraper.query(`SELECT * FROM ${table}`)).rowCount, 0);
  Object.assign(fixture.profiles, structuredClone(original));
  delete fixture.profiles.stations.AAA01.rows[0].postal_codes; await fixture.write();
  const before = await readFile(path.join(fixture.runtimeDir, 'route-profiles.json'));
  await importJson({ ...fixture, client: db.scraper });
  assert.equal((await db.scraper.query('SELECT * FROM snapshot_route_zips WHERE route_id=2')).rowCount, 0);
  assert.deepEqual((await db.scraper.query('SELECT profile FROM snapshot_routes WHERE route_id=2')).rows[0].profile, fixture.profiles.stations.AAA01.rows[0]);
  assert.deepEqual(await readFile(path.join(fixture.runtimeDir, 'route-profiles.json')), before);
});
