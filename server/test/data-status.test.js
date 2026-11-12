import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDataStatus } from '../../web/data-status.js';
import { formatUpdated } from '../../web/format.js';
import { createStaticReader, isStaticPath } from '../src/api/static-files.js';
import { fileURLToPath } from 'node:url';

// Synthetic DOM and API doubles: no runtime data, Worker or DMS access.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.ownText = ''; }
  set textContent(text) { this.ownText = String(text); this.children = []; }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.ownText = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
}
const nodes = root => [root, ...root.children.flatMap(nodes)];
const find = (root, text) => nodes(root).find(n => n.tag === 'button' && n.textContent === text);
const iso = '2026-10-08T12:00:00Z';
test('DV default refresh reload removes date and preserves other URL context', async t => {
  const previous = globalThis.location;
  t.after(() => { if (previous === undefined) delete globalThis.location; else globalThis.location = previous; });
  let target, reloads = 0;
  globalThis.location = { search: '?station=A&date=2026-11-08', href: 'http://localhost/?station=A&date=2026-11-08#table', assign: value => { target = value; }, reload: () => reloads++ };
  const h = fixture({ capability: true, initialState: 'running', defaultReload: true });
  await h.page.start();
  h.data.state = { state: 'completed', progress: { ...progress(), finished_at: iso } }; await h.tick(2000);
  await h.click('数据已更新，点击重新加载'); assert.equal(target, 'http://localhost/?station=A#table');
  globalThis.location.search = '?station=A';
  await h.click('数据已更新，点击重新加载'); assert.equal(reloads, 1);
  h.page.dispose();
});
test('AR-T3 Worker status states, Pacific times, failure names and polling; readonly hides line', async () => {
  const readonly = fixture(); await readonly.page.start();
  assert.doesNotMatch(readonly.root.textContent, /自动刷新 ·/);
  assert.ok(!readonly.calls.some(c => c.url === '/api/auto-refresh/status')); readonly.page.dispose();
  const h = fixture({ autoCapability: true }); h.data.auto = { enabled: false };
  await h.page.start(); assert.match(h.root.textContent, /自动刷新 · 关闭/);
  h.data.auto = { enabled: true, time: '17:00', time_zone: 'America/Los_Angeles', next_run_at: '2026-11-13T01:00:00Z',
    last: { started_at: '2026-11-12T01:00:00Z', finished_at: '2026-11-12T02:00:00Z', result: 'completed',
      districts: [{ id: 'mock', status: 'completed' }] } };
  await h.tick(60000);
  assert.match(h.root.textContent, /每天 17:00（太平洋时间） · 上次：2026\/11\/11 18:00 完成 · 片区：成功 1 \/ 共 1 · 下次：2026\/11\/12 17:00/);
  for (const [result, label] of [['partial', '部分完成'], ['needs_login', '需要重新登录'], ['running', '进行中'], ['failed', '失败'], ['skipped_busy', '繁忙跳过']]) {
    h.data.auto.last.result = result;
    h.data.auto.last.districts = [{ id: 'ok', status: 'completed' }, ...[
      ['mock', 'list:SelectorError'], ['B', 'switch:StationSwitchError'], ['C', 'capture:NeedsLoginError'], ['D', 'worker:Restarted']
    ].map(([id, stop_reason]) => ({ id, stop_reason, status: 'stopped' }))];
    await h.tick(60000);
    assert.ok(h.root.textContent.includes(`18:00 ${label}`));
    assert.match(h.root.textContent, /片区：成功 1 \/ 共 5/);
    assert.match(h.root.textContent, /失败：合成片区（页面结构异常）、B（切换站点失败）、C（登录过期） 等 1 个/);
    assert.doesNotMatch(h.root.textContent, /D（/);
  }
  for (const [reason, label] of [['process:Exited', '进程中断'], ['worker:Restarted', '进程中断'], ['other:Error', '未知错误']]) {
    h.data.auto.last.districts = [{ id: 'mock', status: 'stopped', stop_reason: reason }];
    await h.tick(60000); assert.ok(h.root.textContent.includes(`合成片区（${label}）`));
  }
  h.page.dispose(); assert.equal(h.timers.size, 0);
});

