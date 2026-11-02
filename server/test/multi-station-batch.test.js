import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { batchFixture, record } from './multi-station-fixtures.js';
import { parseStationBatchArgs, parseStationBatchConfig, stationRequestCap } from '../src/config.js';
import { prepareStationBatchState, writeStationBatchFile, readStationBatchState } from '../src/store/station-batch-file.js';
import { switchStation } from '../src/dms/station-switch.js';
import { saveStationSnapshot } from '../src/store/route-profiles-file.js';
import { saveRouteDetail } from '../src/store/route-details-file.js';
import { withPortraitPage, SelectorError } from '../src/dms/portrait-page.js';
import { captureRouteDetailOnPage } from '../src/dms/route-detail-page.js';

test('RD3-15 station failure diagnostics preserve classified retry metadata', async () => {
  const h = batchFixture();
  let diagnostic;
  assert.equal(await h.run({ capture: async () => {
    throw Object.assign(new SelectorError('portrait', { cause: new Error('Timeout https://example.invalid/private\nCall log: DO_NOT_LOG') }),
      { click_retry: 1, click_wait_reason: 'not_stable' });
  }, diagnosticFileOps: { mkdir: async () => {}, rename: async () => {}, rm: async () => {},
    writeFile: async (_filename, value) => { diagnostic = JSON.parse(value); } } }), 1);
  assert.equal(diagnostic.click_retry, 1);
  assert.equal(diagnostic.click_wait_reason, 'not_stable');
  assert.doesNotMatch(JSON.stringify(diagnostic), /https?:|private|DO_NOT_LOG|Call log/);
});

test('MS missed automatic list continues through explicit query and records observation', async () => {
  const h = batchFixture({ lists: { MFR01: [record('MFR01', 2)] }, automaticListMissed: true });
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.saves, ['MFR01']);
  assert.equal(h.files[0].record.automatic_list_seen, false);
  assert.equal(h.files.at(-1).record.original_station_restored, true);
});
test('MS switch failure while reloading waits for header, restores original and preserves diagnostic cause', async () => {
  const h = batchFixture({ lists: { MFR01: [record('MFR01', 2)] },
    headerState: (station, elapsed) => ({ count: station === 'MFR01' && elapsed < 2000 ? 0 : 1 }) });
  let loads = 0;
  h.page.waitForLoadState = async () => { if (++loads === 1) throw new Error('reload interrupted\ncall log'); };
  const written = [];
  assert.equal(await h.run({ diagnosticFileOps: { mkdir: async () => {}, writeFile: async (_, value) => written.push(JSON.parse(value)),
    rename: async () => {}, rm: async () => {} } }), 1);
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.events.filter(event => event.startsWith('switch:')), ['switch:MFR01', 'switch:SFO01']);
  assert.equal(h.files.at(-1).record.original_station_restored, true);
  assert.equal(written[0].message_first_line, 'reload interrupted');
  assert.equal(h.events.filter(event => event === 'delay:200').length, 10);
});
test('MS observed automatic 500 trips breaker and closed browser records unrestored', async () => {
  const h = batchFixture({ lists: { MFR01: [record('MFR01', 2)] }, automaticListStatus: 500 });
  assert.equal(await h.run(), 1); assert.deepEqual(h.saves, []);
  assert.match(h.files.at(-1).record.stop_reason, /CircuitBreakerError/);
  assert.equal(h.files.at(-1).record.original_station_restored, false);
  assert.deepEqual(h.events.filter(event => event.startsWith('switch:')), ['switch:MFR01']);
});

