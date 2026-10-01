import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startApiServer } from '../src/api/server.js';
import { createRequestHandler } from '../src/api/app.js';
import { getStationSnapshot } from '../src/store/route-profiles-file.js';
import { runServer } from '../bin/server.js';

const snapshot = { fetched_at: '2026-10-01T00:00:00Z', source_as_of: null, total: 1,
  source: 'mock', rows: [{ station: 'SFO01', route_id: 1, raw: { pph: 'unknown' }, parse_errors: ['pph'] }] };
const valid = () => ({ schema_version: 1, stations: { SFO01: structuredClone(snapshot) } });

async function fixture(t) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-t6-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const logs = [];
  const server = await startApiServer({ port: 0, runtimeDir, log: (message) => logs.push(message) });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { runtimeDir, server, logs, filename: path.join(runtimeDir, 'route-profiles.json'),
    url: `http://127.0.0.1:${server.address().port}` };
}

async function response(url, status, body, options) {
  const res = await fetch(url, options);
  assert.equal(res.status, status);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal([...res.headers.keys()].some((key) => key.startsWith('access-control-')), false);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), body);
  if (body.error) assert.doesNotMatch(text, /Error|stack|at |nc-t6-|[\\/]/);
  return res;
}

test('T6 health, snapshot preservation, loopback binding and read-only file', async (t) => {
  const { server, filename, url } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  await response(`${url}/api/health`, 200, { ok: true });
  const content = JSON.stringify(valid());
  await fs.writeFile(filename, content);
  const before = await fs.stat(filename);
  await response(`${url}/api/route-profiles?station=SFO01`, 200,
    { station: 'SFO01', fetched_at: snapshot.fetched_at, source_as_of: null, total: 1, rows: snapshot.rows });
  assert.equal(await fs.readFile(filename, 'utf8'), content);
  assert.equal((await fs.stat(filename)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(path.dirname(filename)), ['route-profiles.json']);
});

test('T6 invalid station parameters never call store', async (t) => {
  const { url } = await fixture(t);
  for (const query of ['', '?station=', '?station=a%20b', '?station=a/b', '?station=a&station=b',
    '?station=' + 'a'.repeat(33), '?station=%0A', '?station=%E4%B8%AD']) {
    await response(`${url}/api/route-profiles${query}`, 400, { error: 'invalid_station' });
  }
});

test('T6 missing file, missing station and inherited station keys', async (t) => {
  const { filename, url } = await fixture(t);
  await response(`${url}/api/route-profiles?station=SFO01`, 404, { error: 'snapshot_not_found' });
  await fs.writeFile(filename, JSON.stringify(valid()));
  for (const station of ['MFR01', 'constructor', '__proto__']) {
    await response(`${url}/api/route-profiles?station=${station}`, 404, { error: 'station_not_found' });
  }
});

test('T6 malformed JSON and every required snapshot type', async (t) => {
  const { filename, url } = await fixture(t);
  const invalid = ['{', 'null', '[]', JSON.stringify({ schema_version: 2, stations: {} }),
    JSON.stringify({ schema_version: 1, stations: [] }), JSON.stringify({ schema_version: 1, stations: null })];
  for (const [key, value] of [['fetched_at', null], ['total', '1'], ['total', null],
    ['rows', {}], ['source_as_of', 10]]) {
    const data = valid(); data.stations.SFO01[key] = value; invalid.push(JSON.stringify(data));
  }
  for (const key of ['fetched_at', 'total', 'rows', 'source_as_of']) {
    const data = valid(); delete data.stations.SFO01[key]; invalid.push(JSON.stringify(data));
  }
  invalid.push(JSON.stringify({ schema_version: 1, stations: { SFO01: null } }));
  for (const text of invalid) {
    await fs.writeFile(filename, text);
    await response(`${url}/api/route-profiles?station=SFO01`, 500, { error: 'snapshot_invalid' });
  }
});

test('T6 store errors are sanitized and use only readFile', async () => {
  for (const [code, name] of [['ENOENT', 'SnapshotNotFoundError'], ['EACCES', 'SnapshotInvalidError']]) {
    await assert.rejects(getStationSnapshot({ runtimeDir: 'private-path', station: 'SFO01',
      fileOps: { readFile: async () => { throw Object.assign(new Error('private-path secret'), { code }); } } }),
    (error) => { assert.equal(error.name, name); assert.doesNotMatch(error.message, /private-path|secret|stack/); return true; });
  }
  assert.deepEqual(await getStationSnapshot({ runtimeDir: 'unused', station: 'SFO01',
    fileOps: { readFile: async () => JSON.stringify(valid()) } }), snapshot);
});

test('T6 unknown routes and non-GET methods', async (t) => {
  const { url } = await fixture(t);
  for (const method of ['GET', 'POST']) await response(`${url}/legacy/`, 404, { error: 'not_found' }, { method });
  for (const pathname of ['/api/health', '/api/route-profiles']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const res = await response(`${url}${pathname}`, 405, { error: 'method_not_allowed' }, { method });
      assert.equal(res.headers.get('allow'), 'GET');
    }
    const head = await fetch(`${url}${pathname}`, { method: 'HEAD' });
    assert.equal(head.status, 405); assert.equal(head.headers.get('allow'), 'GET');
    assert.equal(await head.text(), '');
  }
});