test('AR-T3 readonly failure messages prioritize schedule, login and running without duplicates', async () => {
  const h = fixture();
  h.data.freshness.run = { running: false, last: { status: 'stopped', started_at: iso },
    auto_refresh: { day: '2026-11-11', failed: [{ district: 'mock', stop_reason: 'list:SelectorError' }], completed_count: 1, district_count: 2 } };
  await h.page.start();
  assert.match(h.root.textContent, /11\/11 17:00 自动更新部分失败：合成片区（页面结构异常）。其余片区已更新，当前显示的是各站点最近一次成功的数据。/);
  assert.doesNotMatch(h.root.textContent, /最近一次更新失败/);
  h.data.freshness.run.auto_refresh.district_count = 1;
  await h.page.loadFreshness(); assert.match(h.root.textContent, /自动更新失败：/); assert.doesNotMatch(h.root.textContent, /其余片区已更新/);
  h.data.freshness.run.auto_refresh.failed[0].stop_reason = 'capture:NeedsLoginError';
  await h.page.loadFreshness(); assert.match(h.root.textContent, /DMS 登录已过期/); assert.doesNotMatch(h.root.textContent, /自动更新.*失败|最近一次更新失败/);
  h.data.freshness.run.running = true;
  await h.page.loadFreshness(); assert.match(h.root.textContent, /公用电脑正在更新数据/);
  h.data.freshness.run = { running: false, last: { status: 'completed' }, auto_refresh: { day: '2026-11-11', failed: [], completed_count: 1, district_count: 1 } };
  await h.page.loadFreshness(); assert.doesNotMatch(h.root.textContent, /自动更新|最近一次更新失败|DMS 登录已过期|正在更新数据/);
  h.data.runs = [{ status: 'completed', trigger: 'schedule', scope: { type: 'district', district: 'mock' } }];
  await h.click('更新记录'); assert.match(h.root.textContent, /来源：每日自动/);
  h.page.dispose();
});
function fresh(source = 'db') {
  return { source, notice: '数据来自 DMS 抓取，非实时', global: { newest_fetched_at: iso },
    districts: [{ id: 'mock', newest_fetched_at: iso, oldest_fetched_at: iso, stations_with_data: 1, station_count: 4 }],
    stations: [{ code: 'MOCK1', district: 'mock', fetched_at: iso },
      ...['not_in_dms_menu', 'no_permission', 'disabled'].map((reason, i) => ({ code: `SKIP${i}`, district: 'mock', fetched_at: null, scrape_disabled: reason }))],
    run: source === 'json' ? null : { running: true, last: null } };
}
function fixture({ capability = false, autoCapability = false, failCapability = false, source = 'db', initialState = 'idle', mapPage = false, profilePage = false, defaultReload = false } = {}) {
  const root = new Element('section'), calls = [], timers = new Map(); let timerId = 0, reloads = 0;
  const data = { freshness: fresh(source), state: { state: initialState, progress: initialState === 'running' ? progress() : null },
    districts: [{ id: 'mock', name_zh: '合成片区' }, { id: 'unassigned', name_zh: '未分配站点' }],
    runs: [], plan: { scope: { type: 'district', district: 'mock' }, stations: [{ code: 'MOCK1', district: 'mock' }], skipped: [{ code: 'SKIP0', district: 'mock', reason: 'not_in_dms_menu' }] },
    postStatus: 202 };
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/capabilities' && failCapability || url === '/api/freshness' && data.failFresh || url === '/api/refresh/status' && data.failStatus) throw Error('private secret');
    const body = url === '/api/freshness' ? data.freshness : url === '/api/districts' ? { districts: data.districts }
      : url === '/api/capabilities' ? { refresh: capability, auto_refresh: autoCapability, warehouse_write: false }
        : url === '/api/auto-refresh/status' ? data.auto : url.startsWith('/api/runs') ? { runs: data.runs, source }
        : url.startsWith('/api/refresh/preview') ? data.plan : data.state;
    const status = url === '/api/refresh' ? data.postStatus : 200;
    return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) };
  };
  const actions = new Element('div'), summary = new Element('div');
  const doc = { getElementById: id => id === 'data-status' ? root : id === 'profile-data-summary' && profilePage ? summary : id === 'map-data-actions' && (mapPage || profilePage) ? actions : nodes(root).find(n => n.id === id),
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  const page = createDataStatus({ document: doc, fetch: request,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id), reload: defaultReload ? undefined : () => reloads++ });
  const click = async text => { const el = find(root, text); assert.ok(el, `button ${text}`); await el.listeners.click(); return el; };
  const tick = async delay => { const entry = [...timers].find(([, t]) => t.delay === delay); assert.ok(entry); timers.delete(entry[0]); await entry[1].fn(); };
  return { root, actions, summary, page, data, calls, timers, click, tick, reloads: () => reloads };
}