test('MS arguments and caps validate conservative defaults', () => {
  assert.equal(parseStationBatchArgs([]).stations.length, 9);
  for (const args of [['--stations', 'SFO01,SFO01'], ['--stations', 'bad'], ['--max-routes-per-station', '0'], ['--unknown'], ['--refresh', '--refresh']]) assert.throws(() => parseStationBatchArgs(args));
  const config = parseStationBatchConfig({}); assert.equal(config.stationDelay, 15000); assert.equal(config.routeDelay, 2000);
  assert.equal(stationRequestCap(150, config), 3385);
  assert.throws(() => parseStationBatchConfig({ STATION_BATCH_DELAY_MS: '9999' }));
});
test('MS one session serial stations/routes, delays, snapshot and summaries', async () => {
  const h = batchFixture({ lists: { SFO01: [record('SFO01', 1), record('SFO01', 2)], MFR01: [record('MFR01', 3)] } });
  assert.equal(await h.run(), 0); assert.equal(h.pageHarness.launches, 1); assert.equal(h.maxActive, 1);
  assert.deepEqual(h.events.filter(value => /^(capture|save|delay|snapshot)/.test(value)),
    ['capture:1', 'save:1', 'delay:2000', 'capture:2', 'save:2', 'snapshot:SFO01', 'delay:15000', 'capture:3', 'save:3', 'snapshot:MFR01']);
  assert.equal(h.files.at(-1).record.original_station_restored, true);
  assert.equal(h.files.at(-1).record.success_count, 3);
  for (const key of ['station', 'status', 'route_total', 'success_count', 'skipped_cached_count', 'failed_count', 'zero_routes',
    'request_count', 'list_request_count', 'detail_request_count', 'station_request_cap', 'start_time', 'end_time',
    'duration_ms', 'locate_method', 'integrity', 'boundary_coverage', 'stop_reason']) assert.ok(Object.hasOwn(h.files[0].record, key));
  assert.equal(h.files[0].record.request_count, 3); assert.equal(h.files[1].record.request_count, 4);
  assert.equal(h.files.at(-1).record.request_count, 9);
  assert.equal(h.state.stations.MFR01.status, 'completed');
  assert.doesNotMatch(h.logs.join('\n'), /SECRET|https:\/\//);
});
test('MS genuine zero routes writes empty snapshot and continues', async () => {
  const h = batchFixture({ lists: { SFO01: [], MFR01: [record('MFR01', 2)] } });
  assert.equal(await h.run(), 0); assert.equal(h.files[0].record.zero_routes, true); assert.deepEqual(h.saves, ['SFO01', 'MFR01']);
});

test('MS logs each configured wait before it starts, including page transitions', async () => {
  const h = batchFixture({ lists: {
    SFO01: Array.from({ length: 101 }, (_, i) => record('SFO01', i + 1)), MFR01: [],
  }, waitEvent: async ms => {
    assert.equal(h.logs.at(-1), `等待：${ms === 12000 ? 'station' : 'route'}；${ms} ms；开始 2026-10-06T12:34:56.789Z`);
  } });
  assert.equal(await h.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction',
    ROUTE_DETAIL_BATCH_DELAY_MS: '3500', STATION_BATCH_DELAY_MS: '12000' },
  now: () => new Date('2026-10-06T12:34:56.789Z') }), 0);
  const waits = h.events.filter(value => value.startsWith('delay:'));
  const logs = h.logs.filter(value => value.startsWith('等待：'));
  assert.equal(waits.length, 101);
  assert.equal(logs.length, waits.length);
  assert.equal(logs.filter(value => value.startsWith('等待：route；3500 ms；')).length, 100);
  assert.equal(logs.filter(value => value.startsWith('等待：station；12000 ms；')).length, 1);
});
for (const options of [{ listStatus: 400 }, { missingTable: true, lists: { SFO01: [] } },
  { mutateBody: body => ({ ...body, data: { ...body.data, records: body.data.records.map(row => ({ ...row, transitStationName: 'RNO01' })) } }) }]) {
  test('MS invalid list or zero state stops without snapshot', async () => {
    const h = batchFixture(options); assert.equal(await h.run(), 1); assert.deepEqual(h.saves, []);
  });
}
test('MS single-pass 150 routes commits snapshot after all pages; limited records every active route', async () => {
  const h = batchFixture({ lists: { SFO01: Array.from({ length: 150 }, (_, i) => record('SFO01', i + 1)) } });
  assert.equal(await h.run({ args: ['--stations', 'SFO01', '--max-routes-per-station', '1'] }), 0);
  assert.equal(h.snapshots.SFO01.total, 150); assert.equal(h.files[0].record.status, 'limited');
  assert.equal(h.state.finished_at, null); assert.equal(h.files[0].record.list_request_count, 2);
  assert.equal(h.events.filter(value => value.startsWith('capture:')).length, 1);
});
test('MS later page mismatch retains detail, leaves snapshot untouched', async () => {
  const h = batchFixture({ lists: { SFO01: Array.from({ length: 150 }, (_, i) => record('SFO01', i + 1)) },
    mutateBody: (body, station, pageNum) => pageNum === 2 ? { ...body, data: { ...body.data, records: [{ ...body.data.records[0], transitStationName: 'MFR01' }, ...body.data.records.slice(1)] } } : body });
  assert.equal(await h.run({ args: ['--stations', 'SFO01', '--max-routes-per-station', '1'] }), 1);
  assert.deepEqual(h.saves, []); assert.ok(h.details['1']);
});
test('MS resumed completed station has no switch or query; limited station fills cache', async () => {
  const h = batchFixture();
  assert.equal(await h.run({ args: ['--stations', 'SFO01,MFR01', '--max-routes-per-station', '1'] }), 0);
  // A completed run creates a new run, preserving and skipping complete Route caches.
  const old = h.state.run_id;
  const next = prepareStationBatchState(h.state, ['SFO01', 'MFR01'], { at: new Date().toISOString() });
  assert.notEqual(next.run_id, old);
  const incomplete = { ...h.state, finished_at: null }; incomplete.stations.MFR01.status = 'limited';
  const page = batchFixture(); Object.assign(page.details, h.details);
  assert.equal(await page.run({ readState: async () => incomplete }), 0);
  assert.deepEqual(page.files.at(-1).record.skipped_stations, ['SFO01']);
  assert.equal(page.files.at(-1).record.skipped_cached_count, 1);
  assert.notEqual(prepareStationBatchState(incomplete, ['MFR01', 'SFO01'], { at: new Date().toISOString() }).run_id, old);
  assert.notEqual(prepareStationBatchState(incomplete, ['SFO01', 'MFR01'], { newRun: true, at: new Date().toISOString() }).run_id, old);
});
for (const status of [429, 503, 401]) test(`MS station wait stops on ${status}, no next station or restoration when browser closed`, async () => {
  const h = batchFixture({ waitEvent: async (ms, page, emit) => { if (ms === 15000) emit('background', status, {}); } });
  assert.equal(await h.run(), 1); assert.deepEqual(h.saves, ['SFO01']); assert.equal(h.files.at(-1).record.original_station_restored, false);
});
test('MS station/header identity checked before writes; absolute batch and temporary station caps stop', async () => {
  const h = batchFixture();
  assert.equal(await h.run({ capture: async () => { h.pageHarness.setStation('RNO01'); return { contentBody: { data: [] }, headerBody: { data: { roadAreaName: 'MOCK-1' } }, capacityBody: { data: [] } }; } }), 1);
  assert.deepEqual(h.details, {});
  for (const env of [{ MAX_MULTI_STATION_BATCH_REQUESTS: '1' }, { STATION_REQUEST_BASE: '1' }]) {
    const limited = batchFixture({ original: 'RNO01' });
    assert.equal(await limited.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', ...env } }), 1);
    assert.deepEqual(limited.saves, []);
  }
});
test('MS state and summary atomic file writes use only synthetic temporary directories', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'nc-ms-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const state = prepareStationBatchState(null, ['SFO01'], { at: new Date().toISOString() });
  await writeStationBatchFile({ runtimeDir, state }); assert.deepEqual(await readStationBatchState({ runtimeDir }), state);
  const filename = await writeStationBatchFile({ runtimeDir, state, station: 'SFO01', record: { status: 'completed' } });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeDir, filename), 'utf8')), { status: 'completed' });
});