test('T6 unexpected exceptions and request secrets never enter logs', async (t) => {
  const logs = [];
  const server = http.createServer(createRequestHandler({
    getSnapshot: async () => { throw new Error('private-path stack secret'); }, log: (line) => logs.push(line),
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  await response(`${url}/api/route-profiles?station=SFO01&token=secret`, 500, { error: 'internal_error' });
  await response(`${url}/secret/private-path`, 404, { error: 'not_found' });
  assert.deepEqual(logs, ['HTTP 500', 'HTTP 404']);
});

test('T6 CLI invalid PORT exits without runtime or browser access', async (t) => {
  const { runtimeDir } = await fixture(t);
  const entry = fileURLToPath(new URL('../bin/server.js', import.meta.url));
  for (const PORT of ['', '0', '65536', '-1', '1.5', 'abc', '1e3']) {
    const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PORT, RUNTIME_DATA_DIR: runtimeDir } });
    assert.equal(result.status, 1); assert.match(result.stderr, /PORT 必须/);
    assert.doesNotMatch(result.stderr, /stack|at |Error/);
  }
});

test('T6 CLI defaults, overrides, warnings and sanitized startup errors', async (t) => {
  const { runtimeDir, server } = await fixture(t);
  for (const [PORT, expected] of [[undefined, 3000], ['12345', 12345]]) {
    const logs = [];
    assert.equal(await runServer({ env: { PORT, HOST: '0.0.0.0', RUNTIME_DATA_DIR: runtimeDir },
      log: (line) => logs.push(line), start: async (options) => {
        assert.equal(options.port, expected); assert.equal(options.runtimeDir, runtimeDir);
      } }), 0);
    assert.ok(logs.includes(`Server: http://127.0.0.1:${expected}`));
    assert.ok(logs.includes(`Runtime data: ${runtimeDir}`));
  }
  const errors = [];
  assert.equal(await runServer({ env: { PORT: String(server.address().port), RUNTIME_DATA_DIR: runtimeDir },
    log: () => {}, errorLog: (line) => errors.push(line) }), 1);
  assert.match(errors[0], /已被占用/);
  const warnings = [];
  await runServer({ env: { RUNTIME_DATA_DIR: '.' }, log: (line) => warnings.push(line), start: async () => {} });
  assert.ok(warnings.some((line) => line.startsWith('warning:')));
});

test('T6 API and CLI import chain excludes DMS and Playwright', async () => {
  const visited = new Set();
  async function inspect(filename) {
    if (visited.has(filename)) return;
    visited.add(filename);
    const source = await fs.readFile(filename, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)) {
      assert.doesNotMatch(match[1], /playwright|\/dms\//);
      if (match[1].startsWith('.')) await inspect(path.resolve(path.dirname(filename), match[1]));
    }
  }
  await inspect(fileURLToPath(new URL('../bin/server.js', import.meta.url)));
});