test('RM13b Station times live in history while refresh warnings remain outside details', async () => {
  const h = fixture({ mapPage: true }); await h.page.start();
  const details = nodes(h.root).find(n => n.tag === 'details');
  const dialog = nodes(h.root).find(n => n.tag === 'dialog');
  assert.ok(nodes(dialog).includes(details));
  assert.ok(!h.root.children.filter(n => n.tag !== 'dialog').flatMap(nodes).includes(details));
  assert.match(dialog.textContent, /DMS 快照，非实时数据/);
  for (const value of ['MOCK1', 'SKIP0', 'SKIP1', 'SKIP2', 'DMS 中无此站点', '无权限', '已停用', formatUpdated(iso)]) assert.ok(details.textContent.includes(value), value);
  assert.ok(!details.open);
  assert.match(details.textContent, /数据来自 DMS|MOCK1/);
  const times = nodes(details).find(n => n.id === 'map-station-times');
  times.textContent = 'MOCK1 snapshot';
  h.data.freshness.run = { running: false, last: { status: 'stopped', finished_at: iso, needs_login: true } };
  await h.page.loadFreshness();
  assert.ok(nodes(h.root).some(n => n.tag === 'p' && /最近一次更新失败/.test(n.textContent) && !nodes(details).includes(n)));
  assert.ok(h.root.children.some(n => n.tag === 'p' && /npm run dms:login/.test(n.textContent)));
  assert.ok(nodes(h.root).some(n => n.id === 'map-station-times' && n.textContent === 'MOCK1 snapshot'));
  const history = find(h.actions, '更新记录'); assert.ok(history);
  await history.listeners.click(); assert.equal(nodes(h.root).find(n => n.tag === 'dialog').open, true);
  h.page.dispose();
});
function progress() {
  return { run_id: 'mock-run', started_at: iso, phase: 'capture', district: 'mock', station: 'MOCK1',
    station_index: 1, station_total: 4, route_index: 2, route_total: null, completed: ['DONE'], skipped: ['SKIP0'], failed: ['FAIL'],
    scope: { skipped: [{ code: 'SKIP0', reason: 'not_in_dms_menu' }] } };
}

test('CD-T7 freshness renders timestamps, details, run messages and retains data after errors', async () => {
  const h = fixture(); await h.page.start();
  for (const value of ['非实时', 'Last Updated', '合成片区', '有数据 / 总数：1 / 4', 'MOCK1', '暂无数据', 'DMS 中无此站点', '无权限', '已停用', '公用电脑正在更新数据']) assert.ok(h.root.textContent.includes(value), value);
  assert.ok(nodes(h.root).some(n => n.tag === 'time' && n.title === iso && n.textContent === formatUpdated(iso)));
  h.data.failFresh = true; await h.tick(60000);
  assert.match(h.root.textContent, /状态获取失败/); assert.match(h.root.textContent, /MOCK1/);
  h.data.failFresh = false;
  for (const status of ['stopped', 'abandoned']) {
    h.data.freshness.run = { running: false, last: { status, finished_at: iso, needs_login: true } };
    await h.page.loadFreshness(); assert.match(h.root.textContent, /最近一次更新失败/); assert.match(h.root.textContent, /npm run dms:login/);
  }
  h.data.freshness = fresh('json'); await h.page.loadFreshness();
  assert.doesNotMatch(h.root.textContent, /最近一次更新失败|公用电脑正在更新|dms:login/);
  h.page.dispose(); assert.equal(h.timers.size, 0);
});

test('CD-T7 capability false or failure never creates a refresh button; initial freshness failure keeps notice', async () => {
  for (const failCapability of [false, true]) {
    const h = fixture({ failCapability }); h.data.failFresh = true; await h.page.start();
    assert.equal(find(h.root, '刷新数据'), undefined);
    assert.match(h.root.textContent, /数据来自 DMS 抓取，非实时/);
    assert.ok(!h.calls.some(c => c.url.startsWith('/api/refresh'))); h.page.dispose();
  }
});

