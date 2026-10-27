import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createJsonBatchSink } from '../src/batch/batch-sink.js';
import { batchFixture } from './multi-station-fixtures.js';
import { saveStationSnapshot, readRouteProfiles } from '../src/store/route-profiles-file.js';
import { saveRouteDetail } from '../src/store/route-details-file.js';

for (const mode of ['integrity failure', 'success', 'store failure']) {
  test(`CD P1 real stores: ${mode}`, async t => {
    const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'nc-cd-p1-'));
    t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const filename = path.join(runtimeDir, 'route-profiles.json');
    const old = { fetched_at: '2026-01-01T00:00:00Z', source_as_of: null, total: 1,
      rows: [{ route_id: 999, postal_codes: ['00123'] }] };
    const stations = { SFO01: old, RNO01: structuredClone(old) };
    await fs.writeFile(filename, JSON.stringify({ schema_version: 1, stations }));
    const before = await fs.readFile(filename);
    const h = batchFixture();
    let snapshotCalls = 0;
    const result = await h.run({
      readProfiles: () => readRouteProfiles({ runtimeDir }),
      saveDetail: async value => {
        await saveRouteDetail({ ...value, runtimeDir });
        // Corrupt only the in-memory detail after its successful real write.
        if (mode === 'integrity failure') value.route.station = 'RNO01';
      },
      saveSnapshot: value => {
        snapshotCalls++;
        const fileOps = mode === 'store failure'
          ? { ...value.fileOps, rename: async () => { throw new Error('synthetic rename failure'); } }
          : value.fileOps;
        return saveStationSnapshot({ ...value, runtimeDir, fileOps });
      },
    });
    const after = await fs.readFile(filename);
    const summary = h.files.at(-1).record;
    if (mode === 'success') {
      assert.equal(result, 0);
      assert.notDeepEqual(after, before);
      const updated = JSON.parse(after);
      assert.equal(updated.stations.SFO01.rows[0].route_id, 1);
      assert.deepEqual(updated.stations.RNO01, stations.RNO01);
      assert.equal(snapshotCalls, 2);
    } else {
      assert.equal(result, 1);
      assert.deepEqual(after, before);
      assert.equal(h.state.stations.SFO01.status, 'stopped');
      assert.equal(h.state.stations.MFR01.status, 'pending');
      assert.equal(summary.stop_reason, mode === 'integrity failure' ? 'integrity:IntegrityError' : 'store:StoreError');
      assert.equal(h.files[0].record.stop_reason, summary.stop_reason);
      assert.equal(snapshotCalls, mode === 'integrity failure' ? 0 : 1);
      assert.ok(!h.events.includes('capture:2'));
      assert.ok(!h.events.includes('switch:MFR01'));
    }
    assert.ok(JSON.parse(await fs.readFile(path.join(runtimeDir, 'route-details.json'), 'utf8')).routes['1']);
    assert.deepEqual((await fs.readdir(runtimeDir)).filter(name => name.endsWith('.tmp')), []);
  });
}

test('CD JSON sink delegates lifecycle and business writes with runtime and payloads', async () => {
  const calls = [], state = { run_id: 'synthetic' }, record = { status: 'completed' };
  const sink = createJsonBatchSink({ runtimeDir: 'synthetic-runtime',
    saveDetail: async value => { calls.push(['detail', value]); return 'detail-result'; },
    saveSnapshot: async value => { calls.push(['snapshot', value]); return 'snapshot-result'; },
    writeBatch: async value => { calls.push(['batch', value]); return 'batch-result'; },
  });
  await sink.startRun(state); await sink.writeState(state);
  assert.equal(await sink.writeStationSummary({ state, station: 'SFO01', record }), 'batch-result');
  const route = { route_id: 1 }, stationSnapshot = { rows: [] }, beforeCommit = async () => {};
  assert.equal(await sink.writeRouteDetail({ route, beforeCommit }), 'detail-result');
  assert.equal(await sink.activateStationSnapshot({ station: 'SFO01', stationSnapshot, beforeCommit }), 'snapshot-result');
  assert.equal(await sink.finishRun({ state, record }), 'batch-result');
  assert.deepEqual(calls.map(([action]) => action), ['batch', 'batch', 'batch', 'detail', 'snapshot', 'batch', 'batch']);
  for (const [, value] of calls) assert.equal(value.runtimeDir, 'synthetic-runtime');
  assert.equal(calls[3][1].route, route); assert.equal(calls[4][1].stationSnapshot, stationSnapshot);
  assert.equal(calls[4][1].station, 'SFO01');
  assert.deepEqual(calls.filter(([action]) => action === 'batch').map(([, value]) => value), [
    { runtimeDir: 'synthetic-runtime', state }, { runtimeDir: 'synthetic-runtime', state },
    { runtimeDir: 'synthetic-runtime', state, station: 'SFO01', record },
    { runtimeDir: 'synthetic-runtime', state }, { runtimeDir: 'synthetic-runtime', state, record },
  ]);
});

for (const action of ['writeRouteDetail', 'activateStationSnapshot']) {
  for (const reject of [false, true]) {
    test(`CD sink ${action} beforeCommit ${reject ? 'blocks rename' : 'runs before rename'}`, async t => {
      const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'nc-cd-hook-'));
      t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
      const source = path.join(runtimeDir, 'pending'), target = path.join(runtimeDir, 'active');
      await fs.writeFile(source, 'new'); await fs.writeFile(target, 'old');
      const events = [], failure = new Error('guard failed');
      const delegate = async ({ fileOps }) => {
        events.push('store');
        await fileOps.rename(source, target);
        events.push('renamed');
      };
      const sink = createJsonBatchSink({ runtimeDir, saveDetail: delegate, saveSnapshot: delegate });
      const operation = sink[action]({ beforeCommit: async () => {
        events.push('guard');
        assert.equal(await fs.readFile(target, 'utf8'), 'old');
        if (reject) throw failure;
      } });
      if (reject) await assert.rejects(operation, error => error === failure);
      else await operation;
      assert.deepEqual(events, reject ? ['store', 'guard'] : ['store', 'guard', 'renamed']);
      assert.equal(await fs.readFile(target, 'utf8'), reject ? 'old' : 'new');
      if (reject) assert.equal(await fs.readFile(source, 'utf8'), 'new');
    });
  }
}
