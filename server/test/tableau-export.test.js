import { routePriceSummary } from '../src/quotations/quotations.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportTableauRouteZips } from '../src/export/tableau-route-zips.js';
import { runExport } from '../bin/export-tableau-route-zips.js';
import { readRouteProfiles, getStationSnapshot, SnapshotInvalidError, SnapshotNotFoundError } from '../src/store/route-profiles-file.js';
import { startApiServer } from '../src/api/server.js';

const route = (id, name, codes) => ({ route_id: id, route_name: name, postal_codes: codes });
const snapshot = (rows) => ({ fetched_at: '2026-10-02T00:00:00Z', source_as_of: null, source: 'mock', total: rows.length, rows });
const data = () => ({ schema_version: 1, stations: {
  MOCKB: snapshot([route(3, 'Mock-Z', ['00009'])]),
  MOCKA: snapshot([route(2, 'Mock-B', ['00004']), route(1, 'Mock-A', ['00123', '00002'])]),
} });
async function temporary(t) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-tableau-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

test('export is pure and emits exact columns, stable string sorting, leading zeros and summaries', () => {
  const input = data(), before = structuredClone(input);
  const result = exportTableauRouteZips(input);
  assert.deepEqual(input, before);
  assert.equal(result.csv, 'station,route_id,route_name,postal_code,source,fetched_at\n'
    + 'MOCKA,1,Mock-A,00002,mock,2026-10-02T00:00:00Z\n'
    + 'MOCKA,1,Mock-A,00123,mock,2026-10-02T00:00:00Z\n'
    + 'MOCKA,2,Mock-B,00004,mock,2026-10-02T00:00:00Z\n'
    + 'MOCKB,3,Mock-Z,00009,mock,2026-10-02T00:00:00Z\n');
  assert.deepEqual(result.summary, [
    { station: 'MOCKA', route_count: 2, row_count: 3, unique_zip_count: 3 },
    { station: 'MOCKB', route_count: 1, row_count: 1, unique_zip_count: 1 },
  ]);
  assert.equal(result.conflict_count, 0);
  assert.deepEqual(exportTableauRouteZips(input), result);
});

test('export escapes comma, quote, CR and LF using RFC 4180 and handles empty Routes', () => {
  const input = { schema_version: 1, stations: { MOCK: snapshot([route(null, 'Mock,"名"\r\nRoute', ['00123']), route(2, 'Empty', [])]) } };
  assert.match(exportTableauRouteZips(input).csv, /MOCK,,"Mock,""名""\r\nRoute",00123,mock,/);
  assert.equal(exportTableauRouteZips(input).summary[0].route_count, 2);
  assert.equal(exportTableauRouteZips({ schema_version: 1, stations: {} }).csv, 'station,route_id,route_name,postal_code,source,fetched_at\n');
});

const mutations = [
  ['missing', d => delete d.stations.MOCKA.rows[0].postal_codes, /npm run dms:scrape -- --station MOCKA/],
  ['format', d => d.stations.MOCKA.rows[0].postal_codes = ['bad'], /MOCKA.*Mock-B.*bad/],
  ['wrong array type', d => d.stations.MOCKA.rows[0].postal_codes = '00123', /string\[\]/],
  ['numeric ZIP', d => d.stations.MOCKA.rows[0].postal_codes = [12345], /ZIP 格式/],
  ['duplicate', d => d.stations.MOCKA.rows[0].postal_codes = ['00123', '00123'], /重复/],
  ['Station conflict', d => d.stations.MOCKA.rows[0].postal_codes = ['00123'], /MOCKA.*00123.*Mock-B.*Mock-A/],
  ['cross Station conflict', d => d.stations.MOCKB.rows[0].postal_codes = ['00123'], /跨 Station.*00123.*MOCKA.*Mock-A.*MOCKB.*Mock-Z/],
  ['raw count mismatch', d => d.stations.MOCKA.rows[0].raw = { postalCodeList: '00004', postalCodeNum: 2 }, /postalCodeNum.*数量/],
  ['raw list mismatch', d => d.stations.MOCKA.rows[0].raw = { postalCodeList: '00005', postalCodeNum: 1 }, /与 raw 不一致/],
];
for (const [name, mutate, reason] of mutations) test(`invalid export ${name} reports details and never writes`, async (t) => {
  const runtimeDir = await temporary(t), input = data(); mutate(input);
  const filename = path.join(runtimeDir, 'tableau', 'route-zips.csv');
  await fs.mkdir(path.dirname(filename)); await fs.writeFile(filename, 'old mock CSV');
  await fs.writeFile(path.join(runtimeDir, 'route-profiles.json'), JSON.stringify(input));
  const errors = []; let wrote = false;
  assert.equal(await runExport({ env: { RUNTIME_DATA_DIR: runtimeDir }, log: () => {}, errorLog: value => errors.push(value),
    write: async () => { wrote = true; } }), 1);
  assert.equal(wrote, false); assert.match(errors.join('\n'), reason);
  assert.equal(await fs.readFile(filename, 'utf8'), 'old mock CSV');
});

