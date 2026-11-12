import { writePageFailureDiagnostic } from '../src/dms/batch-diagnostics.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runRouteDetailsBatch, parseBatchArgs, selectBatchRoutes, diagnosticMessage } from '../bin/dms-scrape-route-details.js';
import { withPortraitPage, checkDmsLanguage, DmsLanguageError, SelectorError, CaptureError } from '../src/dms/portrait-page.js';
import { confirmPortraitRoute, closeRouteDetailModals } from '../src/dms/route-detail-page.js';
import { listCachedRouteIds, saveRouteDetail, writeRouteDetailsBatchRun, RouteDetailInvalidError } from '../src/store/route-details-file.js';
import { transformRouteDetail } from '../src/transform/route-detail.js';
import { parseRouteDetailBatchDelay, parseMaxRouteDetailBatchRequests, parseMaxRouteDetailBatchProdApiRequests } from '../src/config.js';
import { profileText } from '../../web/format.js';

// Synthetic page/file doubles only; no session or runtime directory is read.
const records = [1, 2, 3].map(id => ({ roadAreaId: id, roadAreaName: `MOCK-00${id}`, transitStationName: 'SFO01' }));
const result = id => ({ contentBody: { data: [] }, headerBody: { data: { roadAreaName: `MOCK-00${id}`, postalCodeNum: 0 } }, capacityBody: { data: [] } });
const request = suffix => ({ url: () => `https://example.invalid/prod-api/${suffix}?token=DO_NOT_LOG`, method: () => 'POST',
  postDataJSON: () => ({ transitStationCodeList: ['SFO01'], pageSize: 100 }) });

function pageSession({ body = { data: { records, total: 3 } }, startup = [], status, password = false,
  english = false, nextBodies = [], nextButtons = 1, nextEnabled = true, nextQuery = {}, modalVisible = false, nextRequests = 1 } = {}) {
  const page = new EventEmitter(), events = [];
  let launches = 0, closes = 0, queries = 0, login = false, pageNum = 1, responseNumber = 0;
  let showPassword;
  const passwordAppeared = new Promise(resolve => { showPassword = resolve; });
  const locator = selector => ({
    count: async () => selector === 'header .dbu-web-main-dropdown-trigger:visible' ? 0 : selector === 'input[type=password]' ? Number(password) : selector.includes('next-btn') ? nextButtons : 1,
    isEnabled: async () => nextEnabled,
    getAttribute: async () => null,
    fill: async value => events.push(`filter:${value}`),
    evaluateAll: async fn => {
      const oldStyle = globalThis.getComputedStyle;
      globalThis.getComputedStyle = () => ({ visibility: 'visible' });
      try { return fn(modalVisible ? [{ getClientRects: () => [{}], textContent: '路区画像详情' }] : []); }
      finally { globalThis.getComputedStyle = oldStyle; }
    },
    nth: () => locator(selector), first: () => locator(selector), filter: () => locator(selector),
    locator, getByText: () => locator('station'), innerText: async () => '转运站点',
    waitFor: () => passwordAppeared,
    click: async () => { events.push(selector); if (selector.includes('next-btn')) {
      pageNum++; for (let i = 0; i < nextRequests; i++) page.emit('request', request('roadAreaPortrait/home/frontPage/queryList/pagination'));
    } },
  });
  page.locator = locator; page.getByText = () => locator('展开');
  page.getByRole = (_, { name }) => ({ count: async () => Number(english ? name.test("Search") : name.test("查询")), click: async () => {
    queries++; page.emit('request', request('roadAreaPortrait/home/frontPage/queryList/pagination'));
  } });
  page.keyboard = { press: async key => events.push(key) };
  page.goto = async () => { for (const suffix of startup) page.emit('request', request(suffix)); };
  page.url = () => `https://example.invalid/${login ? 'login' : 'areaDepiction'}`;
  page.mainFrame = () => page;
  page.waitForResponse = async predicate => {
    const number = ++responseNumber;
    const req = { ...request('dlvs-dataApi/roadAreaPortrait/home/frontPage/queryList/pagination'),
      postDataJSON: () => ({ transitStationCodeList: ['SFO01'], pageSize: 100, pageNum: number, ...(number > 1 ? nextQuery : {}) }) };
    const response = { url: req.url, request: () => req, json: async () => number === 1 ? body : nextBodies[number - 2] };
    assert.equal(predicate(response), true); return response;
  };
  page.waitForTimeout = async ms => {
    events.push(`delay:${ms}`);
    if (status) page.emit('response', { url: request('mock').url, status: () => status });
  };
  page.screenshot = async () => { events.push('screenshot'); if (closes) throw new Error('closed'); };
  const browserType = { launch: async () => {
    launches++; return { newContext: async () => ({ newPage: async () => page }), close: async () => { events.push('browser-close'); closes++; } };
  } };
  const session = (options, callback) => withPortraitPage({ ...options, browserType }, callback);
  return { page, events, session, get launches() { return launches; }, get closes() { return closes; }, get queries() { return queries; },
    navigateToLogin: () => { login = true; page.emit('framenavigated', page); }, showPassword };
}

function batchHarness(extra = {}) {
  const h = pageSession(extra), logs = [], runs = [], failures = [], saved = [], signals = new EventEmitter();
  let active = 0, maxActive = 0;
  const options = {
    args: ['--station', 'SFO01'], env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction' },
    log: line => logs.push(line), errorLog: line => logs.push(line), signals,
    sessionExists: async () => {}, session: h.session, cachedIds: async () => new Set(),
    cachedDetail: async () => ({ fetched_at: '2026-01-01T00:00:00Z' }),
    save: async ({ route }) => { saved.push(route.route_id); h.events.push(`save:${route.route_id}`); },
    writeRun: async ({ record }) => runs.push(structuredClone(record)), failure: async value => failures.push(value),
    diagnosticFileOps: { mkdir: async () => {}, writeFile: async () => {}, rename: async () => {}, rm: async () => {} },
    capture: async (context, { routeId }) => {
      active++; maxActive = Math.max(maxActive, active); h.events.push(`capture:${routeId}`);
      await context.guarded(async () => {
        h.page.emit('request', request('roadAreaPortraitDetails/mock'));
        h.page.emit('request', request('roadAreaPortraitDetails/mock'));
      });
      active--; return result(routeId);
    },
    closeModals: async () => h.events.push('close'),
  };
  return { ...h, pageHarness: h, logs, runs, failures, saved, signals,
    get maxActive() { return maxActive; }, run: overrides => runRouteDetailsBatch({ ...options, ...overrides }) };
}

