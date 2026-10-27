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
function fresh(source = 'db') {
  return { source, notice: '数据来自 DMS 抓取，非实时', global: { newest_fetched_at: iso },
    districts: [{ id: 'mock', newest_fetched_at: iso, oldest_fetched_at: iso, stations_with_data: 1, station_count: 4 }],
    stations: [{ code: 'MOCK1', district: 'mock', fetched_at: iso },
      ...['not_in_dms_menu', 'no_permission', 'disabled'].map((reason, i) => ({ code: `SKIP${i}`, district: 'mock', fetched_at: null, scrape_disabled: reason }))],
    run: source === 'json' ? null : { running: true, last: null } };
}
function fixture({ capability = false, failCapability = false, source = 'db', initialState = 'idle' } = {}) {
  const root = new Element('section'), calls = [], timers = new Map(); let timerId = 0, reloads = 0;
  const data = { freshness: fresh(source), state: { state: initialState, progress: initialState === 'running' ? progress() : null },
    districts: [{ id: 'mock', name_zh: '合成片区' }, { id: 'unassigned', name_zh: '未分配站点' }],
    runs: [], plan: { scope: { type: 'district', district: 'mock' }, stations: [{ code: 'MOCK1', district: 'mock' }], skipped: [{ code: 'SKIP0', district: 'mock', reason: 'not_in_dms_menu' }] },
    postStatus: 202 };
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/capabilities' && failCapability || url === '/api/freshness' && data.failFresh || url === '/api/refresh/status' && data.failStatus) throw Error('private secret');
    const body = url === '/api/freshness' ? data.freshness : url === '/api/districts' ? { districts: data.districts }
      : url === '/api/capabilities' ? { refresh: capability, warehouse_write: false } : url.startsWith('/api/runs') ? { runs: data.runs, source }
        : url.startsWith('/api/refresh/preview') ? data.plan : data.state;
    const status = url === '/api/refresh' ? data.postStatus : 200;
    return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) };
  };
  const page = createDataStatus({ document: { getElementById: () => root, createElement: tag => new Element(tag) }, fetch: request,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id), reload: () => reloads++ });
  const click = async text => { const el = find(root, text); assert.ok(el, `button ${text}`); await el.listeners.click(); return el; };
  const tick = async delay => { const entry = [...timers].find(([, t]) => t.delay === delay); assert.ok(entry); timers.delete(entry[0]); await entry[1].fn(); };
  return { root, page, data, calls, timers, click, tick, reloads: () => reloads };
}
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
  assert.doesNotMatch(js, /innerHTML|https?:\/\//);
  assert.ok(isStaticPath('/data-status.js'));
  const asset = await createStaticReader(fileURLToPath(new URL('../../web/', import.meta.url)))('/data-status.js');
  assert.match(asset.contentType, /text\/javascript/); assert.equal(asset.body.toString(), js);
});