test('CD-T7 history maps all statuses, sources, scope, counts and JSON empty state with focus return', async () => {
  const h = fixture(); await h.page.start();
  h.data.runs = ['completed', 'stopped', 'running', 'abandoned'].map((status, i) => ({ status, trigger: ['ui', 'cli', 'json_import', 'ui'][i],
    started_at: iso, finished_at: iso, scope: i ? { type: 'district', district: i === 3 ? 'unknown' : 'mock' } : { type: 'all' },
    counts: { completed: 3, skipped: 2, stopped: 1 }, prod_api_requests: 42, stop_reason: 'capture:NeedsLoginError' }));
  const opener = await h.click('更新记录');
  const dialog = nodes(h.root).find(n => n.tag === 'dialog'); assert.equal(dialog.open, true);
  for (const value of ['完成', '已停止', '进行中', '已放弃', '刷新按钮', '命令行', 'JSON 导入', '全部', '合成片区', 'unknown', '3 / 2 / 1', '42', 'capture:NeedsLoginError']) assert.ok(dialog.textContent.includes(value), value);
  dialog.close(); assert.equal(opener.focused, true);
  const j = fixture({ source: 'json' }); await j.page.start(); await j.click('更新记录'); assert.match(j.root.textContent, /暂无记录（当前为 JSON 后备模式）/);
  h.page.dispose(); j.page.dispose();
});