test('RD3 arguments, defaults and configuration reject unknown, duplicate and illegal values', () => {
  assert.deepEqual(parseBatchArgs(['--station', 'SFO01']), { station: 'SFO01', refresh: false, headless: false, maxRoutes: null });
  assert.equal(parseBatchArgs(['--station', 'SFO01', '--max-routes', '3', '--refresh', '--headless']).maxRoutes, 3);
  for (const args of [[], ['--station'], ['--station', 'MFR01'], ['--station', 'SFO01', '--unknown'],
    ['--station', 'SFO01', '--station', 'SFO01'], ['--station', 'SFO01', '--headless', '--headless'],
    ['--station', 'SFO01', '--refresh', '--refresh'], ['--station', 'SFO01', '--max-routes', '2', '--max-routes', '3']]) assert.throws(() => parseBatchArgs(args));
  for (const value of ['0', '-1', '1.5', 'x', 'Infinity', '9007199254740992', '']) assert.throws(() => parseBatchArgs(['--station', 'SFO01', '--max-routes', value]));
  for (const [parse, fallback, min] of [[parseRouteDetailBatchDelay, 4000, 2000], [parseMaxRouteDetailBatchRequests, 800, 1], [parseMaxRouteDetailBatchProdApiRequests, 1000, 1]]) {
    assert.equal(parse(), fallback); assert.equal(parse(String(min)), min);
    for (const value of ['', ' ', 'x', '-1', '1.2', String(min - 1), '9007199254740992']) assert.throws(() => parse(value));
  }
  assert.match(profileText.scrapeHint('MOCK'), /--station MOCK/);
  assert.match(profileText.scrapeHint(), /--station SFO01/);
});

test('RD3 validates the complete station target list before any click', async () => {
  assert.deepEqual(selectBatchRoutes({ data: { records: [...records].reverse() } }, 'SFO01').map(row => row.route_id), [3, 2, 1]);
  for (const change of [{ roadAreaName: null }, { roadAreaName: 'https://secret' }, { roadAreaName: 'MOCK-001' }, { roadAreaId: 1 }, { roadAreaId: '01' }, { roadAreaId: 0 }, { roadAreaId: 'bad' }]) {
    const h = batchHarness({ body: { data: { records: [records[0], { ...records[2], ...change }], total: 2 } } });
    assert.equal(await h.run(), 1); assert.deepEqual(h.saved, []); assert.ok(h.pageHarness.closes);
    assert.equal(h.events.filter(event => event.startsWith('capture:')).length, 0);
  }
});

test('RD3 one browser and one list query, page-order serial capture, immediate writes and bounded delay', async () => {
  const h = batchHarness(); assert.equal(await h.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction',
    MAX_ROUTE_DETAIL_REQUESTS: '2', MAX_ROUTE_DETAIL_BATCH_REQUESTS: '6', MAX_ROUTE_DETAIL_BATCH_PROD_API_REQUESTS: '7', MAX_PAGE_LOADS_PER_STATION: '1' } }), 0);
  assert.equal(h.pageHarness.launches, 1); assert.equal(h.pageHarness.queries, 1); assert.ok(h.pageHarness.closes);
  assert.equal(h.maxActive, 1); assert.deepEqual(h.saved, [1, 2, 3]);
  assert.deepEqual(h.events.filter(event => /^(capture|save|close|delay)/.test(event)),
    ['capture:1', 'save:1', 'close', 'delay:4000', 'capture:2', 'save:2', 'close', 'delay:4000', 'capture:3', 'save:3', 'close']);
  const record = h.runs[0];
  assert.equal(record.status, 'completed'); assert.equal(record.target_count, 3); assert.equal(record.written_count, 3);
  assert.equal(record.detail_requests, 6); assert.equal(record.max_route_detail_requests, 2); assert.equal(record.prod_api_requests, 7);
  assert.equal(record.list_requests, 1); assert.equal(record.failed_count, 0); assert.equal(record.not_run_count, 0);
  for (const key of ['started_at', 'finished_at', 'station', 'refresh', 'max_routes', 'stop_reason', 'stopped_at_route', 'duration_ms', 'cached_not_in_list']) assert.ok(Object.hasOwn(record, key));
  assert.equal(h.logs.filter(line => line.startsWith('计划')).length, 2);
  assert.doesNotMatch(h.logs.join('\n'), /https?:|DO_NOT_LOG|token=/);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
});

test('RD3-14 method/attempt records and summary preserve write-close-restore ordering', async () => {
  const h = batchHarness({ body: { data: { records: [...records, { roadAreaId: 4, roadAreaName: 'MOCK-004', transitStationName: 'SFO01' }], total: 4 } } });
  const methods = ['L1', 'L2', 'L3', 'L5'];
  assert.equal(await h.run({ capture: async (_context, { routeId }) => ({ ...result(routeId),
    locateMethod: methods[routeId - 1], attempts: methods.slice(0, routeId - 1),
    ...(routeId === 4 ? { restoreList: async () => h.events.push('restore') } : {}) }) }), 0);
  assert.deepEqual(h.runs[0].locate_method_counts, { L1: 1, L2: 1, L3: 1, L5: 1 });
  assert.deepEqual(h.runs[0].routes.map(route => route.locate_method), methods);
  assert.deepEqual(h.runs[0].routes[3].attempts, ['L1', 'L2', 'L3']);
  assert.deepEqual(h.events.slice(-4), ['save:4', 'close', 'restore', 'browser-close']);
  assert.match(h.logs.join('\n'), /locate_method=L5 attempts=\["L1","L2","L3"\]/);
  assert.match(h.logs.join('\n'), /定位方法：\{"L1":1,"L2":1,"L3":1,"L5":1\}/);
});

