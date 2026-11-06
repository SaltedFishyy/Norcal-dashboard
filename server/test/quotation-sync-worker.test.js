import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { runWorker } from '../bin/worker.js';
import { createWorkerServer } from '../src/worker/worker.js';
import { createApiServer } from '../src/api/server.js';
import { createJsonDataSource } from '../src/store/data-source.js';
import { centralFixture } from './central-db-fixtures.js';

test('Worker schedule startup defaults off, invalid config stays off, JSON off, close stops enabled job', async t => {
  const f = await centralFixture(t);
  for (const [source, minutes, expected] of [['db', undefined, 0], ['db', '0', 0], ['db', 'bad', 0],
    ['db', '-1', 0], ['db', '1.5', 0], ['db', '', 0], ['json', '5', 0], ['db', '5', 5]]) {
    let made = 0, started = 0, stopped = 0, ran = 0;
    const logs = [], server = new EventEmitter();
    const env = { DATA_SOURCE: source, RUNTIME_DATA_DIR: f.runtimeDir,
      NC_DB_READER_URL: 'postgres://mock@localhost/mock', ...(minutes === undefined ? {} : { LARK_QUOTATION_SYNC_MINUTES: minutes }) };
    Object.defineProperty(env, 'LARK_APP_SECRET', { get: () => assert.fail('startup must not read credentials') });
    assert.equal(await runWorker({ env, log: line => logs.push(line), errorLog: () => assert.fail('startup failed'),
      setup: async () => ({ close: async () => {} }), start: async options => {
        assert.equal(options.quotationSyncIntervalMinutes, expected); return server;
      }, makeScheduler: options => {
        made++; assert.equal(options.intervalMinutes, expected);
        return { start: () => { started++; }, stop: () => { stopped++; } };
      }, syncJob: () => { ran++; } }), 0);
    assert.equal(made, expected ? 1 : 0); assert.equal(started, made); assert.equal(ran, 0);
    server.emit('close'); assert.equal(stopped, made);
    if (minutes === 'bad') assert.ok(logs.some(line => line.includes('invalid')));
    if (source === 'json') assert.ok(logs.some(line => line.includes('DATA_SOURCE=json')));
  }
});

test('Worker status API filters nested fields; readonly API has neither capability nor endpoint', async t => {
  const f = await centralFixture(t), dataSource = createJsonDataSource(f);
  const request = async (server, pathname) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}${pathname}`, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ code: res.statusCode, text: body,
        body: res.headers['content-type']?.includes('application/json') ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
  for (const worker of [true, false]) {
    const server = (worker ? createWorkerServer : createApiServer)({ ...f, dataSource, quotationSyncIntervalMinutes: 5 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const capabilities = (await request(server, '/api/capabilities')).body;
    assert.equal(capabilities.quotation_sync === true, worker);
    const absent = await request(server, '/api/quotation-sync/status');
    if (!worker) { assert.equal(absent.code, 404); continue; }
    assert.deepEqual(absent.body, { enabled: true, interval_minutes: 5, status: null });
    await writeFile(path.join(f.runtimeDir, 'quotation-sync-status.json'), JSON.stringify({ schema_version: 1,
      token: 'TOKEN-SENTINEL', last_attempt: { result: 'fetch_failed', stage: 'values', error_kind: 'permission',
        http_status: 403, lark_code: 7, rejected_count: 2, notes: ['SECRET-SENTINEL'],
        counts: { rejected: 2, price: 987.65 }, rejected: [{ price: 987.65 }], db_code: 'SECRET-SENTINEL' },
      last_success: null }));
    const response = await request(server, '/api/quotation-sync/status');
    assert.equal(response.code, 200); assert.equal(response.body.status.last_attempt.rejected_count, 2);
    assert.equal(response.body.status.last_attempt.http_status, 403);
    assert.doesNotMatch(response.text, /SENTINEL|987\.65|price/);
    assert.equal((await request(server, '/quotation-sync-status.js')).code, 200);
  }
});
