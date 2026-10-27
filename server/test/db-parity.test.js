import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbSkip } from './db-helpers.js';
import { centralFixture } from './central-db-fixtures.js';
import { importJson } from '../src/db/json-import.js';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { createJsonDataSource } from '../src/store/data-source.js';
import { compareDataSources } from '../src/db/parity.js';
import { startApiServer } from '../src/api/server.js';
import { fileURLToPath } from 'node:url';
import { runParity } from '../bin/db-parity.js';
import { defaultDistrictsPath } from '../src/store/districts-file.js';

test('parity CLI supplies repository defaults and allows fixture path overrides without a database', async t => {
  const fixture = await centralFixture(t);
  for (const overrides of [{}, { geoDir: fixture.geoDir, districtsPath: fixture.districtsPath }]) {
    let closed = false, compared = false;
    const dbSource = { close: async () => { closed = true; } };
    const exitCode = await runParity({
      env: { RUNTIME_DATA_DIR: fixture.runtimeDir }, ...overrides,
      createDbSource: () => dbSource,
      compare: async options => {
        compared = true;
        assert.equal(options.geoDir, overrides.geoDir ?? fileURLToPath(new URL('../../geo/', import.meta.url)));
        assert.equal(options.districtsPath, overrides.districtsPath ?? defaultDistrictsPath);
        assert.equal(options.runtimeDir, fixture.runtimeDir);
        assert.equal(options.dbSource, dbSource);
        assert.deepEqual(await options.jsonSource.readRouteProfiles(), fixture.profiles);
        return { exitCode: 0 };
      },
      errorLog: () => assert.fail('Successful comparison must not log an error'),
    });
    assert.equal(exitCode, 0);
    assert.ok(compared); assert.ok(closed);
  }
});

test('parity CLI reports only error type and safe code, returns 1 and closes its source', async t => {
  const fixture = await centralFixture(t);
  for (const code of ['ERR_INVALID_ARG_TYPE', undefined, '', 'unsafe/message', 'A'.repeat(41)]) {
    const logs = []; let closed = false;
    const error = new TypeError('Private driver message must not be logged');
    error.code = code;
    const exitCode = await runParity({ env: { RUNTIME_DATA_DIR: fixture.runtimeDir },
      createDbSource: () => ({ close: async () => { closed = true; } }),
      compare: async () => { throw error; }, errorLog: message => logs.push(message),
    });
    assert.equal(exitCode, 1); assert.ok(closed);
    assert.deepEqual(logs, [`对照失败（TypeError${code === 'ERR_INVALID_ARG_TYPE' ? ' / ERR_INVALID_ARG_TYPE' : ''}），请检查本地数据和数据库配置。`]);
  }
});

test('CD-AC20/21 fixture HTTP parity includes history, unassigned district, ZIP states and detects differences', { skip: dbSkip }, async t => {
  const db = await createTestDb(t), fixture = await centralFixture(t);
  await importJson({ ...fixture, client: db.scraper });
  const dbSource = createDbDataSource({ schema: db.schema, env: { NC_DB_READER_URL: process.env.NC_TEST_DB_READER_URL } });
  t.after(() => dbSource.close());
  const jsonSource = createJsonDataSource(fixture), logs = [];
  const compare = () => compareDataSources({ ...fixture, jsonSource, dbSource, log: message => logs.push(message) });
  const result = await compare();
  assert.equal(result.exitCode, 0); assert.deepEqual(result.mismatches, []);
  assert.equal(result.counts.details.total, 2); assert.equal(result.counts.district_maps.total, 2);
  for (const dataSource of [jsonSource, dbSource]) {
    const server = await startApiServer({ ...fixture, dataSource, port: 0 });
    try {
      const request = async pathname => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`); return { status: res.status, body: await res.json() };
      };
      const profiles = await request('/api/route-profiles?station=AAA01');
      assert.equal(profiles.status, 200); assert.ok(profiles.body.rows.every(row => !Object.hasOwn(row, 'raw')));
      for (const [zip, status] of [['00123', 'covered'], ['00002', 'multi_station'], ['00009', 'uncovered'], ['99999', 'out_of_range']])
        assert.equal((await request(`/api/route-map/zip?postal_code=${zip}`)).body.status, status);
      assert.equal((await request('/api/route-details?route_id=831')).status, 200);
      assert.equal((await request('/api/route-profiles?station=MISSING')).status, 404);
      assert.equal((await request('/api/route-details?route_id=bad')).status, 400);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  }
  // Owner changes synthetic data only, to prove parity returns code 1 and paths without bodies.
  await db.owner.query("UPDATE station_snapshots SET fetched_at='mock-difference' WHERE station_code='AAA01'");
  const changed = await compare(); assert.equal(changed.exitCode, 1);
  assert.ok(changed.mismatches.includes('/api/route-profiles?station=AAA01'));
  assert.doesNotMatch(logs.join('\n'), /mock-difference|capacity_raw|"rows"/);
});