test('RD3-15 retry metadata reaches run records and sanitized failure diagnostics', async () => {
  const success = batchHarness();
  assert.equal(await success.run({ capture: async (_context, { routeId }) => ({ ...result(routeId), click_retry: 1, click_late: true, click_wait_reason: 'navigation_wait' }) }), 0);
  assert.ok(success.runs[0].routes.every(route => route.click_retry === 1));
  assert.ok(success.runs[0].routes.every(route => route.click_late === true && route.click_wait_reason === 'navigation_wait'));
  assert.equal(success.runs[0].diagnostic, null);
  const failure = batchHarness();
  let diagnostic;
  assert.equal(await failure.run({ capture: async () => {
    throw Object.assign(new SelectorError('portrait', { cause: new Error('Timeout 3000ms https://example.invalid/private\nCall log: DO_NOT_LOG') }),
      { click_retry: 1, click_wait_reason: 'intercepted' });
  }, diagnosticFileOps: { mkdir: async () => {}, rename: async () => {}, rm: async () => {},
    writeFile: async (_filename, value) => { diagnostic = JSON.parse(value); } } }), 1);
  assert.equal(failure.runs[0].routes[0].click_retry, 1);
  assert.equal(diagnostic.click_retry, 1);
  assert.equal(diagnostic.click_wait_reason, 'intercepted');
  assert.doesNotMatch(JSON.stringify(diagnostic), /https?:|private|DO_NOT_LOG|Call log/);
  assert.deepEqual(failure.saved, []);
  assert.equal(failure.runs[0].routes[1].result, 'not_run');
});

test('RD3-14 failed location records attempted levels and writes diagnostic without continuing', async () => {
  const h = batchHarness();
  const attempts = ['L1', 'L2', 'L3', 'L5:unavailable'];
  assert.equal(await h.run({ capture: async () => { throw Object.assign(new SelectorError('画像详情定位失败'), { attempts }); } }), 1);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.runs[0].routes[0].attempts, attempts);
  assert.equal(h.runs[0].routes[0].locate_method, null);
  assert.deepEqual(h.runs[0].locate_method_counts, { L1: 0, L2: 0, L3: 0, L5: 0 });
  assert.ok(h.runs[0].diagnostic.json); assert.ok(h.events.includes('screenshot'));
  assert.equal(h.runs[0].routes[1].result, 'not_run');
  assert.match(h.logs.join('\n'), /L5:unavailable/);
});

test('RD3-14 L5 increases list budget by exactly two and restores after saving', async () => {
  for (const extra of [false, true]) {
    const h = batchHarness({ nextBodies: [{ data: { records: [records[0]], total: 1 } }, { data: { records, total: 3 } }] });
    assert.equal(await h.run({ args: ['--station', 'SFO01', '--max-routes', '1'],
      env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', MAX_PAGE_LOADS_PER_STATION: '1' },
      capture: async context => {
        context.allowNameFilter();
        const input = context.page.locator('synthetic-input');
        const filtered = await context.queryRouteName(input, 'MOCK-001', 1000);
        assert.deepEqual(filtered.data.records, [records[0]]);
        return { ...result(1), locateMethod: 'L5', attempts: ['L1', 'L2', 'L3'], restoreList: async () => {
          const restored = await context.queryRouteName(input, '', 1000);
          assert.deepEqual(restored.data.records, records);
          if (extra) context.page.emit('request', request('roadAreaPortrait/home/frontPage/queryList/pagination'));
        } };
      } }), extra ? 1 : 0);
    assert.equal(h.runs[0].list_requests, extra ? 4 : 3);
    assert.equal(h.runs[0].routes[0].result, 'written');
    assert.equal(h.runs[0].routes[0].locate_method, 'L5');
    assert.ok(h.events.indexOf('save:1') < h.events.indexOf('filter:'));
  }
});

test('RD3 skip, refresh and max-routes count only actual captures; absent cache IDs are retained', async () => {
  for (const refresh of [false, true]) {
    const h = batchHarness();
    assert.equal(await h.run({ args: ['--station', 'SFO01', '--max-routes', '1', ...(refresh ? ['--refresh'] : [])], cachedIds: async () => new Set([1, 99]) }), 0);
    assert.deepEqual(h.saved, [refresh ? 1 : 2]);
    assert.deepEqual(h.runs[0].cached_not_in_list, [99]);
    assert.equal(h.runs[0].skipped_count, refresh ? 0 : 1);
    assert.equal(h.runs[0].not_run_count, refresh ? 2 : 1);
    assert.equal(h.events.some(event => event.startsWith('delay')), false);
  }
  const h = batchHarness();
  assert.equal(await h.run({ cachedIds: async () => new Set([1, 2, 3]) }), 0);
  assert.equal(h.runs[0].skipped_count, 3); assert.deepEqual(h.saved, []);
});

test('RD4 raw cache keys control skipping, including null values, partial and legacy records', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'nc-rd4-synthetic-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  for (const id of [1, 2, 3]) {
    const input = result(id);
    input.contentBody.data = [{ postalCode: '00123' }, { postalCode: '00456' }];
    if (id === 1) delete input.capacityBody;
    const route = transformRouteDetail(input, { station: 'SFO01', routeId: id, fetchedAt: '2026-10-05T12:00:00Z' }).route;
    if (id === 2) delete route.zips[1].pickup_volume_daily;
    await saveRouteDetail({ runtimeDir, route });
  }
  const cached = await listCachedRouteIds({ runtimeDir });
  assert.deepEqual(cached.missingPickup, new Set([1, 2]));
  const h = batchHarness();
  assert.equal(await h.run({ cachedIds: async () => cached }), 0);
  assert.deepEqual(h.saved, [1, 2]); assert.equal(h.runs[0].skipped_count, 1);
  assert.ok(h.logs.some(line => line.includes('缺领件量重抓 2 条')));
  assert.ok(h.logs.some(line => line.includes('预计请求约 54 个')));
});

test('RD4 seventeen detail requests per route stay within defaults with exactly one complete write', async () => {
  const h = batchHarness();
  assert.equal(await h.run({ capture: async (context, { routeId }) => {
    for (let i = 0; i < 17; i++) await context.guarded(() => h.page.emit('request', request('roadAreaPortraitDetails/mock')));
    return result(routeId);
  }, save: async ({ route }) => {
    assert.deepEqual(route.capacity_raw, []); h.saved.push(route.route_id);
  } }), 0);
  assert.deepEqual(h.saved, [1, 2, 3]); assert.equal(h.runs[0].detail_requests, 51);
  assert.equal(h.runs[0].max_route_detail_requests, 17); assert.equal(h.runs[0].prod_api_requests, 52);
});

test('RD3 corrupt cache, missing session and bad configuration never launch a browser', async () => {
  for (const overrides of [{ cachedIds: async () => { throw new RouteDetailInvalidError(); } },
    { sessionExists: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } },
    { env: { DMS_BASE_URL: 'https://example.invalid', ROUTE_DETAIL_BATCH_DELAY_MS: '1999' } }]) {
    const h = batchHarness(); assert.equal(await h.run(overrides), 1);
    assert.equal(h.pageHarness.launches, 0); assert.equal(h.runs[0].status, 'stopped'); assert.equal(h.failures.length, 1);
  }
});

