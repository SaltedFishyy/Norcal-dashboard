import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { startWorkerServer } from '../src/worker/worker.js';
import { runWorker } from '../bin/worker.js';
import { createJsonDataSource } from '../src/store/data-source.js';
import { centralFixture } from './central-db-fixtures.js';

async function fixture(t, { alive = false, last = null } = {}) {
  const f = await centralFixture(t);
  await fs.writeFile(f.districtsPath, JSON.stringify({ schema_version: 1, districts: [
    { id: 'mock', name_zh: '模拟', name_en: 'Mock', stations: ['AAA01', 'BBB01'], scrape_disabled: { BBB01: 'disabled' } },
    { id: 'empty', name_zh: '空', name_en: 'Empty', stations: ['CCC01'], scrape_disabled: { CCC01: 'no_permission' } },
  ] }));
  const calls = [], logs = [], children = [];
  const dataSource = { ...createJsonDataSource(f), readLastScrapeRun: async () => last };
  const options = { ...f, repoRoot: path.resolve('.'), dataSource, isAlive: () => alive, log: line => logs.push(line),
    spawn: (...args) => {
      calls.push(args); const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child); return child;
    } };
  const open = async () => {
    const server = await startWorkerServer({ ...options, port: 0 });
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  };
  const instance = await open();
  const request = async (pathname, body = '{"scope":"all"}', headers = {}, method = 'POST') => {
    return new Promise((resolve, reject) => {
      const req = http.request(instance.url + pathname, { method,
        headers: { Origin: instance.url, 'X-NC-Refresh': '1', 'Content-Type': 'application/json', ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject); req.end(method === 'POST' ? body : undefined);
    });
  };
  return { ...f, ...instance, request, calls, children, logs, open,
    progress: value => fs.writeFile(path.join(f.runtimeDir, 'refresh-progress.json'), JSON.stringify(value)),
    lock: value => fs.writeFile(path.join(f.runtimeDir, 'scrape.lock'), JSON.stringify(value)) };
}

test('CD-AC24 Worker binds loopback and ignores LISTEN_HOST; port validation and logs', async t => {
  const f = await fixture(t);
  assert.equal(f.server.address().address, '127.0.0.1');
  assert.deepEqual((await f.request('/api/capabilities', undefined, {}, 'GET')).body, { refresh: true, warehouse_write: false });
  const logs = [];
  assert.equal(await runWorker({ env: { LISTEN_HOST: '0.0.0.0', RUNTIME_DATA_DIR: f.runtimeDir },
    log: line => logs.push(line), start: async options => {
      assert.equal(options.port, 3100); assert.equal(Object.hasOwn(options, 'host'), false);
      const server = await startWorkerServer({ ...options, port: 0, spawn: () => { throw new Error('must not spawn'); } });
      assert.equal(server.address().address, '127.0.0.1');
      await new Promise(resolve => server.close(resolve));
    } }), 0);
  assert.ok(logs.includes('Worker: http://127.0.0.1:3100（仅本机 localhost-only）'));
  assert.ok(logs.includes('Data source: json'));
  for (const WORKER_PORT of ['', '0', '65536', '1.5', 'abc', '-1']) {
    assert.equal(await runWorker({ env: { WORKER_PORT }, errorLog: () => {}, start: () => assert.fail() }), 1);
  }
});

test('CD-AC26 invalid requests never spawn; valid preview and exact spawn contract', async t => {
  const f = await fixture(t);
  const cases = [
    ['{"scope":"all"}', { Host: 'evil.invalid' }, 403],
    ['{"scope":"all"}', { Origin: 'http://evil.invalid' }, 403],
    ['{"scope":"all"}', { 'X-NC-Refresh': '' }, 403],
    ['{"scope":"all"}', { 'Content-Type': 'text/plain' }, 400],
    ['x'.repeat(1025), {}, 400], ['{', {}, 400], ['{"scope":"bad"}', {}, 400],
    ['{"scope":"district:empty"}', {}, 400], ['{"scope":"district:missing"}', {}, 400],
  ];
  for (const [body, headers, code] of cases) {
    assert.equal((await f.request('/api/refresh', body, headers)).status, code); assert.equal(f.calls.length, 0);
  }
  for (const pathname of ['/api/health', '/', '/api/refresh/status'])
    assert.deepEqual(await f.request(pathname, undefined, { Host: 'evil.invalid' }, 'GET'), { status: 403, body: { error: 'forbidden_host' } });
  for (const [scope, code] of [['bad', 400], ['district:missing', 404], ['all', 200]])
    assert.equal((await f.request('/api/refresh/preview?scope=' + scope, undefined, {}, 'GET')).status, code);
  const preview = await f.request('/api/refresh/preview?scope=all', undefined, {}, 'GET');
  assert.deepEqual(preview.body.stations, [{ code: 'AAA01', district: 'mock', district_name_zh: '模拟' }]);
  assert.equal(preview.body.skipped[0].reason, 'disabled');
  assert.equal((await f.request('/api/refresh')).status, 202);
  assert.deepEqual(f.calls, [[process.execPath, ['--env-file-if-exists=.env', 'server/bin/dms-scrape-stations.js',
    '--scope', 'all', '--trigger', 'ui', '--new-run', '--progress-file', path.join(f.runtimeDir, 'refresh-progress.json')],
  { cwd: path.resolve('.'), shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false }]]);
  f.children[0].stdout.write('one\ntw'); f.children[0].stdout.end('o\n');
  f.children[0].stderr.end('error');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.logs.includes('[scrape] one')); assert.ok(f.logs.includes('[scrape] two')); assert.ok(f.logs.includes('[scrape] error'));
  assert.equal((await f.request('/api/health', undefined, {}, 'POST')).status, 405);
});