test('export CLI process writes UTF-8 without BOM, reports summary and exits nonzero without overwriting', async (t) => {
  const runtimeDir = await temporary(t), input = data();
  const filename = path.join(runtimeDir, 'route-profiles.json'); const text = JSON.stringify(input);
  await fs.writeFile(filename, text);
  const entry = fileURLToPath(new URL('../bin/export-tableau-route-zips.js', import.meta.url));
  const run = () => spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10000, env: { ...process.env, RUNTIME_DATA_DIR: runtimeDir } });
  let result = run(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MOCKA.*Route 数 2.*行数 3.*唯一 ZIP 数 3/);
  assert.match(result.stdout, /MOCKB.*Route 数 1.*行数 1.*唯一 ZIP 数 1/);
  assert.match(result.stdout, /冲突数 0/);
  const output = path.join(runtimeDir, 'tableau', 'route-zips.csv'); assert.ok(result.stdout.includes(output));
  const csv = await fs.readFile(output); assert.equal(csv[0], 's'.charCodeAt(0));
  assert.equal(csv.toString('utf8'), exportTableauRouteZips(input).csv);
  assert.equal(await fs.readFile(filename, 'utf8'), text);
  assert.deepEqual(await fs.readdir(path.dirname(output)), ['route-zips.csv']);
  delete input.stations.MOCKA.rows[0].postal_codes; await fs.writeFile(filename, JSON.stringify(input));
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /npm run dms:scrape/);
  assert.deepEqual(await fs.readFile(output), csv);
});

test('legacy snapshot without postal_codes still works through reader and real HTTP API', async (t) => {
  const runtimeDir = await temporary(t);
  const old = snapshot([{ route_id: 1, route_name: 'Mock-Legacy' }]);
  await fs.writeFile(path.join(runtimeDir, 'route-profiles.json'), JSON.stringify({ schema_version: 1, stations: { SFO01: old } }));
  assert.deepEqual(await getStationSnapshot({ runtimeDir, station: 'SFO01' }), old);
  assert.equal((await readRouteProfiles({ runtimeDir })).schema_version, 1);
  const server = await startApiServer({ port: 0, runtimeDir, log: () => {} });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/route-profiles?station=SFO01`);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).rows, old.rows.map(row => ({ ...row, ...routePriceSummary(null, row) })));
});

test('whole-file reader reuses schema validation and error types', async () => {
  const read = text => readRouteProfiles({ runtimeDir: 'unused', fileOps: { readFile: async () => text } });
  for (const text of ['{', 'null', JSON.stringify({ schema_version: 2, stations: {} }),
    JSON.stringify({ schema_version: 1, stations: { MOCK: { rows: [] } } })]) await assert.rejects(read(text), SnapshotInvalidError);
  await assert.rejects(readRouteProfiles({ runtimeDir: 'unused', fileOps: { readFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } } }), SnapshotNotFoundError);
});

test('CLI atomic rename failure preserves CSV and removes temporary files', async (t) => {
  const runtimeDir = await temporary(t); const filename = path.join(runtimeDir, 'tableau', 'route-zips.csv');
  await fs.mkdir(path.dirname(filename)); await fs.writeFile(filename, 'old');
  const { writeFileAtomic } = await import('../src/store/atomic-file.js');
  const errors = [];
  assert.equal(await runExport({ env: { RUNTIME_DATA_DIR: runtimeDir }, read: async () => data(), log: () => {}, errorLog: line => errors.push(line),
    write: (file, text) => writeFileAtomic(file, text, { fileOps: { ...fs, rename: async () => { throw new Error('mock failure'); } } }) }), 1);
  assert.equal(await fs.readFile(filename, 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(path.dirname(filename)), ['route-zips.csv']);
  assert.match(errors[0], /旧文件保留/);
});

test('export import chain excludes browser and session modules', async () => {
  const visited = new Set();
  async function inspect(filename) {
    if (visited.has(filename)) return; visited.add(filename);
    const source = await fs.readFile(filename, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)) {
      assert.doesNotMatch(match[1], /playwright|\/dms\/|session/);
      if (match[1].startsWith('.')) await inspect(path.resolve(path.dirname(filename), match[1]));
    }
  }
  await inspect(fileURLToPath(new URL('../bin/export-tableau-route-zips.js', import.meta.url)));
});