const secondPage = { data: { records: [{ roadAreaId: 4, roadAreaName: 'MOCK-004', transitStationName: 'SFO01' }], total: 150, current: 2, size: 100 } };
test('RD3 paging processes response order then advances once, records loaded pages and total', async () => {
  const h = batchHarness({ body: { data: { records: [...records].reverse(), total: 150 } }, nextBodies: [secondPage] });
  assert.equal(await h.run(), 0); assert.deepEqual(h.saved, [3, 2, 1, 4]);
  const next = h.events.indexOf('.vxe-pager .vxe-pager--next-btn:visible');
  assert.ok(next > h.events.indexOf('save:1')); assert.ok(next < h.events.indexOf('capture:4'));
  assert.equal(h.events[next - 1], 'delay:4000');
  assert.equal(h.events.filter(event => event.includes('next-btn')).length, 1);
  assert.equal(h.pageHarness.queries, 1);
  assert.equal(h.runs[0].total, 150); assert.equal(h.runs[0].pages_loaded, 2); assert.equal(h.runs[0].list_requests, 2);
  assert.deepEqual(h.runs[0].routes.map(route => route.route_id), [3, 2, 1, 4]);
});

test('RD3 one page keeps original request count; cached pages advance; max-routes prevents advancing', async () => {
  const one = batchHarness({ body: { data: { records, total: 36 } } });
  assert.equal(await one.run(), 0); assert.equal(one.runs[0].total, 36); assert.equal(one.runs[0].list_requests, 1);
  assert.equal(one.events.some(event => event.includes('next-btn')), false);
  const cached = batchHarness({ body: { data: { records, total: 150 } }, nextBodies: [secondPage] });
  assert.equal(await cached.run({ cachedIds: async () => new Set([1, 2, 3]) }), 0); assert.deepEqual(cached.saved, [4]);
  const limited = batchHarness({ body: { data: { records, total: 150 } }, nextBodies: [secondPage] });
  assert.equal(await limited.run({ args: ['--station', 'SFO01', '--max-routes', '3'] }), 0);
  assert.equal(limited.events.some(event => event.includes('next-btn')), false);
  assert.equal(limited.runs[0].pages_loaded, 1); assert.equal(limited.runs[0].routes.length, 3);
});

test('RD3 invalid next controls, modal, empty or duplicate pages and wrong pagination stop without retry', async () => {
  for (const extra of [{ nextButtons: 0 }, { nextButtons: 2 }, { nextEnabled: false }, { modalVisible: true },
    { nextBodies: [{ data: { ...secondPage.data, records: [] } }] },
    { nextBodies: [{ data: { ...secondPage.data, records: [records[0]] } }] },
    { nextBodies: [{ data: { ...secondPage.data, records: [{ ...secondPage.data.records[0], roadAreaName: records[0].roadAreaName }] } }] },
    { nextQuery: { pageNum: 3 } }, { nextQuery: { pageSize: 20 } }, { nextQuery: { transitStationCodeList: ['OTHER'] } },
    { nextBodies: [{ data: { ...secondPage.data, current: 1 } }] }]) {
    const h = batchHarness({ body: { data: { records, total: 150 } }, nextBodies: [secondPage], ...extra });
    assert.equal(await h.run(), 1); assert.deepEqual(h.saved, [1, 2, 3]);
    assert.ok(h.pageHarness.closes); assert.ok(h.events.filter(event => event.includes('next-btn')).length <= 1);
    assert.equal(h.runs[0].routes.length, 3);
  }
});

