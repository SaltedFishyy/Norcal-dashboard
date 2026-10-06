import { EventEmitter } from 'node:events';
import { withPortraitPage } from '../src/dms/portrait-page.js';
import { runStationsBatch } from '../bin/dms-scrape-stations.js';

export const record = (station, id) => ({ roadAreaId: id, roadAreaName: `MOCK-${id}`, transitStationName: station,
  postalCodeList: '', postalCodeNum: 0 });
export function stationPage({ lists = { SFO01: [record('SFO01', 1)], MFR01: [record('MFR01', 2)] },
  original = 'SFO01', switchStatus = 200, headerChanges = true, menuCount = 1, switchTimeout = false,
  listStatus = 200, missingTable = false, headerCount = 1, mutateBody = value => value, waitEvent,
  headerState, automaticListMissed = false, automaticListStatus = listStatus, networkIdleTimeout = false } = {}) {
  const page = new EventEmitter(), events = [], listeners = [];
  let station = original, pageNum = 1, querySize = 10, launches = 0, closed = false, requests = 0, elapsed = 0;
  const req = (route, method = 'POST', body = {}) => ({ url: () => `https://example.invalid/prod-api/${route}?token=SECRET`,
    method: () => method, postDataJSON: () => body });
  const emit = (route, status, body, method = 'POST', query = {}) => {
    const request = req(route, method, query), response = { request: () => request, url: request.url, status: () => status, json: async () => body };
    requests++; page.emit('request', request); page.emit('response', response);
    for (const pending of [...listeners]) if (pending.predicate(response)) { listeners.splice(listeners.indexOf(pending), 1); pending.resolve(response); }
  };
  const list = (status = listStatus) => {
    const all = lists[station] || [], data = { records: all.slice((pageNum - 1) * querySize, pageNum * querySize), total: all.length, current: pageNum, size: querySize };
    emit('dlvs-dataApi/roadAreaPortrait/home/frontPage/queryList/pagination', status,
      mutateBody({ success: true, data }, station, pageNum), 'POST', { pageNum, pageSize: querySize });
  };
  const locator = (selector, target) => ({
    count: async () => selector === 'input[type=password]' ? 0 : selector.includes('menu-item') ? menuCount
      : selector === 'header .dbu-web-main-dropdown-trigger span.groupCheck' ? (headerState?.(station, elapsed)?.count ?? headerCount) : 1,
    innerText: async () => headerState?.(station, elapsed)?.text ?? station, first: () => locator(selector, target), nth: () => locator(selector, target),
    filter: filter => locator(selector, filter.hasText?.source?.replace(/^\^\\s\*/, '').replace(/\\s\*\$$/, '')),
    isEnabled: async () => true, isVisible: async () => headerState?.(station, elapsed)?.visible ?? true, getAttribute: async () => null,
    waitFor: () => selector === 'input[type=password]' ? new Promise(() => {})
      : closed ? Promise.reject(new Error('closed')) : Promise.resolve(),
    evaluateAll: async fn => {
      const before = globalThis.getComputedStyle; globalThis.getComputedStyle = () => ({ visibility: 'visible' });
      try { return fn(missingTable || selector.includes('modal') ? [] : [{ getClientRects: () => [{}] }]); }
      finally { globalThis.getComputedStyle = before; }
    },
    click: async () => {
      if (closed) throw new Error('closed');
      events.push(`click:${selector}`);
      if (selector.includes('menu-item')) {
        // Model a long dropdown: target is outside the initial viewport; locator click scrolls it.
        if (!/^[A-Z]{3}\d{2}$/.test(target)) throw new Error('Non-exact menu item');
        events.push(`locator-scroll:${target}`);
        events.push(`switch:${target}`);
        if (switchTimeout) { for (const pending of listeners.splice(0)) pending.reject(new Error('timeout')); return; }
        emit('switch-org/1519', switchStatus, {}, 'GET');
        if (headerChanges) station = target;
        pageNum = 1; querySize = 10;
        if (automaticListMissed) {
          for (const pending of listeners.splice(0)) pending.reject(Object.assign(new Error('automatic list timeout'), { name: 'TimeoutError' }));
        } else list(automaticListStatus);
      } else if (selector.includes('select-option')) { querySize = 100; }
      else if (selector.includes('next-btn')) { pageNum++; list(); }
      else if (selector === 'query') { pageNum = 1; list(); }
    },
  });
  page.locator = locator; page.getByText = () => locator('expand'); page.getByRole = () => locator('query');
  page.url = () => 'https://example.invalid/areaDepiction'; page.mainFrame = () => page;
  page.goto = async () => { events.push('goto'); }; page.screenshot = async () => {};
  page.isClosed = () => closed;
  page.waitForLoadState = async (state, options) => {
    events.push(`load:${state}:${options.timeout}`);
    if (networkIdleTimeout) throw Object.assign(new Error('networkidle timeout'), { name: 'TimeoutError' });
  };
  page.waitForTimeout = async ms => { if (closed) throw new Error('closed'); elapsed += ms; events.push(`delay:${ms}`); await waitEvent?.(ms, page, emit); };
  page.waitForResponse = predicate => new Promise((resolve, reject) => listeners.push({ predicate, resolve, reject }));
  const browserType = { launch: async () => { launches++; return { newContext: async () => ({ newPage: async () => page }), close: async () => { closed = true; } }; } };
  return { page, events, browserType, emit, lists, setStation: value => { station = value; },
    get station() { return station; }, get launches() { return launches; }, get requests() { return requests; },
    context: { page, guarded: async action => action() } };
}
export function batchFixture(pageOptions = {}) {
  const h = stationPage(pageOptions), files = [], saves = [], logs = [], signals = new EventEmitter(), details = {}, snapshots = {};
  let state = null, active = 0, maxActive = 0;
  const run = overrides => runStationsBatch({ args: ['--stations', Object.keys(h.lists).join(',')], env: { DMS_BASE_URL: 'https://example.invalid/areaDepiction' },
    log: value => logs.push(value), errorLog: value => logs.push(value), signals, sessionExists: async () => {}, boundaryReader: async () => null,
    session: (options, callback) => withPortraitPage({ ...options, browserType: h.browserType }, callback),
    readDetails: async () => details, readProfiles: async () => ({ stations: snapshots }), readState: async () => state,
    writeBatch: async value => { if (value.record) files.push(structuredClone(value)); else state = structuredClone(value.state); return 'synthetic.json'; },
    saveSnapshot: async ({ station, stationSnapshot }) => { saves.push(station); snapshots[station] = stationSnapshot; h.events.push(`snapshot:${station}`); },
    saveDetail: async ({ route }) => { details[String(route.route_id)] = route; h.events.push(`save:${route.route_id}`); },
    capture: async (context, { routeId, routeName }) => {
      active++; maxActive = Math.max(maxActive, active); h.events.push(`capture:${routeId}`);
      await context.guarded(async () => h.emit('roadAreaPortraitDetails/mock', 200, {}));
      active--; return { contentBody: { data: [] }, headerBody: { data: { roadAreaName: routeName, postalCodeNum: 0 } }, capacityBody: { data: [] }, locateMethod: 'L1' };
    }, closeModals: async () => h.events.push('close'), diagnosticFileOps: { mkdir: async () => {}, writeFile: async () => {}, rename: async () => {}, rm: async () => {} }, ...overrides });
  return { ...h, pageHarness: h, run, files, saves, logs, details, snapshots, signals, get state() { return state; }, get maxActive() { return maxActive; } };
}