for (const [name, mutate] of [
  ['complete cache', value => value], ['wrong station', value => { value.station = 'MFR01'; }],
  ['old name', value => { value.route_name = 'OLD'; }], ['missing pickup key', value => { delete value.zips[0].pickup_volume_daily; }],
  ['different ZIPs', value => { value.zips[0].postal_code = '00124'; }],
]) test(`MS cache ${name} determines skip/regrab`, async () => {
  const row = { ...record('SFO01', 1), postalCodeList: '00123', postalCodeNum: 1 };
  const h = batchFixture({ lists: { SFO01: [row] } });
  const detail = { route_id: 1, station: 'SFO01', route_name: 'MOCK-1', zips: [{ postal_code: '00123', pickup_volume_daily: null }] };
  mutate(detail); h.details['1'] = detail;
  assert.equal(await h.run(), 0);
  assert.equal(h.files[0].record.skipped_cached_count, name === 'complete cache' ? 1 : 0);
  assert.equal(h.files[0].record.success_count, name === 'complete cache' ? 0 : 1);
});
test('MS refresh regrabs a complete route, and limited station resumes missing route', async () => {
  const h = batchFixture({ lists: { SFO01: [record('SFO01', 1), record('SFO01', 2)] } });
  assert.equal(await h.run({ args: ['--stations', 'SFO01', '--max-routes-per-station', '1'] }), 0);
  const next = batchFixture({ lists: h.pageHarness.lists }); Object.assign(next.details, h.details);
  assert.equal(await next.run({ readState: async () => h.state }), 0);
  assert.equal(next.files[0].record.skipped_cached_count, 1); assert.equal(next.files[0].record.success_count, 1);
  const refreshed = batchFixture({ lists: { SFO01: [record('SFO01', 1)] } }); Object.assign(refreshed.details, h.details);
  assert.equal(await refreshed.run({ args: ['--stations', 'SFO01', '--refresh'] }), 0);
  assert.equal(refreshed.files[0].record.success_count, 1);
});
test('MS active snapshot removes old route while detail history is retained by real stores', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'nc-ms-history-')); t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(runtimeDir, 'route-profiles.json'), JSON.stringify({ schema_version: 1, stations: { SFO01: { total: 1, rows: [{ route_id: 999 }] } } }));
  await fs.writeFile(path.join(runtimeDir, 'route-details.json'), JSON.stringify({ schema_version: 1, routes: {} }));
  const h = batchFixture({ lists: { SFO01: [record('SFO01', 1)] } });
  assert.equal(await h.run({ saveSnapshot: value => saveStationSnapshot({ ...value, runtimeDir }),
    saveDetail: value => saveRouteDetail({ ...value, runtimeDir }) }), 0);
  const details = JSON.parse(await fs.readFile(path.join(runtimeDir, 'route-details.json'), 'utf8'));
  details.routes['999'] = { ...details.routes['1'], route_id: 999, route_name: 'OLD' };
  await fs.writeFile(path.join(runtimeDir, 'route-details.json'), JSON.stringify(details));
  // Replacing active profiles must not touch the separate detail file.
  await saveStationSnapshot({ runtimeDir, station: 'SFO01', stationSnapshot: { total: 0, rows: [] } });
  assert.ok(JSON.parse(await fs.readFile(path.join(runtimeDir, 'route-details.json'), 'utf8')).routes['999']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeDir, 'route-profiles.json'), 'utf8')).stations.SFO01.rows, []);
});
for (const [kind, pathPart, count] of [['station', 'background', 105], ['per-route', 'roadAreaPortraitDetails/mock', 31],
  ['list', 'roadAreaPortrait/home/frontPage/queryList/pagination', 4]]) test(`MS ${kind} request ceiling stops before write`, async () => {
  const h = batchFixture({ lists: { SFO01: [record('SFO01', 1)] } });
  assert.equal(await h.run({ capture: async context => { for (let i = 0; i < count; i++) h.pageHarness.emit(pathPart, 200, {});
    await context.guarded(async () => {}); } }), 1);
  assert.deepEqual(h.details, {}); assert.match(h.files.at(-1).record.stop_reason, /LoadLimitError/);
});
test('MS L5 list allowance adds two requests, invalid restoration stops and original restoration failure is recorded', async () => {
  const h = batchFixture({ lists: { SFO01: [record('SFO01', 1)] } });
  assert.equal(await h.run({ capture: async context => {
    context.allowNameFilter(); for (let i = 0; i < 4; i++) h.pageHarness.emit('roadAreaPortrait/home/frontPage/queryList/pagination', 200, {});
    return { contentBody: { data: [] }, headerBody: { data: { roadAreaName: 'MOCK-1' } }, capacityBody: { data: [] },
      restoreList: async () => { throw new SelectorError('Restoration mismatch'); } };
  } }), 1); assert.ok(h.details['1']); assert.match(h.files.at(-1).record.stop_reason, /SelectorError/);
  const failed = batchFixture({ lists: { MFR01: [] }, original: 'SFO01' });
  assert.equal(await failed.run({ switchTo: (context, station) => station === 'SFO01'
    ? Promise.reject(new Error('restore failed')) : switchStation(context, station) }), 0);
  assert.equal(failed.files.at(-1).record.original_station_restored, false);
});
test('MS stop during capture counts the failure, retains earlier details and diagnoses without raw URLs', async () => {
  const h = batchFixture();
  assert.equal(await h.run({ capture: async () => { throw new Error('https://example.invalid/?token=SECRET\ncall log SECRET'); } }), 1);
  assert.equal(h.files[0].record.failed_count, 1); assert.equal(h.state.stations.SFO01.status, 'stopped');
  assert.doesNotMatch(h.logs.join('\n'), /SECRET/);
});
test('MS global list query timeout stops and attempts original restoration', async () => {
  const h = batchFixture();
  const original = h.page.waitForResponse;
  h.page.waitForResponse = predicate => {
    const promise = original(predicate); promise.catch(() => {});
    return Promise.reject(new Error('synthetic timeout'));
  };
  assert.equal(await h.run(), 1); assert.deepEqual(h.saves, []);
  assert.equal(h.files.at(-1).record.original_station_restored, true);
});
test('MS cap formula freezes after first total, station counter resets and batch sum stays bounded', async () => {
  const h = batchFixture();
  await withPortraitPage({ browserType: h.browserType, globalStationMode: true, batch: true,
    statePath: '/synthetic', baseUrl: 'https://example.invalid/areaDepiction', maxProdApiRequests: 1000 }, async context => {
    context.beginStation(80); context.setStationCap(102); assert.equal(context.batchCap(), 102);
    assert.throws(() => context.setStationCap(103));
    context.beginStation(80); context.setStationCap(124); assert.equal(context.batchCap(), 226);
    assert.throws(() => context.setStationCap(100));
  });
});
test('MS failed final integrity stops before next station', async () => {
  const h = batchFixture();
  assert.equal(await h.run({ saveDetail: async ({ route }) => { route.station = 'RNO01'; } }), 1);
  assert.equal(h.files[0].record.integrity.passed, false);
  assert.match(h.files.at(-1).record.stop_reason, /IntegrityError/);
  assert.deepEqual(h.saves, []);
});
test('MS SIGINT during station delay stops the run and marks current station stopped', async () => {
  const h = batchFixture({ waitEvent: async ms => { if (ms === 15000) h.signals.emit('SIGINT'); } });
  assert.equal(await h.run(), 130); assert.equal(h.state.stations.SFO01.status, 'stopped');
  assert.equal(h.state.stations.MFR01.status, 'pending');
});
test('MS unconfirmed initial header produces diagnostic and stopped batch summary', async () => {
  const h = batchFixture({ headerCount: 2 }), written = [];
  assert.equal(await h.run({ diagnosticFileOps: { mkdir: async () => {}, writeFile: async (filename, value) => written.push(value),
    rename: async () => {}, rm: async () => {} } }), 1);
  assert.match(h.files.at(-1).record.stop_reason, /StationSwitchError/);
  assert.ok(written.some(value => JSON.parse(value).error_type === 'StationSwitchError'));
});
test('MS actual shared locator stops before L5 on second page', async () => {
  const previousStyle = globalThis.getComputedStyle;
  const previousDocument = globalThis.document;
  globalThis.document = { querySelectorAll: () => [] };
  globalThis.getComputedStyle = () => ({ visibility: 'visible', overflowY: 'visible' });
  const rect = () => ({ top: 0, bottom: 1, left: 0, right: 1 });
  const row = { getClientRects: () => [{}], getBoundingClientRect: rect, querySelectorAll: () => [{ textContent: 'OTHER' }] };
  const table = { classList: { contains: () => false }, getClientRects: () => [{}], querySelectorAll: () => [] };
  const body = { getClientRects: () => [{}], getBoundingClientRect: rect, closest: () => table,
    querySelectorAll: () => [row], scrollTop: 0, clientHeight: 1 };
  const page = { mouse: { move: async () => {}, wheel: async () => {} }, waitForTimeout: async () => {},
    locator: selector => ({ evaluateAll: async (fn, arg) => fn(selector.includes('fixed-right') ? []
      : selector.endsWith('tr[rowid]') ? [row] : [body], arg) }) };
  const context = { page, body: { data: { records: [{ roadAreaName: 'MOCK-1' }] } }, forbidNameFilter: true,
    guarded: async action => action(), control: async (step, action) => action() };
  try { await assert.rejects(captureRouteDetailOnPage(context, { routeName: 'MOCK-1', routeId: 1 }), /L5 不可用于第 2 页以后/); }
  finally { globalThis.getComputedStyle = previousStyle; globalThis.document = previousDocument; }
});