test('RD3 paging list budget is initial limit plus one per next click; ten pages is absolute', async () => {
  for (const [nextRequests, expected] of [[1, 0], [2, 1]]) {
    const h = batchHarness({ body: { data: { records, total: 150 } }, nextBodies: [secondPage], nextRequests });
    assert.equal(await h.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', MAX_PAGE_LOADS_PER_STATION: '1' } }), expected);
    if (expected) assert.match(h.runs[0].stop_reason, /LoadLimitError/);
  }
  const h = batchHarness({ body: { data: { records, total: 1001 } } });
  assert.equal(await h.run(), 1); assert.match(h.runs[0].stop_reason, /LoadLimitError/); assert.deepEqual(h.saved, []);
});

test('RD3 ten pages move forward only, with cumulative budget and max-routes across pages', async () => {
  const nextBodies = Array.from({ length: 9 }, (_, i) => ({ data: {
    records: [{ roadAreaId: i + 4, roadAreaName: `MOCK-00${i + 4}`, transitStationName: 'SFO01' }],
    total: 1000, current: i + 2, size: 100,
  } }));
  const h = batchHarness({ body: { data: { records, total: 1000 } }, nextBodies });
  assert.equal(await h.run({ cachedIds: async () => new Set(Array.from({ length: 12 }, (_, i) => i + 1)),
    env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', MAX_PAGE_LOADS_PER_STATION: '1' } }), 0);
  assert.equal(h.runs[0].pages_loaded, 10); assert.equal(h.runs[0].list_requests, 10);
  assert.equal(h.events.filter(event => event.includes('next-btn')).length, 9); assert.equal(h.pageHarness.queries, 1);
  const limited = batchHarness({ body: { data: { records, total: 1000 } }, nextBodies });
  assert.equal(await limited.run({ args: ['--station', 'SFO01', '--max-routes', '4'] }), 0);
  assert.deepEqual(limited.saved, [1, 2, 3, 4]); assert.equal(limited.runs[0].pages_loaded, 2);
  assert.equal(limited.events.filter(event => event.includes('next-btn')).length, 1);
});

test('RD3 pre-write versus post-write failures stop without retry and retain correct results', async () => {
  for (const phase of ['capture', 'transform', 'store', 'close']) {
    const h = batchHarness(), overrides = {};
    if (phase === 'capture' || phase === 'transform') overrides.capture = async (_context, { routeId }) => {
      h.events.push(`attempt:${routeId}`);
      if (routeId === 2) { if (phase === 'capture') throw new CaptureError(); return {}; }
      return result(routeId);
    };
    if (phase === 'store') overrides.save = async ({ route }) => { if (route.route_id === 2) throw new Error('https://secret?token=private'); h.saved.push(route.route_id); };
    if (phase === 'close') overrides.closeModals = async () => { if (h.saved.length === 2) throw new SelectorError('close'); };
    assert.equal(await h.run(overrides), 1);
    assert.deepEqual(h.saved, phase === 'close' ? [1, 2] : [1]);
    assert.equal(h.runs[0].routes[1].result, phase === 'close' ? 'written' : 'failed');
    assert.equal(h.runs[0].routes[2].result, 'not_run'); assert.equal(h.runs[0].stopped_at_route, 'MOCK-002');
    assert.doesNotMatch(h.logs.join('\n'), /https?:|private/);
  }
});

for (const [name, env] of [['per-route', { MAX_ROUTE_DETAIL_REQUESTS: '1' }], ['batch', { MAX_ROUTE_DETAIL_BATCH_REQUESTS: '3' }],
  ['prod-api', { MAX_ROUTE_DETAIL_BATCH_PROD_API_REQUESTS: '2' }], ['list', { MAX_PAGE_LOADS_PER_STATION: '1' }]]) {
  test(`RD3 ${name} ceiling stops, closes and never retries`, async () => {
    const h = batchHarness(name === 'list' ? { startup: ['roadAreaPortrait/home/frontPage/mock'] } : {});
    assert.equal(await h.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', ...env } }), 1);
    assert.match(h.runs[0].stop_reason, /LoadLimitError/); assert.ok(h.pageHarness.closes);
    assert.equal(h.pageHarness.launches, 1); assert.equal(h.pageHarness.queries, 1);
    assert.deepEqual(h.saved, name === 'batch' ? [1] : []);
  });
}

for (const status of [429, 500, 503, 599, 401]) {
  test(`RD3 ${status} during guarded delay preserves written route and stops`, async () => {
    const h = batchHarness({ status }); assert.equal(await h.run(), 1);
    assert.deepEqual(h.saved, [1]); assert.equal(h.runs[0].routes[0].result, 'written');
    assert.match(h.runs[0].stop_reason, status === 401 ? /NeedsLoginError/ : /CircuitBreakerError/);
    assert.ok(h.pageHarness.closes); assert.equal(h.events.filter(event => event.startsWith('capture')).length, 1);
  });
}

test('RD3 login page and password detection terminate the batch', async () => {
  const h = batchHarness();
  assert.equal(await h.run({ capture: async () => { h.pageHarness.navigateToLogin(); await new Promise(() => {}); } }), 1);
  assert.match(h.runs[0].stop_reason, /NeedsLoginError/); assert.ok(h.pageHarness.closes);
  const password = batchHarness({ password: true }); assert.equal(await password.run(), 1);
  assert.deepEqual(password.saved, []); assert.ok(password.pageHarness.closes);
  const appeared = batchHarness();
  assert.equal(await appeared.run({ capture: async () => { appeared.pageHarness.showPassword(); await new Promise(() => {}); } }), 1);
  assert.deepEqual(appeared.saved, []); assert.match(appeared.runs[0].stop_reason, /NeedsLoginError/);
  assert.ok(appeared.pageHarness.closes);
});

test('RD3 SIGINT before and after write exits 130, closes browser and records stopped', async () => {
  for (const after of [false, true]) {
    const h = batchHarness(), overrides = after
      ? { closeModals: async () => { h.signals.emit('SIGINT'); await new Promise(() => {}); } }
      : { capture: async () => { h.signals.emit('SIGINT'); await new Promise(() => {}); } };
    assert.equal(await h.run(overrides), 130); assert.ok(h.pageHarness.closes);
    assert.deepEqual(h.saved, after ? [1] : []);
    assert.equal(h.runs[0].status, 'stopped'); assert.equal(h.runs[0].routes[0].result, after ? 'written' : 'failed');
    assert.match(h.runs[0].stop_reason, /InterruptedError/); assert.equal(h.signals.listenerCount('SIGINT'), 0);
  }
});

test('RD3 store uses atomic upserts, validates cache and preserves old refresh data on failure', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'nc-rd3-synthetic-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const filename = path.join(runtimeDir, 'route-details.json');
  assert.deepEqual(await listCachedRouteIds({ runtimeDir }), new Set());
  await fs.writeFile(filename, '{broken'); await assert.rejects(listCachedRouteIds({ runtimeDir }), RouteDetailInvalidError);
  await fs.writeFile(filename, JSON.stringify({ schema_version: 1, routes: { '1': {} } }));
  await assert.rejects(listCachedRouteIds({ runtimeDir }), RouteDetailInvalidError);
  await fs.rm(filename);
  const makeRoute = id => ({ route_id: id, station: 'SFO01', route_name: `MOCK-00${id}`, source: 'dms-playwright',
    fetched_at: '2026-01-01T00:00:00Z', route_difficulty: null, route_difficulty_code: null, zip_count: 0, zips: [], parse_errors: [] });
  await saveRouteDetail({ runtimeDir, route: makeRoute(1) });
  const old = await fs.readFile(filename, 'utf8');
  const h = batchHarness();
  assert.equal(await h.run({ args: ['--station', 'SFO01', '--refresh'], cachedIds: () => listCachedRouteIds({ runtimeDir }),
    capture: async () => { throw new CaptureError(); }, save: ({ route }) => saveRouteDetail({ runtimeDir, route }) }), 1);
  assert.equal(await fs.readFile(filename, 'utf8'), old);
  await saveRouteDetail({ runtimeDir, route: makeRoute(99) });
  const profiles = path.join(runtimeDir, 'route-profiles.json');
  await fs.writeFile(profiles, 'synthetic profile sentinel');
  const preWrite = batchHarness();
  assert.equal(await preWrite.run({ capture: async (_context, { routeId }) => {
    if (routeId === 2) throw new CaptureError(); return result(routeId);
  }, save: ({ route, fileOps }) => saveRouteDetail({ runtimeDir, route, fileOps }) }), 1);
  assert.deepEqual(await listCachedRouteIds({ runtimeDir }), new Set([1, 99]));
  assert.equal(preWrite.runs[0].routes[1].result, 'failed');
  const next = batchHarness();
  assert.equal(await next.run({ save: async ({ route }) => {
    await saveRouteDetail({ runtimeDir, route });
    assert.ok((await listCachedRouteIds({ runtimeDir })).has(route.route_id));
  }, closeModals: async () => { if ((await listCachedRouteIds({ runtimeDir })).size === 3) throw new SelectorError('close'); } }), 1);
  assert.deepEqual(await listCachedRouteIds({ runtimeDir }), new Set([1, 2, 99]));
  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.deepEqual(data.routes['99'], makeRoute(99));
  assert.equal(await fs.readFile(profiles, 'utf8'), 'synthetic profile sentinel');
  await writeRouteDetailsBatchRun({ runtimeDir, record: next.runs[0] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtimeDir, 'route-details-batch-last-run.json'), 'utf8')), next.runs[0]);
  assert.deepEqual((await fs.readdir(runtimeDir)).sort(), ['route-details-batch-last-run.json', 'route-details.json', 'route-profiles.json']);
});

class Node {
  constructor(text, className = '', children = []) { this.value = text; this.className = className; this.children = children; this.attributes = {}; this.visible = true; children.forEach(child => { child.parent = this; }); }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === '*' || selector === `.${child.className}` ? [child] : []), ...child.querySelectorAll(selector)]); }
  getClientRects() { return this.visible ? [{}] : []; }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  closest(selector) { return selector === `.${this.className}` ? this : this.parent?.closest(selector); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
}
function domPage({ staleFor = 0, buttons = 1, stuck = false, tableVisible = true, visibleTables = Number(tableVisible),
  tableStaleFor = 0, tableError = false,
  initialName = new Node('路区名称：MOCK-OLD'), updatedName = '路区名称：MOCK-001' } = {}) {
  const close = () => Array.from({ length: buttons }, () => new Node('关闭', 'dbuMicroSysApp-modal-close'));
  const name = initialName;
  const portrait = new Node('', 'dbuMicroSysApp-modal-content', [new Node('路区画像详情', 'dbuMicroSysApp-modal-title'), name, ...close()]);
  const label = new Node('', 'dbuMicroSysApp-modal-content', [new Node('业务属性（产能）- 详情', 'dbuMicroSysApp-modal-title'), ...close(), new Node('提交反馈'), new Node('反馈记录')]);
  const nodes = [portrait, label], clicks = [], waits = [], steps = [], singleCalls = [];
  const tables = Array.from({ length: 3 }, () => new Node('', 'vxe-table--body-wrapper'));
  tables.forEach((table, index) => { table.visible = index < visibleTables; });
  let evaluations = 0, tableEvaluations = 0;
  const marked = key => nodes.flatMap(node => [node, ...node.querySelectorAll('*')]).filter(node => node.attributes[key]);
  const evaluate = (fn, elements, arg) => {
    const previousDocument = globalThis.document, previousStyle = globalThis.getComputedStyle;
    globalThis.document = { querySelectorAll: () => [...marked('data-rd3-close'), ...marked('data-rd3-modal')] };
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    try { return fn(elements, arg); }
    finally { globalThis.document = previousDocument; globalThis.getComputedStyle = previousStyle; }
  };
  const page = {
    locator: selector => {
      const matches = () => selector.includes('vxe-table--body-wrapper') ? tables
        : selector.includes('closing') ? marked('data-rd3-modal')
          : selector.includes('data-rd3-close') ? marked('data-rd3-close') : nodes;
      const single = method => {
        singleCalls.push({ selector, method });
        const targets = matches();
        if (targets.length !== 1) throw new Error('strict mode violation');
        return targets[0];
      };
      return {
      evaluateAll: async (fn, arg) => {
        if (selector.includes('vxe-table--body-wrapper')) {
          if (tableError) throw new Error('synthetic evaluation failure');
          const elements = tableEvaluations++ < tableStaleFor ? [] : tables;
          return evaluate(fn, elements, arg);
        }
        if (selector.includes('[role=')) {
          if (evaluations++ >= staleFor) name.value = updatedName;
          return evaluate(fn, [portrait], arg);
        }
        return evaluate(fn, selector.includes('closing') ? marked('data-rd3-modal') : nodes, arg);
      },
      click: async () => {
        const target = single('click');
        assert.equal(selector, '[data-rd3-close="close"]');
        const modal = target.closest('.dbuMicroSysApp-modal-content'); clicks.push(modal.children[0].textContent);
        if (!stuck) modal.visible = false;
      },
      isVisible: async () => single('isVisible').getClientRects().length > 0,
      textContent: async () => single('textContent').textContent,
    }; }, waitForTimeout: async ms => waits.push(ms),
  };
  const guarded = action => action(), control = async (step, action) => {
    steps.push(step);
    try { return await guarded(action); }
    catch (error) { throw error instanceof SelectorError ? error : new SelectorError(step); }
  };
  return { page, guarded, control, clicks, waits, steps, singleCalls };
}