test('CD-T7 refresh scope, confirmation and POST contract; progress polling completes and offers reload', async () => {
  const h = fixture({ capability: true }); await h.page.start(); await h.click('刷新数据');
  const select = nodes(h.root).find(n => n.tag === 'select');
  assert.deepEqual(select.children.map(n => n.value), ['all', 'district:mock']); select.value = 'district:mock';
  await h.click('下一步'); assert.ok(h.calls.some(c => c.url === '/api/refresh/preview?scope=district%3Amock'));
  assert.match(h.root.textContent, /要处理的 Station（1）：MOCK1/); assert.match(h.root.textContent, /SKIP0：DMS 中无此站点/);
  assert.match(h.root.textContent, /正式刷新统一走 dms:scrape-stations/);
  h.data.state = { state: 'running', progress: progress() }; await h.click('确认开始');
  assert.deepEqual(h.calls.find(c => c.url === '/api/refresh').options, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NC-Refresh': '1' }, body: '{"scope":"district:mock"}' });
  assert.equal(find(h.root, '刷新数据').disabled, true);
  for (const value of ['更新中', 'Station 1 / 4', 'Route 2 / —', 'capture', 'DONE', 'SKIP0（DMS 中无此站点）', 'FAIL']) assert.ok(h.root.textContent.includes(value), value);
  const dialog = nodes(h.root).filter(n => n.tag === 'dialog')[1]; dialog.close();
  assert.equal(find(h.root, '查看更新进度').focused, true);
  await h.tick(2000); assert.equal(dialog.open, false);
  await h.click('查看更新进度'); assert.equal(dialog.open, true); dialog.close();
  h.data.state = { state: 'completed', progress: { ...progress(), finished_at: iso } }; await h.tick(2000);
  assert.ok(![...h.timers.values()].some(t => t.delay === 2000)); assert.equal(find(h.root, '刷新数据').disabled, false);
  await h.click('数据已更新，点击重新加载'); assert.equal(h.reloads(), 1); h.page.dispose();
});

test('CD-T7 page reload resumes running status and login expiry appears in progress and bar', async () => {
  const h = fixture({ capability: true, initialState: 'running' }); await h.page.start();
  assert.ok(nodes(h.root).filter(n => n.tag === 'dialog')[1].open);
  assert.ok([...h.timers.values()].some(t => t.delay === 2000));
  h.data.failStatus = true; await h.tick(2000); assert.match(h.root.textContent, /更新进度获取失败/);
  h.data.failStatus = false; h.data.state = { state: 'stopped', needs_login: true, progress: { ...progress(), finished_at: iso, stop_reason: 'capture:NeedsLoginError' } };
  await h.tick(2000); assert.equal(h.root.textContent.split('DMS 登录已过期').length - 1, 2);
  assert.ok(![...h.timers.values()].some(t => t.delay === 2000)); h.page.dispose();
});

test('CD-T7 conflict enters progress; 403/400 show fixed errors without response content or retries', async () => {
  for (const status of [409, 403, 400]) {
    const h = fixture({ capability: true }); await h.page.start(); await h.click('刷新数据'); await h.click('下一步');
    h.data.postStatus = status; h.data.state = { state: 'running', progress: progress() }; await h.click('确认开始');
    if (status === 409) {
      assert.match(h.root.textContent, /已有刷新进行中/);
      assert.ok(h.calls.filter(c => c.url === '/api/refresh/status').length >= 2);
      assert.match(h.root.textContent, /更新中/);
    } else {
      assert.match(h.root.textContent, status === 403 ? /请求未获授权/ : /请求无效/);
      assert.equal(h.calls.filter(c => c.url === '/api/refresh/status').length, 1);
    }
    assert.equal(h.calls.filter(c => c.url === '/api/refresh').length, 1); assert.doesNotMatch(h.root.textContent, /private secret/); h.page.dispose();
  }
});

test('CD-T7 both pages load shared self-hosted module through the common static whitelist', async () => {
  for (const name of ['index.html', 'map.html']) {
    const html = await readFile(new URL(`../../web/${name}`, import.meta.url), 'utf8');
    assert.match(html, /id="data-status"/); assert.match(html, /src="\/data-status.js"/);
  }
  const js = await readFile(new URL('../../web/data-status.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js.replaceAll('http://www.w3.org/2000/svg', ''), /innerHTML|https?:\/\//);
  assert.ok(isStaticPath('/data-status.js'));
  const asset = await createStaticReader(fileURLToPath(new URL('../../web/', import.meta.url)))('/data-status.js');
  assert.match(asset.contentType, /text\/javascript/); assert.equal(asset.body.toString(), js);
});

test('RM13b both headers share one brand definition and map timestamp explains the snapshot', async () => {
  for (const name of ['map', 'index']) {
    const html = await readFile(new URL(`../../web/${name}.html`, import.meta.url), 'utf8');
    assert.match(html, /class="console-brand"/);
    assert.doesNotMatch(html, /NC OPS CONSOLE/);
    if (name === 'map') assert.match(html, /class="snapshot" title="DMS 快照，非实时数据"/);
  }
  const h = fixture(), host = new Element('p');
  // Reuse the public constructor to exercise actual shared brand rendering.
  const page = createDataStatus({ document: { getElementById: () => h.root, querySelectorAll: () => [host],
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) } });
  assert.equal(host.textContent, 'West Region Ops Dashboard');
  assert.equal(host.children[0].attributes['aria-hidden'], 'true');
  assert.equal(host.children[1].children[0].className, 'console-brand-region');
  page.dispose(); h.page.dispose();
});

test('RM13c profile freshness summary is in the card and details remain in history', async () => {
  const h = fixture({ profilePage: true }); await h.page.start();
  assert.match(h.summary.textContent, /Last Updated/);
  assert.ok(h.summary.textContent.includes(formatUpdated(iso)));
  const history = nodes(h.root).find(n => n.tag === 'dialog');
  assert.ok(nodes(history).some(n => n.tag === 'details'));
  assert.ok(!h.root.children.filter(n => n.tag !== 'dialog').flatMap(nodes).some(n => n.tag === 'details'));
  h.data.freshness.global.newest_fetched_at = '2026-10-09T12:00:00Z';
  await h.page.loadFreshness();
  assert.ok(h.summary.textContent.includes(formatUpdated('2026-10-09T12:00:00Z')));
  assert.equal(h.summary.children.filter(n => n.tag === 'time').length, 1);
  assert.ok(h.actions.children[0].children.some(n => n.tag === 'button'));
  h.page.dispose();
});

for (const source of ['freshness', 'progress', 'last_run']) test('language notice from ' + source, async () => {
  const h = fixture({ capability: source !== 'freshness' });
  if (source === 'freshness') h.data.freshness.run = { running: false, last: { status: 'stopped', stop_reason: 'open:DmsLanguageError', needs_login: false } };
  else h.data.state = { state: 'stopped', needs_login: false, [source]: { stop_reason: 'capture:DmsLanguageError' } };
  await h.page.start();
  assert.match(h.root.textContent, /DMS 界面是英文/);
  assert.match(h.root.textContent, /程序自动切换中文失败。请在公用电脑打开 DMS，把右上角语言手动切换为中文/);
  assert.doesNotMatch(h.root.textContent, /DMS 登录已过期/);
  if (source !== 'freshness') {
    const dialog = nodes(h.root).find(n => n.tag === 'dialog' && /刷新数据/.test(n.textContent));
    assert.match(dialog.textContent, /DMS 界面是英文/);
    h.data.state = { state: 'completed', needs_login: false, progress: { stop_reason: null } };
    await h.page.loadStatus();
  } else {
    h.data.freshness.run.last.stop_reason = 'capture:SelectorError';
    await h.page.loadFreshness();
  }
  assert.doesNotMatch(h.root.textContent, /DMS 界面是英文/);
  h.page.dispose();
});

test('SC4 progress renders runtime missing station reason without static configuration', async () => {
  const h = fixture({ capability: true });
  h.data.state = { state: 'running', progress: { ...progress(), skipped: [{ code: 'LAX03', district: 'mock', reason: 'not_in_dms_menu' }] } };
  await h.page.start(); assert.match(h.root.textContent, /LAX03（DMS 中无此站点）/); h.page.dispose();
});
