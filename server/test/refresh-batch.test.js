import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { batchFixture, record } from './multi-station-fixtures.js';
import { writeFileAtomic } from '../src/store/atomic-file.js';

async function configFile(t, disabled = { MFR01: 'disabled' }) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'nc-refresh-batch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'districts.json');
  await fs.writeFile(filename, JSON.stringify({ schema_version: 1, districts: [{ id: 'first', name_zh: 'first', name_en: 'first',
    stations: ['SFO01', 'MFR01'], scrape_disabled: disabled }] }));
  return { filename, dir };
}
test('refresh scoped batch skips switching disabled stations, records safe progress at every route including cache', async t => {
  const { filename, dir } = await configFile(t), writes = [];
  const h = batchFixture({ lists: { SFO01: [record('SFO01', 1), record('SFO01', 2)], MFR01: [] } });
  const args = ['--scope', 'district:first', '--trigger', 'ui', '--progress-file', path.join(dir, 'progress.json')];
  const progressWriter = async (p, text) => { writes.push(JSON.parse(text)); await writeFileAtomic(p, text); };
  assert.equal(await h.run({ args, districtsPath: filename, progressWriter }), 0);
  assert.ok(h.events.every(e => e !== 'switch:MFR01'));
  assert.deepEqual(h.files.at(-1).record.skipped_by_config, [{ code: 'MFR01', district: 'first', reason: 'disabled' }]);
  assert.deepEqual(writes.filter(w => w.route_index > 0 && w.phase === 'list').map(w => w.route_index), [1]);
  assert.ok(writes.some(w => w.route_index === 2 && w.route_total === 2));
  const end = writes.at(-1); assert.equal(end.status, 'completed'); assert.ok(end.finished_at);
  assert.deepEqual(end.completed, ['SFO01']); assert.equal(end.station_total, 1); assert.equal(end.district, 'first');
  assert.ok(writes.some(w => w.station_index === 1 && w.route_index === 0));
  assert.doesNotMatch(JSON.stringify(writes), /https:|SECRET|message|url|raw/i);
  const cached = batchFixture({ lists: { SFO01: [record('SFO01', 1), record('SFO01', 2)] } });
  Object.assign(cached.details, h.details); const cachedWrites = [];
  assert.equal(await cached.run({ args, districtsPath: filename, progressWriter: async (_, text) => cachedWrites.push(JSON.parse(text)) }), 0);
  assert.deepEqual(cachedWrites.filter(w => w.phase === 'list' && w.route_index > 0).map(w => w.route_index), [1, 2]);
  assert.ok(!cached.events.some(e => e.startsWith('capture:')));
});

test('refresh progress failures warn and do not interrupt business writes; stop reason has no error content', async t => {
  const { filename } = await configFile(t); const h = batchFixture();
  const args = ['--scope', 'district:first', '--progress-file', 'synthetic.json'];
  assert.equal(await h.run({ args, districtsPath: filename, progressWriter: async () => { throw new Error('https://secret.invalid'); } }), 0);
  assert.ok(h.logs.includes('进度文件写入失败。')); assert.doesNotMatch(h.logs.join(' '), /secret/);
  const failed = batchFixture(), writes = [];
  assert.equal(await failed.run({ args, districtsPath: filename, progressWriter: async (_, text) => writes.push(JSON.parse(text)),
    capture: async () => { throw new Error('https://secret.invalid/raw-error'); } }), 1);
  assert.equal(writes.at(-1).stop_reason, 'capture:Error'); assert.deepEqual(writes.at(-1).failed, ['SFO01']);
  assert.doesNotMatch(JSON.stringify(writes), /https:|raw-error/);
});

test('refresh empty eligible station plan refuses before session or state writes', async t => {
  const { filename } = await configFile(t, { SFO01: 'disabled', MFR01: 'no_permission' });
  const h = batchFixture();
  assert.equal(await h.run({ args: ['--scope', 'district:first'], districtsPath: filename }), 1);
  assert.equal(h.pageHarness.requests, 0); assert.equal(h.state, null);
  assert.ok(h.logs.includes('本次范围没有可抓取的 Station。'));
});

test('refresh scoped batch forwards trigger and scope to dual sink without changing route scheduling', async t => {
  const { filename } = await configFile(t), h = batchFixture(); let metadata;
  const sink = Object.fromEntries(['startRun','writeState','writeStationSummary','writeRouteDetail','activateStationSnapshot','finishRun']
    .map(action => [action, async () => {}]));
  assert.equal(await h.run({ args: ['--scope', 'district:first', '--trigger', 'ui'], districtsPath: filename,
    env: { DMS_BASE_URL: 'https://example.invalid', DB_DUAL_WRITE: '1' },
    dbSinkFactory: value => { metadata = value; return sink; } }), 0);
  assert.equal(metadata.trigger, 'ui'); assert.deepEqual(metadata.requestedStations, ['SFO01']);
  assert.deepEqual(metadata.scope, { type: 'district', district: 'first', skipped: [{ code: 'MFR01', district: 'first', reason: 'disabled' }] });
});