test('RD3 actual name selector waits for stale route content and has a finite timeout', async () => {
  const h = domPage({ staleFor: 3 }); await confirmPortraitRoute(h.page, 'MOCK-001', h.guarded);
  assert.deepEqual(h.waits, [200, 200, 200]); assert.deepEqual(h.clicks, []);
  const stale = domPage({ staleFor: Infinity });
  await assert.rejects(confirmPortraitRoute(stale.page, 'MOCK-001', stale.guarded), SelectorError);
  assert.equal(stale.waits.length, 100);
});

test('RD3 actual name selector accepts a status tag in the same element', async () => {
  const h = domPage({ updatedName: '  路区名称：  MOCK-001部分新开  ' });
  await confirmPortraitRoute(h.page, 'MOCK-001', h.guarded);
  assert.deepEqual(h.waits, []);
});

test('RD3 actual name selector accepts label, name and tag in sibling spans via their parent', async () => {
  const h = domPage({ staleFor: Infinity, initialName: new Node('', '', [
    new Node('路区名称：'), new Node('MOCK-001'), new Node('部分新开'),
  ]) });
  await confirmPortraitRoute(h.page, 'MOCK-001', h.guarded);
  assert.deepEqual(h.waits, []);
});

test('RD3 actual name selector rejects longer route names and eventually times out', async () => {
  for (const suffix of ['0', 'A', 'z', '.', '_', '-']) {
    const h = domPage({ updatedName: `路区名称：MOCK-001${suffix}` });
    await assert.rejects(confirmPortraitRoute(h.page, 'MOCK-001', h.guarded),
      error => error instanceof SelectorError && error.message.endsWith('路区名称未匹配'));
    assert.equal(h.waits.length, 100);
    assert.ok(h.waits.every(ms => ms === 200));
  }
});

