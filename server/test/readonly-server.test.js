import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runServer } from '../bin/server.js';
import { createDbDataSource } from '../src/db/db-data-source.js';
import { createTestDb, dbSkip } from './db-helpers.js';
import { centralFixture } from './central-db-fixtures.js';

test('CD-AC31 LAN rejects forbidden env, JSON, invalid host and failed privilege queries', async t => {
  const f = await centralFixture(t);
  for (const extra of [{ DATA_SOURCE: 'json' }, ...['NC_DB_SCRAPER_URL', 'NC_DB_OWNER_URL', 'NC_DB_WAREHOUSE_URL', 'DMS_BASE_URL', 'DMS_STATE_PATH']
    .map(key => ({ [key]: 'synthetic-private-value' }))]) {
    const logs = [];
    assert.equal(await runServer({ env: { LISTEN_HOST: '0.0.0.0', DATA_SOURCE: 'db', ...extra },
      errorLog: line => logs.push(line), start: () => assert.fail() }), 1);
    assert.deepEqual(logs, ['局域网只读服务配置不安全，拒绝启动。']);
  }
  for (const host of ['::1', 'example.invalid', '', '999.0.0.1', '127.0.0.1:3000'])
    assert.equal(await runServer({ env: { LISTEN_HOST: host }, errorLog: () => {}, start: () => assert.fail() }), 1);
  const errors = [];
  assert.equal(await runServer({ env: { LISTEN_HOST: '0.0.0.0', DATA_SOURCE: 'db',
    NC_DB_READER_URL: 'postgresql://mock@127.0.0.1:1/mock', RUNTIME_DATA_DIR: f.runtimeDir },
  createDataSource: () => ({ canWriteRuns: async () => { throw new Error('private'); }, close: async () => {} }),
  errorLog: line => errors.push(line), start: () => assert.fail(), log: () => {} }), 1);
  assert.deepEqual(errors, ['局域网只读服务配置不安全，拒绝启动。']);
});

test('CD-AC31 actual test DB scraper refused, reader starts LAN server', async t => {
  assert.equal(dbSkip, false, 'Test DB configuration is required; this test must not skip');
  const db = await createTestDb(t), f = await centralFixture(t);
  for (const role of ['scraper', 'reader']) {
    const logs = [], errors = []; let server;
    const result = await runServer({ env: { LISTEN_HOST: '0.0.0.0', DATA_SOURCE: 'db', PORT: '3000',
      RUNTIME_DATA_DIR: f.runtimeDir, NC_DB_READER_URL: process.env[`NC_TEST_DB_${role.toUpperCase()}_URL`] },
    createDataSource: ({ env }) => createDbDataSource({ env, schema: db.schema }),
    start: async options => {
      const { startApiServer } = await import('../src/api/server.js');
      server = await startApiServer({ ...options, port: 0 }); return server;
    }, log: line => logs.push(line), errorLog: line => errors.push(line) });
    if (role === 'scraper') {
      assert.equal(result, 1); assert.equal(server, undefined); assert.deepEqual(errors, ['局域网只读服务配置不安全，拒绝启动。']);
    } else {
      assert.equal(result, 0); assert.equal(server.address().address, '0.0.0.0');
      assert.ok(logs.includes('Server: http://0.0.0.0:3000（局域网只读）'));
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/capabilities`);
      assert.deepEqual(await res.json(), { refresh: false, warehouse_write: false, route_quotation: true });
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  }
});

test('CD-AC31 recursive static imports exclude DMS, Worker, Playwright and child_process', async () => {
  const visited = new Set(), imports = new Set();
  async function inspect(filename) {
    if (visited.has(filename)) return;
    visited.add(filename);
    const normalized = filename.replaceAll('\\', '/');
    assert.doesNotMatch(normalized, /server\/src\/(dms|worker)\/|server\/bin\/(dms-|worker\.js)/);
    const source = await fs.readFile(filename, 'utf8');
    for (const match of source.matchAll(/(?:\bimport\s+(?:[^;]*?\s+from\s+)?|\bexport\s+[^;]*?\s+from\s+)['"]([^'"]+)['"]/g)) {
      imports.add(match[1]);
      assert.doesNotMatch(match[1], /^(?:node:)?child_process$|^playwright(?:\/|$)/);
      if (match[1].startsWith('.')) await inspect(path.resolve(path.dirname(filename), match[1]));
    }
  }
  await inspect(fileURLToPath(new URL('../bin/server.js', import.meta.url)));
  assert.ok(imports.has('pg')); assert.ok(imports.has('node:http')); assert.ok(visited.size > 10);
});