test('CD-AC27 concurrent POSTs spawn once; live, stale and malformed locks', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([f.request('/api/refresh'), f.request('/api/refresh')]);
  assert.deepEqual(responses.map(r => r.status).sort(), [202, 409]); assert.equal(f.calls.length, 1);
  const live = await fixture(t, { alive: true }); await live.lock({ pid: 123 });
  assert.equal((await live.request('/api/refresh')).status, 409); assert.equal(live.calls.length, 0);
  const stale = await fixture(t); await stale.lock({ pid: 123 });
  assert.equal((await stale.request('/api/refresh')).status, 202); assert.equal(stale.calls.length, 1);
  await assert.rejects(fs.stat(path.join(stale.runtimeDir, 'scrape.lock')), { code: 'ENOENT' });
  const invalid = await fixture(t); await invalid.lock({ pid: -1 });
  assert.equal((await invalid.request('/api/refresh')).status, 409); assert.equal(invalid.calls.length, 0);
});

test('CD-AC29 status recovers progress, completion, login failure and orphan after restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/refresh/status', undefined, {}, 'GET')).body.state, 'idle');
  await f.request('/api/refresh');
  const progress = { run_id: 'mock', status: 'running', phase: 'capture', station: 'AAA01',
    station_index: 1, station_total: 2, route_index: 3, route_total: 4, completed: [], skipped: [], failed: [], stop_reason: null };
  await f.progress(progress);
  let state = (await f.request('/api/refresh/status', undefined, {}, 'GET')).body;
  assert.equal(state.state, 'running'); assert.deepEqual(state.progress, progress);
  await f.progress({ ...progress, status: 'completed' }); f.children[0].emit('exit', 0);
  assert.equal((await f.request('/api/refresh/status', undefined, {}, 'GET')).body.state, 'completed');
  const restarted = await f.open();
  assert.equal((await (await fetch(restarted.url + '/api/refresh/status')).json()).state, 'completed');
  await f.progress({ ...progress, status: 'stopped', stop_reason: 'capture:NeedsLoginError' });
  assert.equal((await (await fetch(restarted.url + '/api/refresh/status')).json()).needs_login, true);
  await f.progress(progress); await f.lock({ pid: 123 });
  state = await (await fetch(restarted.url + '/api/refresh/status')).json();
  assert.equal(state.state, 'stopped'); assert.equal(state.progress.stop_reason, 'process:Exited');
  const live = await fixture(t, { alive: true }); await live.lock({ pid: 123 }); await live.progress(progress);
  const liveRestart = await live.open();
  assert.equal((await (await fetch(liveRestart.url + '/api/refresh/status')).json()).state, 'running');
  const early = await fixture(t); await early.request('/api/refresh'); early.children[0].emit('error', new Error('mock spawn failure'));
  const earlyRestart = await early.open();
  state = await (await fetch(earlyRestart.url + '/api/refresh/status')).json();
  assert.equal(state.state, 'stopped'); assert.equal(state.progress.stop_reason, 'process:Exited');
});