test('RD3 actual name selector waits for an old name with a status tag to update', async () => {
  const h = domPage({ staleFor: 3, initialName: new Node('路区名称：MOCK-OLD部分新开'),
    updatedName: '路区名称：MOCK-001部分新开' });
  await confirmPortraitRoute(h.page, 'MOCK-001', h.guarded);
  assert.deepEqual(h.waits, [200, 200, 200]);
  assert.deepEqual(h.clicks, []);
});

test('RD3 actual close selector closes only own buttons in inner-first order, never feedback', async () => {
  const h = domPage(); await closeRouteDetailModals(h);
  assert.deepEqual(h.clicks, ['业务属性（产能）- 详情', '路区画像详情']); assert.deepEqual(h.waits, []);
  for (const buttons of [0, 2]) {
    const bad = domPage({ buttons }); await assert.rejects(closeRouteDetailModals(bad), SelectorError); assert.deepEqual(bad.clicks, []);
  }
  const stuck = domPage({ stuck: true }); await assert.rejects(closeRouteDetailModals(stuck), SelectorError);
  assert.equal(stuck.waits.length, 50); assert.deepEqual(stuck.clicks, ['业务属性（产能）- 详情']);
  await assert.rejects(closeRouteDetailModals(domPage({ tableVisible: false })), SelectorError);
});

test('RD3 close tolerates three table matches with exactly one visible and avoids strict single calls', async () => {
  const h = domPage();
  await assert.rejects(h.page.locator('.vxe-table--main-wrapper .vxe-table--body-wrapper').isVisible(), /strict mode/);
  h.singleCalls.length = 0;
  await confirmPortraitRoute(h.page, 'MOCK-001', h.guarded);
  await closeRouteDetailModals(h);
  assert.deepEqual(h.steps, ['关闭业务属性（产能）- 详情', '关闭路区画像详情', '确认列表']);
  assert.deepEqual(h.singleCalls, Array.from({ length: 2 }, () => ({ selector: '[data-rd3-close="close"]', method: 'click' })));
  assert.deepEqual(h.waits, []);
});

test('RD3 close waits finitely for no visible table and rejects multiple visible tables immediately', async () => {
  const hidden = domPage({ visibleTables: 0 });
  await assert.rejects(closeRouteDetailModals(hidden), error => error instanceof SelectorError && error.message.endsWith('列表不可见'));
  assert.deepEqual(hidden.waits, Array(50).fill(200));
  const ambiguous = domPage({ visibleTables: 2 });
  await assert.rejects(closeRouteDetailModals(ambiguous), error => error instanceof SelectorError && error.message.endsWith('列表不唯一'));
  assert.deepEqual(ambiguous.waits, []);
  const delayed = domPage({ tableStaleFor: 3 });
  await closeRouteDetailModals(delayed);
  assert.deepEqual(delayed.waits, [200, 200, 200]);
});

test('RD3 close normalizes unexpected list evaluation errors with the confirmation stage', async () => {
  const h = domPage({ tableError: true });
  await assert.rejects(closeRouteDetailModals(h), error => error instanceof SelectorError && error.message.endsWith('确认列表'));
  assert.deepEqual(h.clicks, ['业务属性（产能）- 详情', '路区画像详情']);
  assert.deepEqual(h.waits, []);
});

test('RD3 runtime record write failure exits nonzero and writes last-failure', async () => {
  const h = batchHarness();
  assert.equal(await h.run({ writeRun: async () => { throw new Error('private'); } }), 1);
  assert.equal(h.failures.length, 1); assert.match(h.logs.join('\n'), /运行记录写入失败/);
});

test('RD3 interruption before atomic rename never commits the current route', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'nc-rd3-commit-synthetic-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const h = batchHarness();
  assert.equal(await h.run({ save: async ({ route, fileOps }) => saveRouteDetail({ runtimeDir, route,
    fileOps: { ...fileOps, writeFile: async (...args) => {
      await fs.writeFile(...args); h.signals.emit('SIGINT');
    } } }) }), 130);
  assert.deepEqual(await listCachedRouteIds({ runtimeDir }), new Set());
  assert.equal(h.runs[0].routes[0].result, 'failed');
  assert.deepEqual(await fs.readdir(runtimeDir), []);
  assert.ok(h.pageHarness.closes);
});

test('RD3 diagnostic first line follows innermost cause, strips URLs and fragments, bounds length', () => {
  for (const [message, expected] of [
    ['click timeout https://example.invalid/path?token=private\nCall log: secret', 'click timeout '],
    ['click timeout /path?token=private\nCall log: secret', 'click timeout /path'],
    ['click timeout /path#private', 'click timeout /path'],
    ['x'.repeat(350) + '\nprivate', 'x'.repeat(300)],
  ]) {
    const inner = new Error(message);
    assert.equal(diagnosticMessage(new SelectorError('画像详情', { cause: new Error('outer', { cause: inner }) })), expected);
  }
  const cyclic = new Error('cycle'); cyclic.cause = cyclic;
  assert.equal(diagnosticMessage(cyclic), 'cycle');
});

test('RD3 diagnostic uses control cause and screenshots before closing into runtime, atomically overwrites JSON', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'nc-rd3-diag-synthetic-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  for (const message of ['click timeout https://example.invalid/path?secret=yes\nCall log: private', 'x'.repeat(350)]) {
    const h = batchHarness(), original = new Error(message);
    let wrapped;
    h.page.screenshot = async options => {
      assert.equal(h.pageHarness.closes, 0);
      assert.equal(options.fullPage, false); assert.equal(options.timeout, 8000);
      assert.equal(options.path, path.join(runtimeDir, 'route-details-batch-failure.png'));
      h.events.push('screenshot'); await fs.writeFile(options.path, 'synthetic screenshot');
    };
    assert.equal(await h.run({ env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction', RUNTIME_DATA_DIR: runtimeDir },
      diagnosticFileOps: fs, capture: async context => {
        try { await context.control('画像详情', () => { throw original; }); }
        catch (error) { wrapped = error; throw error; }
      } }), 1);
    assert.equal(wrapped.cause, original);
    assert.equal(wrapped.message, '页面控件不可用：画像详情');
    const diagnostic = JSON.parse(await fs.readFile(path.join(runtimeDir, 'route-details-batch-failure.json'), 'utf8'));
    assert.deepEqual(diagnostic, { at: diagnostic.at, route_name: 'MOCK-001', route_id: 1,
      phase: 'capture', error_type: 'SelectorError', step: '画像详情', message_first_line: diagnosticMessage(original) });
    assert.ok(Number.isFinite(Date.parse(diagnostic.at)));
    assert.ok(h.events.indexOf('screenshot') < h.events.indexOf('browser-close'));
    assert.deepEqual(h.runs[0].diagnostic, { json: 'route-details-batch-failure.json', screenshot: 'route-details-batch-failure.png' });
    assert.ok(h.logs.includes('诊断：route-details-batch-failure.json、route-details-batch-failure.png'));
    assert.doesNotMatch(h.logs.join('\n'), /https?:|private|secret/);
    assert.deepEqual((await fs.readdir(runtimeDir)).sort(), ['route-details-batch-failure.json', 'route-details-batch-failure.png']);
  }
});

