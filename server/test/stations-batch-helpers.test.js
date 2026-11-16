import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildProgressValue, newStationRecord, guardRouteNameQuery, markStationStopped, buildRunRecord } from '../bin/dms-scrape-stations.js';
import { CaptureError, SelectorError } from '../src/dms/portrait-page.js';
import { StationMismatchError } from '../src/dms/station-switch.js';
import { batchFixture, record } from './multi-station-fixtures.js';

const at = '2026-11-16T12:00:00.000Z';
const stationRecord = () => newStationRecord('SFO01', { stationBase: 123, startTime: at });

test('CH-T3 progress preserves every field for running, completed and stopped runs', () => {
  for (const [finished, exitCode, status] of [[false, 0, 'running'], [true, 0, 'completed'], [true, 1, 'stopped']]) {
    let calls = 0;
    const result = buildProgressValue({ state: { run_id: 'mock', stations: { SFO01: { status: 'completed' }, MFR01: { status: 'stopped' } } },
      plan: { scope: { type: 'all' }, stations: [{ code: 'SFO01', district: 'mock-district' }] }, started: new Date(at),
      now: () => { calls++; return new Date(at); }, phase: 'store', current: { station: 'SFO01', route_total: 3 },
      options: { stations: ['SFO01', 'MFR01'] }, routeIndex: 2, skipped: () => [], finished, exitCode, stopReason: null });
    assert.deepEqual(result, { run_id: 'mock', scope: { type: 'all' }, started_at: at, updated_at: at, phase: 'store',
      station: 'SFO01', district: 'mock-district', station_index: 1, station_total: 2, route_index: 2, route_total: 3,
      completed: ['SFO01'], skipped: [], failed: ['MFR01'], finished_at: finished ? at : null, status, stop_reason: null });
    assert.equal(calls, finished ? 2 : 1);
  }
  const initial = buildProgressValue({ started: new Date(at), now: () => new Date(at), options: { stations: [] }, skipped: () => [] });
  assert.equal(initial.run_id, null); assert.equal(initial.station_index, 0); assert.equal(initial.district, null);
});

test('CH-T3 new station record has the original fields and independent nested objects', () => {
  assert.deepEqual(stationRecord(), { station: 'SFO01', status: 'in_progress', route_total: null, success_count: 0,
    skipped_cached_count: 0, failed_count: 0, zero_routes: false, request_count: 0, list_request_count: 0,
    detail_request_count: 0, station_request_cap: 123, start_time: at, end_time: null, duration_ms: 0,
    locate_method: { L1: 0, L2: 0, L3: 0, L5: 0 }, integrity: { passed: false, checks: {}, warnings: [] },
    boundary_coverage: { with_polygon: 0, no_zcta: 0, not_checked: 0 }, stop_reason: null, missing_routes: [] });
  const first = stationRecord(), second = stationRecord();
  first.missing_routes.push(1); first.locate_method.L1++;
  assert.deepEqual(second.missing_routes, []); assert.equal(second.locate_method.L1, 0);
});

test('CH-T3 route name guard preserves page, record and station checks', async () => {
  const body = { success: true, data: { total: 1, current: 1, size: 100, records: [record('SFO01', 1)] } };
  const events = [], context = {};
  let response = structuredClone(body);
  const args = { queryName: async (...params) => { events.push(params); return response; }, pageNumber: 1,
    station: 'SFO01', body, total: 1, context, assertStation: async (actual, station) => {
      assert.equal(actual, context); assert.equal(station, 'SFO01'); events.push('assert');
    } };
  for (const pageNumber of [2, 3]) await assert.rejects(guardRouteNameQuery({ ...args, pageNumber })(), SelectorError);
  assert.deepEqual(events, []);
  assert.equal(await guardRouteNameQuery(args)(1), response);
  assert.deepEqual(events, [[1], 'assert']);
  response = { ...body, data: { ...body.data, records: [record('SFO01', 2)] } };
  await assert.rejects(guardRouteNameQuery(args)(1), CaptureError);
  response = { ...body, data: { ...body.data, records: [record('MFR01', 1)] } };
  await assert.rejects(guardRouteNameQuery(args)(1, 'MOCK-1'), StationMismatchError);
  response = body;
  assert.equal(await guardRouteNameQuery(args)(1, 'MOCK-1'), body);
});

