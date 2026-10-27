import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWarehouses, WarehousePrivilegeError } from '../src/warehouses/warehouse-setup.js';
import { runServer } from '../bin/server.js';
import { runWorker } from '../bin/worker.js';
import { centralFixture } from './central-db-fixtures.js';
import { createWorkerServer } from '../src/worker/worker.js';
import { createJsonDataSource } from '../src/store/data-source.js';

test('WH setup privilege grading and connection failures are sanitized; excessive privileges fail closed', async () => {
  for (const problems of [[], ['missing_warehouse_privilege'], ...['superuser', 'role_attribute', 'role_membership',
    'owns_objects', 'schema_create', 'database_create', 'database_temp', 'extra_warehouse_privilege',
    'other_relation_write', 'sequence_privilege'].map(code => ['missing_warehouse_privilege', code])]) {
    let closed = 0; const logs = [];
    const options = { env: { DATA_SOURCE: 'db', NC_DB_WAREHOUSE_URL: 'mock-private' }, port: 3100,
      log: line => logs.push(line), createStore: () => ({ checkPrivileges: async () => ({ ok: !problems.length, problems }), close: async () => { closed++; } }) };
    if (problems.some(p => p !== 'missing_warehouse_privilege')) {
      await assert.rejects(setupWarehouses(options), WarehousePrivilegeError); assert.equal(closed, 1);
    } else {
      const setup = await setupWarehouses(options); assert.equal(setup.writeEnabled, !problems.length); await setup.close(); assert.equal(closed, 1);
    }
    assert.ok(logs.every(line => !/mock-private|stack|postgres/.test(line)));
  }
  const logs = [];
  const failed = await setupWarehouses({ env: { NC_DB_WAREHOUSE_URL: 'private' }, log: line => logs.push(line),
    createStore: () => { throw new Error('private'); } });
  assert.equal(failed.writeEnabled, false); assert.equal(logs.length, 1); assert.doesNotMatch(logs[0], /private/);
});
test('WH worker starts normally with unready warehouse DB and writes disabled', async t => {
  const f = await centralFixture(t);
  for (const run of [runWorker]) {
    let started = false; const logs = [];
    assert.equal(await run({ env: { RUNTIME_DATA_DIR: f.runtimeDir, NC_DB_WAREHOUSE_URL: 'mock' },
      setup: options => setupWarehouses({ ...options, createStore: () => ({
        checkPrivileges: async () => ({ ok: false, problems: ['missing_warehouse_privilege'] }), close: async () => {} }) }),
      start: async options => { started = true; assert.equal(options.warehouses.writeEnabled, false); },
      log: line => logs.push(line), errorLog: () => assert.fail() }), 0);
    assert.equal(started, true); assert.ok(logs.includes('仓库写入未开启：数据库未就绪或权限不足。'));
  }
});
test('WH worker shares warehouse route and forces local Host even with supplied LAN whitelist', async t => {
  const f = await centralFixture(t);
  const server = createWorkerServer({ ...f, repoRoot: '.', dataSource: createJsonDataSource(f),
    warehouses: { writeEnabled: true, allowedHosts: () => ['evil.invalid:3100'],
      store: { remove: async () => true } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(url + '/api/capabilities')).json(), { refresh: true, warehouse_write: true });
  const deleted = await fetch(url + '/api/warehouses?id=00000000-0000-0000-0000-000000000001', {
    method: 'DELETE', headers: { Origin: url, 'X-NC-Warehouse': '1' } });
  assert.equal(deleted.status, 204);
  assert.equal((await fetch(url + '/api/refresh', { method: 'PATCH' })).status, 405);
});
test('WH setup only permits loopback and JSON disables writes', async () => {
  const createStore = () => ({ checkPrivileges: async () => ({ ok: true, problems: [] }), close: async () => {} });
  for (const DATA_SOURCE of ['db', 'json']) {
    const setup = await setupWarehouses({ env: { DATA_SOURCE, NC_DB_WAREHOUSE_URL: 'mock' }, port: 3100, createStore });
    assert.equal(setup.writeEnabled, DATA_SOURCE === 'db');
    assert.deepEqual(setup.allowedHosts(), ['127.0.0.1:3100', 'localhost:3100']); await setup.close();
  }
});
test('WH worker startup entrypoint return 1 with one safe line for excessive warehouse privileges', async t => {
  const f = await centralFixture(t);
  for (const run of [runWorker]) {
    const errors = [];
    assert.equal(await run({ env: { RUNTIME_DATA_DIR: f.runtimeDir }, log: () => {}, errorLog: line => errors.push(line),
      setup: async () => { throw new WarehousePrivilegeError(); }, start: () => assert.fail() }), 1);
    assert.deepEqual(errors, ['仓库写入账号权限过大，拒绝启动。']);
  }
});
test('WH LAN reader grading retains isolation and allows missing privilege', async t => {
  const f = await centralFixture(t);
  for (const problems of [[], ['missing_warehouse_privilege'], ['extra_warehouse_privilege']]) {
    let started = false;
    const errors = [];
    const result = await runServer({ env: { DATA_SOURCE: 'db', LISTEN_HOST: '0.0.0.0', RUNTIME_DATA_DIR: f.runtimeDir,
      NC_DB_READER_URL: 'postgresql://mock@127.0.0.1:1/mock' },
      createDataSource: () => ({ canWriteRuns: async () => false, checkReaderWarehouseIsolation: async () => ({ ok: !problems.length, problems }), close: async () => {} }),
      start: async () => { started = true; }, log: () => {}, errorLog: line => errors.push(line) });
    assert.equal(result, problems.includes('extra_warehouse_privilege') ? 1 : 0);
    assert.equal(started, result === 0);
    assert.equal(errors.length, result === 0 ? 0 : 1);
  }
});

test('WH LAN startup log always reports read-only', async t => {
  const f = await centralFixture(t), logs = [];
  assert.equal(await runServer({ env: { DATA_SOURCE: 'db', LISTEN_HOST: '0.0.0.0', RUNTIME_DATA_DIR: f.runtimeDir,
    NC_DB_READER_URL: 'postgresql://mock@127.0.0.1:1/mock' },
    createDataSource: () => ({ canWriteRuns: async () => false, checkReaderWarehouseIsolation: async () => ({ ok: true, problems: [] }), close: async () => {} }),
    start: async options => assert.equal(options.warehouses, undefined),
    log: line => logs.push(line), errorLog: () => assert.fail() }), 0);
  assert.ok(logs.includes('Server: http://0.0.0.0:3000（局域网只读）'));
});

test('WH local server ignores warehouse credential and never calls setup or accesses its value', async t => {
  const f = await centralFixture(t);
  for (const LISTEN_HOST of ['127.0.0.1', 'localhost']) for (const DATA_SOURCE of ['json', 'db']) {
    let calls = 0, server;
    const env = { LISTEN_HOST, DATA_SOURCE, RUNTIME_DATA_DIR: f.runtimeDir, NC_DB_READER_URL: 'postgresql://mock@127.0.0.1:1/mock' };
    Object.defineProperty(env, 'NC_DB_WAREHOUSE_URL', { get() { assert.fail('local server read warehouse credential'); } });
    assert.equal(await runServer({ env, createDataSource: () => ({ ...createJsonDataSource(f), close: async () => {} }), setup: () => { calls++; assert.fail(); },
      start: async options => {
        assert.equal(options.warehouses, undefined);
        const { createApiServer } = await import('../src/api/server.js');
        server = createApiServer(options);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server;
      }, log: () => {}, errorLog: () => assert.fail() }), 0);
    assert.equal(calls, 0);
    assert.deepEqual(await (await fetch('http://127.0.0.1:' + server.address().port + '/api/capabilities')).json(), { refresh: false, warehouse_write: false });
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});