test('RD3 diagnostic screenshot failure after circuit breaker preserves JSON, reason and exit code', async () => {
  const h = batchHarness({ status: 429 });
  let written;
  assert.equal(await h.run({ diagnosticFileOps: {
    mkdir: async () => {}, writeFile: async (_filename, value) => { written = JSON.parse(value); },
    rename: async () => {}, rm: async () => {},
  } }), 1);
  assert.equal(written.error_type, 'CircuitBreakerError'); assert.equal(written.phase, 'delay');
  assert.equal(h.runs[0].stop_reason, 'delay:CircuitBreakerError');
  assert.deepEqual(h.runs[0].diagnostic, { json: 'route-details-batch-failure.json', screenshot: null });
  assert.equal(h.logs.filter(line => line.startsWith('诊断保存失败')).length, 1);
});

test('RD3 diagnostic write failure preserves stop reason and emits only one safe warning', async () => {
  for (const failAt of ['mkdir', 'writeFile', 'rename']) {
  const h = batchHarness();
  assert.equal(await h.run({ capture: async () => { throw new SelectorError('mock'); },
    diagnosticFileOps: { mkdir: async () => {}, rm: async () => {}, writeFile: async () => {}, rename: async () => {},
      [failAt]: async () => { throw new Error('private'); } } }), 1);
  assert.equal(h.runs[0].stop_reason, 'capture:SelectorError'); assert.equal(h.runs[0].diagnostic, null);
  assert.equal(h.logs.filter(line => line.startsWith('诊断保存失败')).length, 1);
  assert.doesNotMatch(h.logs.join('\n'), /private/);
  }
});

test('RD3 successful and non-page failures have no diagnostic', async () => {
  const success = batchHarness(); assert.equal(await success.run(), 0);
  assert.equal(success.runs[0].diagnostic, null); assert.ok(!success.events.includes('screenshot'));
  for (const phase of ['transform', 'store']) {
    const h = batchHarness();
    assert.equal(await h.run(phase === 'transform' ? { capture: async () => ({}) }
      : { save: async () => { throw new Error(); } }), 1);
    assert.equal(h.runs[0].diagnostic, null); assert.ok(!h.events.includes('screenshot'));
  }
});

test('RD3 failure callback is batch-only, bounded, preserves existing SelectorError and original failure', async () => {
  for (const mode of ['reject', 'hang', 'single']) {
    const h = pageSession(), original = new SelectorError('existing', { cause: new Error('inner') });
    let calls = 0;
    await assert.rejects(withPortraitPage({ browserType: { launch: async () => ({
      newContext: async () => ({ newPage: async () => h.page }), close: async () => h.events.push('closed'),
    }) }, station: 'SFO01', baseUrl: 'https://example.invalid/areaDepiction', batch: mode !== 'single',
      pageFailureTimeout: 10, onPageFailure: async () => {
        calls++; assert.ok(!h.events.includes('closed'));
        if (mode === 'hang') await new Promise(() => {}); else throw new Error('diagnostic');
      } }, context => context.control('outer', () => { throw original; })), error => error === original);
    assert.equal(calls, mode === 'single' ? 0 : 1); assert.ok(h.events.includes('closed'));
  }
});

test('English batch with missing language trigger keeps safe stop reason', async () => {
  const h = batchHarness({ english: true });
  assert.equal(await h.run(), 1);
  assert.equal(h.runs[0].stop_reason, 'capture:DmsLanguageError');
  const { safeStopReason, needsLogin } = await import('../src/api/freshness.js');
  assert.equal(safeStopReason(h.runs[0].stop_reason), h.runs[0].stop_reason);
  assert.equal(needsLogin(h.runs[0].stop_reason), false);
  assert.equal(h.pageHarness.queries, 0);
  assert.deepEqual(h.saved, []);
  assert.ok(!h.events.some(value => /展开|sizes|station|capture:/.test(value)));
  assert.match(h.logs.join(''), /中文/);
});

test('language guard tolerates absent or mixed controls and waits for late Search', async () => {
  for (const controls of [[], ['查询'], ['查询', 'Search'], ['SEARCH'], ['Search records']]) {
    const page = { getByRole: (_, { name }) => ({ count: async () => controls.filter(value => name.test(value)).length }) };
    const run = () => checkDmsLanguage({ page, guarded: action => action(), timeout: 0 });
    await assert.doesNotReject(run());
  }
  let englishReads = 0;
  const page = { getByRole: (_, { name }) => ({ count: async () => name.test('Search') ? Number(++englishReads > 1) : 0 }) };
  await assert.rejects(checkDmsLanguage({ page, guarded: action => action(), timeout: 500 }), DmsLanguageError);
  assert.equal(englishReads, 2);
});

test('global Station mode checks language before handing page to batch callback', async () => {
  const h = pageSession({ english: true });
  let called = false;
  await assert.rejects(h.session({ globalStationMode: true, batch: true,
    statePath: '/synthetic/state.json', baseUrl: 'https://example.invalid/areaDepiction' },
  async () => { called = true; }), DmsLanguageError);
  assert.equal(called, false);
  assert.equal(h.queries, 0);
  assert.deepEqual(h.events, ['browser-close']);
});


test('RD3-16 diagnostic total deadline is 9000ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finished = false;
  const pending = writePageFailureDiagnostic({ runtimeDir: '/synthetic/not-written',
    page: { screenshot: async () => new Promise(() => {}) }, error: new SelectorError('synthetic'),
    fileOps: { mkdir: async () => {} } }).then(value => { finished = true; return value; });
  await Promise.resolve();
  t.mock.timers.tick(8999);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, null);
});