test('CH-T3 stopped station preserves summary removal, missing routes and failure rules', () => {
  for (const phase of ['switch', 'list', 'capture', 'transform', 'store', 'close_modals']) {
    for (const routeWritten of [false, true]) {
      const current = stationRecord(); current.end_time = at; current.route_total = 4;
      const prior = {}, summaries = [prior, current];
      markStationStopped(current, { phase, error: new CaptureError(), loadedRoutes: [1, 2], completedRoutes: new Set([1]),
        currentRoute: { route_id: 2 }, routeWritten, automaticListSeen: true, summaries });
      assert.deepEqual(summaries, [prior]); assert.equal(current.end_time, null);
      assert.equal(current.status, 'stopped'); assert.equal(current.stop_reason, `${phase}:CaptureError`);
      assert.deepEqual(current.missing_routes, [2]); assert.equal(current.unloaded_route_count, 2);
      assert.equal(current.failed_count, !routeWritten && ['capture', 'transform', 'store'].includes(phase) ? 1 : 0);
      assert.equal(current.automatic_list_seen, phase === 'switch' ? true : undefined);
    }
  }
  const current = stationRecord(), summaries = [current, {}];
  current.end_time = at;
  markStationStopped(current, { phase: 'capture', error: new Error(), loadedRoutes: [], completedRoutes: new Set(),
    currentRoute: null, routeWritten: false, summaries });
  assert.equal(summaries.length, 2); assert.equal(current.end_time, null);
  assert.equal(current.unloaded_route_count, null); assert.equal(current.failed_count, 0);
});

test('CH-T3 run record preserves completed, stopped, runtime skipped and planned output', () => {
  const summary = { ...stationRecord(), route_total: 3, success_count: 2, skipped_cached_count: 1, missing_routes: [9] };
  const args = { options: { stations: ['SFO01', 'MFR01'] }, state: { stations: { SFO01: { status: 'completed' }, MFR01: { status: 'completed' } } },
    summaries: [summary], resumed: ['MFR01'], runtimeSkipped: [], snapshots: { MFR01: { total: 5 } },
    counts: { prodApiRequestCount: 10 }, batchCap: 99, started: new Date(at), ended: new Date(at), original: 'SFO01',
    originalKind: 'station', restored: true, stopReason: null, exitCode: 0, skipped: () => [], plan: null };
  const expected = { station_total: 2, completed_count: 2, completed_stations: ['SFO01', 'MFR01'], limited_stations: [],
    skipped_stations: ['MFR01'], unprocessed_stations: [], route_total: 8, success_count: 2, skipped_cached_count: 1,
    request_count: 10, batch_request_cap: 99, duration_ms: 0, start_time: at, end_time: at,
    locate_method: { L1: 0, L2: 0, L3: 0, L5: 0 }, missing_stations: [], missing_routes: [{ station: 'SFO01', route_id: 9 }],
    original_station: 'SFO01', original_kind: 'station', original_station_restored: true, stop_reason: null, status: 'completed', skipped: [] };
  assert.equal(JSON.stringify(buildRunRecord(args)), JSON.stringify(expected));
  args.state.stations.MFR01.status = 'stopped'; args.exitCode = 1; args.stopReason = 'capture:CaptureError';
  assert.deepEqual(buildRunRecord(args), { ...expected, completed_count: 1, completed_stations: ['SFO01'],
    unprocessed_stations: ['MFR01'], missing_stations: ['MFR01'], stop_reason: args.stopReason, status: 'stopped' });
  args.runtimeSkipped = [{ code: 'MFR01', reason: 'not_in_dms_menu' }]; args.skipped = () => args.runtimeSkipped;
  const skipped = buildRunRecord(args);
  assert.deepEqual(skipped.unprocessed_stations, []); assert.deepEqual(skipped.missing_stations, []);
  assert.deepEqual(skipped.skipped, args.runtimeSkipped);
  args.plan = { skipped: [{ code: 'RNO01', reason: 'disabled' }] };
  const planned = buildRunRecord(args);
  assert.deepEqual(planned.skipped_by_config, args.plan.skipped);
  assert.equal(Object.keys(planned).at(-1), 'skipped_by_config');
});

test('CH-T3 full mock batch matches pre-refactor writes, progress, logs and events', async () => {
  // Only environment-dependent paths and the generated run UUID are normalized.
  const normalize = value => JSON.parse(JSON.stringify(value, (key, item) =>
    key === 'runtimeDir' ? '<runtime-dir>' : key === 'run_id' && item ? '<run-id>' : item));
  const expected = JSON.parse(await readFile(new URL('./stations-batch-before.json', import.meta.url), 'utf8'));
  const h = batchFixture(), progress = [], writes = [];
  const code = await h.run({ args: ['--stations', 'SFO01,MFR01', '--progress-file', 'fixture-progress.json'],
    now: () => new Date(at), progressWriter: async (file, value) => progress.push(JSON.parse(value)),
    writeBatch: async value => { writes.push(structuredClone(value)); return 'synthetic.json'; } });
  assert.deepEqual(normalize({ code, writes, progress, logs: h.logs, events: h.events }), expected);
});
