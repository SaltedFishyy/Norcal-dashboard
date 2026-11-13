import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Synthetic DOM/API doubles; never read operational snapshots or contact DMS.
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.style = {}; this.value = ''; this.className = ''; this.ownText = ''; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(node => node.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes.flatMap(node => node.fragment ? node.children : [node])); }
  replaceChildren(...nodes) { this.ownText = ''; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  querySelector(tag) { return descendants(this).find(node => node.tag === tag); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrolled = options; }
  getBoundingClientRect() { return this.rect || { top: 0, bottom: 60 }; }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = (data, status = 200) => ({ status, json: async () => data });

test('PL list renders shared colors, prices, volume ratios and retains or falls back selection', async t => {
  const f = await fixture(t);
  const { routeColor } = await import('../../web/route-colors.js');
  f.state.rows = [
    { route_id: 2, route_name: 'Alpha', dsp_name: 'A', postal_codes: ['00123'], pickup_volume: 20, pph: 12.5, route_difficulty: 'B级 中', quoted_zip_count: 1, current_first_0_1lb_price_min: 1.75, current_first_0_1lb_price_max: 1.75 },
    { route_id: 3, route_name: 'Beta', dsp_name: 'B', postal_codes: ['00987'], pickup_volume: 10, route_difficulty: 'S级 极难' },
  ];
  await f.e['profile-station'].listeners.change();
  const list = () => f.e['profile-routes'].children;
  const selected = () => list().filter(row => row.attributes['aria-pressed'] === 'true').map(row => row.attributes['data-route-id']);
  assert.deepEqual(selected(), ['2']);
  assert.equal(list()[0].tag, 'button');
  assert.equal(list()[0].children[0].style.backgroundColor, routeColor(2));
  assert.equal(list()[0].children[1].textContent, 'AlphaA · 1 ZIP · $1.75');
  assert.equal(list()[0].children[2].textContent, '12.50PPH20件');
  assert.equal(list()[0].children[3].textContent, 'B');
  assert.equal(list()[0].children[4].style.width, '100%');
  assert.equal(list()[1].children[4].style.width, '50%');
  await list()[1].listeners.click(); assert.deepEqual(selected(), ['3']);
  f.e['sort-pickup_volume'].listeners.click(); assert.deepEqual(selected(), ['3']);
  assert.deepEqual(list()[1].scrolled, { block: 'nearest' });
  f.e['sort-route_difficulty'].listeners.click(); assert.equal(list()[0].attributes['data-route-id'], '3');
  assert.equal(f.e['sort-route_difficulty'].attributes['aria-pressed'], 'true');
  f.e['sort-name'].listeners.click(); assert.deepEqual(list().map(row => row.attributes['data-route-id']), ['2', '3']);
  const filter = value => { f.e['profile-zip'].value = value; f.e['profile-zip'].listeners.input(); };
  filter('be'); assert.deepEqual(selected(), ['3']); assert.equal(list()[0].children[4].style.width, '100%');
  filter('001'); assert.deepEqual(selected(), ['2']);
  filter('missing'); assert.equal(list().length, 1); assert.equal(list()[0].textContent, '没有匹配的线路');
  filter('Beta'); await f.submit();
  assert.equal(f.e['profile-zip'].value, ''); assert.equal(list().length, 2); assert.deepEqual(selected(), ['2']);
  assert.ok(descendants(f.e['detail-content']).some(node => node.className === 'zip-target'));
  f.e['profile-dsp'].value = 'B'; f.e['profile-dsp'].listeners.change(); assert.deepEqual(selected(), ['3']);
  await f.e['profile-station'].listeners.change(); assert.deepEqual(selected(), ['3']);
});

test('PL ZIP pending, uncovered and failed queries preserve selection and detail', async t => {
  const f = await fixture(t);
  const content = f.e['detail-content'].textContent, title = f.e[ 'detail-title', 'detail-swatch', 'detail-difficulty', 'detail-summary'].textContent;
  const row = f.e['profile-routes'].children[0];
  const unchanged = () => {
    assert.equal(row.attributes['aria-pressed'], 'true');
    assert.equal(f.e['detail-content'].textContent, content);
    assert.equal(f.e[ 'detail-title', 'detail-swatch', 'detail-difficulty', 'detail-summary'].textContent, title);
  };
  let release;
  f.state.zip = () => new Promise(resolve => { release = resolve; });
  const pending = f.submit(); unchanged();
  release(reply({ status: 'uncovered' })); await pending; unchanged();
  for (const status of ['no_boundary', 'out_of_range', 'multi_station']) {
    f.state.zip = { status, owners: [] }; await f.submit(); unchanged();
  }
  f.state.zip = Error('synthetic failure'); await f.submit(); unchanged();
  assert.equal(f.result(), 'ZIP 查询失败，请稍后重试');
});

test('PL empty local or DSP filters preserve detail and distinguish an empty station', async t => {
  const f = await fixture(t);
  const content = f.e['detail-content'].textContent;
  const filter = value => { f.e['profile-zip'].value = value; f.e['profile-zip'].listeners.input(); };
  for (const value of ['abc', '99999']) {
    filter(value);
    assert.equal(f.e['profile-routes'].textContent, '没有匹配的线路');
    assert.equal(f.e['detail-content'].textContent, content);
    assert.doesNotMatch(f.e['profile-routes'].textContent + f.e['detail-content'].textContent + f.e.message.textContent, /dms:scrape/);
  }
  filter('');
  assert.equal(f.e['profile-routes'].children[0].attributes['aria-pressed'], 'true');
  f.state.rows = [{ route_id: 2, dsp_name: 'A' }, { route_id: 3, dsp_name: 'B' }];
  await f.e['profile-station'].listeners.change();
  f.e['profile-dsp'].value = 'B'; f.e['profile-dsp'].listeners.change(); await tick();
  const dspDetail = f.e['detail-content'].textContent;
  filter('abc');
  assert.equal(f.e['profile-routes'].textContent, '没有匹配的线路');
  assert.equal(f.e['detail-content'].textContent, dspDetail);
  assert.doesNotMatch(f.e['profile-routes'].textContent + dspDetail, /dms:scrape/);
  f.state.rows = []; await f.e.retry.listeners.click();
  assert.match(f.e['detail-content'].textContent, /所选站点 暂无数据.*dms:scrape/);
});

test('PL page has persistent containers and scoped viewport/list CSS', async () => {
  const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  for (const name of ['profile-topbar', 'profile-layout', 'profile-sidebar', 'profile-sort', 'profile-detail-pane', 'profile-banners']) assert.ok(html.includes(`class="${name}"`));
  assert.match(html, /<section id="route-detail"/);
  assert.doesNotMatch(html, /<dialog|<table|id="rows"|id="table-container"|id="detail-close"/);
  const css = await readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\/\* PL \*\//);
  assert.match(css, /\.profile-page \{[^}]*height: 100vh; height: 100dvh; overflow: hidden/);
  assert.match(css, /\.profile-page \.profile-sidebar \{[^}]*flex: 0 0 390px/);
  assert.match(css, /\.profile-page #profile-routes \{[^}]*flex: 1; min-height: 0; overflow-y: auto/);
  assert.match(css, /\.profile-page \.profile-detail-pane \{[^}]*min-width: 0;[^}]*overflow-y: auto/);
});
test('PL narrow scrolling follows row clicks only and respects reduced motion', async t => {
  let narrow = true, reduced = false;
  const f = await fixture(t, '', undefined, query => ({ matches: query.includes('max-width') ? narrow : reduced }));
  assert.equal(f.e.pane.scrolled, undefined, 'initial selection must not scroll the page');
  const click = () => f.e['profile-routes'].children[0].listeners.click();
  await click(); assert.deepEqual(f.e.pane.scrolled, { block: 'start', behavior: 'smooth' });
  reduced = true;
  await click(); assert.deepEqual(f.e.pane.scrolled, { block: 'start', behavior: 'instant' });
  delete f.e.pane.scrolled;
  f.e['sort-pickup_volume'].listeners.click();
  f.e['profile-zip'].value = 'Mock'; f.e['profile-zip'].listeners.input();
  await f.submit();
  assert.equal(f.e.pane.scrolled, undefined, 'sort, filter and ZIP selection must not scroll the page');
  const list = f.e['profile-routes'], row = list.children[0];
  list.scrollTop = 0; list.rect = { top: 100, bottom: 200 }; row.rect = { top: 210, bottom: 270 };
  await click(); assert.equal(list.scrollTop, 70, 'selected row remains visible inside the list');
  delete f.e.pane.scrolled; narrow = false;
  await click(); assert.equal(f.e.pane.scrolled, undefined);
  assert.deepEqual(row.scrolled, { block: 'nearest' });
});

test('PL narrow CSS and banners retain contained scrolling after legacy cleanup', async () => {
  const css = await readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  const narrow = css.slice(css.lastIndexOf('@media (max-width: 750px)'));
  assert.match(narrow, /\.profile-page \{[^}]*height: auto;[^}]*overflow: visible/);
  assert.match(narrow, /#profile-routes \{[^}]*max-height: 60vh; max-height: 60dvh/);
  assert.match(narrow, /\.pl-metrics \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(narrow, /\.pl-trend-charts \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(narrow, /\.profile-detail-pane \{[^}]*min-height: 100vh; min-height: 100dvh/, 'short/loading detail can still align with the viewport top');
  assert.match(css, /#profile-date-notice \{[^}]*font-size: var\(--fs-14\); border: 0/);
  assert.match(css, /#profile-date-latest \{[^}]*font-size: inherit; padding: 2px 6px/);
  assert.doesNotMatch(css, /#profiles (?:thead|th|\.sort-)|\.route-link\s*\{|\.zip-target-row > td/);
  assert.match(css, /\.detail-table-scroll \{ overflow: auto/);
  assert.match(css, /\.detail-metrics \{/, 'price dialog still uses this shared rule');
});

test('DV profile date drives profiles, ZIP, detail, empty state and DSP rebuilding', async t => {
  const f = await fixture(t, '?station=MOCKA&date=2026-11-08');
  assert.ok(f.calls.includes('/api/route-profiles?station=MOCKA&date=2026-11-08'));
  assert.match(f.e['profile-date-text'].textContent, /正在查看 11\/08 的数据/);
  assert.equal(f.e['profile-date-notice'].hidden, false);
  f.state.rows = [{ route_id: 2, dsp_name: 'Old' }]; await f.e.retry.listeners.click();
  f.e['profile-dsp'].value = 'Old'; f.e['profile-dsp'].listeners.change();
  f.state.rows = [{ route_id: 2, dsp_name: 'New' }]; await f.e.retry.listeners.click();
  assert.equal(f.e['profile-dsp'].value, '');
  f.state.detailStatus = 404; await f.submit();
  assert.ok(f.calls.includes('/api/route-map/zip?postal_code=00123&date=2026-11-08'));
  assert.ok(f.calls.includes('/api/route-details?route_id=2&date=2026-11-08'));
  assert.match(f.e['detail-summary'].textContent, /11\/08 的数据/);
  assert.match(f.e['detail-content'].textContent, /该日没有这条线路的详情/);
  assert.doesNotMatch(f.e['detail-content'].textContent, /抓取/);
  f.state.profile = () => reply({ rows: [], total: 0, fetched_at: null, empty: true });
  await f.e.retry.listeners.click(); assert.equal(f.e.message.textContent, '该日无数据'); assert.equal(f.e.total.textContent, '0 \u6761');
  await f.e['profile-date-latest'].listeners.click();
  assert.equal(new URL(globalThis.location.href).searchParams.has('date'), false);
  assert.equal(f.calls.at(-1), '/api/route-profiles?station=MOCKB');
});
test('DV unavailable history hides selector and restores latest while retaining other URL parameters', async t => {
  const f = await fixture(t, '?station=MOCKA&date=2026-11-08', { available: false });
  assert.equal(f.e['profile-date-field'].hidden, true);
  assert.ok(f.calls.includes('/api/route-profiles?station=MOCKA'));
  assert.equal(new URL(globalThis.location.href).searchParams.get('station'), 'MOCKA');
});
test('DV station change retains a selected day absent from its options', async t => {
  const f = await fixture(t, '?date=2026-11-06', { days: [] });
  f.e['profile-station'].value = 'MOCKB'; await f.e['profile-station'].listeners.change();
  assert.equal(f.e['profile-date'].value, '2026-11-06');
  assert.ok(f.calls.includes('/api/snapshot-days?station=MOCKB'));
  assert.ok(f.calls.includes('/api/route-profiles?station=MOCKB&date=2026-11-06'));
  assert.equal(f.calls.at(-1), '/api/route-details?route_id=2&date=2026-11-06');
  assert.match(f.e['profile-date'].children.at(-1).textContent, /（空）/);
});
let counter = 0;
async function fixture(t, search = '', days = { days: [{ day: '2026-11-08', has_data: true }] }, media) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, localStorage: globalThis.localStorage, location: globalThis.location, history: globalThis.history, matchMedia: globalThis.matchMedia };
  if (media) globalThis.matchMedia = media;
  globalThis.location = { search, href: 'http://localhost/' + search };
  globalThis.history = { replaceState: (_, __, href) => { globalThis.location.href = href; globalThis.location.search = new URL(href).search; } };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const ids = ['updated', 'total', 'profile-routes', 'message', 'retry', 'profiles', 'profile-station', 'profile-district', 'profile-dsp', 'profile-zip-form', 'profile-zip', 'profile-zip-result', 'route-detail', 'detail-content', 'detail-close', 'detail-title', 'detail-swatch', 'detail-difficulty', 'detail-summary'];
  ids.push('profile-date', 'profile-date-field', 'profile-date-notice', 'profile-date-text', 'profile-date-latest');
  const e = Object.fromEntries(ids.map(id => [id, new Element()]));
  for (const key of ['name', 'pickup_volume', 'pph', 'price', 'route_difficulty']) {
    const th = new Element('th'), control = new Element('button');
    control.append(new Element('span')); control.parentNode = th; th.append(control); e['sort-' + key] = control;
  }
  const button = new Element('button'); e['profile-zip-form'].append(button);
  e.pane = new Element();
  globalThis.document = { getElementById: id => e[id], querySelector: selector => selector === '.profile-detail-pane' ? e.pane : null, createElement: tag => new Element(tag), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }) };
  const saved = [], calls = [];
  globalThis.localStorage = { getItem: () => null, setItem: (key, value) => saved.push({ key, value: JSON.parse(value) }) };
  const districts = ['first', 'second', 'unassigned'].map((id, i) => ({ id, name_zh: id, stations: [{ code: ['MOCKA', 'MOCKB', 'MOCKC'][i], has_snapshot: true }] }));
  const state = { zip: { status: 'covered', station: 'MOCKB', route_id: 2, route_name: 'Mock B', route: { dsp_name: 'Mock DSP' }, dsp_name: 'Fallback' },
    rows: [{ route_id: 2, route_name: 'Mock B', station: 'MOCKB' }], zips: [{ postal_code: '00123' }], detailStatus: 200 };
  globalThis.fetch = async url => {
    calls.push(url);
    if (url.startsWith('/api/route-history')) return reply({ available: false });
    if (url === '/api/districts') return reply({ districts });
    if (url.startsWith('/api/snapshot-days')) return reply(days);
    if (url.startsWith('/api/route-profiles')) return state.profile ? state.profile(url) : reply({ total: state.rows.length, rows: state.rows, fetched_at: '2026-10-08T12:00:00Z' });
    if (url.startsWith('/api/route-details')) return state.detail ? state.detail() : reply(state.detailStatus === 404 ? { error: 'route_detail_not_found' } : { zips: state.zips }, state.detailStatus);
    if (state.zip instanceof Error) throw state.zip;
    return typeof state.zip === 'function' ? state.zip(url) : reply(state.zip, state.zipStatus || 200);
  };
  await import(`../../web/app.js?pz1=${++counter}`); await tick();
  const submit = async (value = '00123') => { e['profile-zip'].value = value; return e['profile-zip-form'].listeners.submit({ preventDefault() {} }); };
  return { e, state, calls, saved, button, submit, result: () => e['profile-zip-result'].textContent };
}

test('PD1 options, filtering before sorting, totals, source preservation and selection retention', async t => {
  const f = await fixture(t), select = f.e['profile-dsp'];
  const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<label for="profile-dsp">DSP<\/label>/);
  assert.match(html, /<select id="profile-dsp" disabled>/);
  f.state.rows = Object.freeze([
    Object.freeze({ route_id: 1, dsp_name: ' Z ', pickup_volume: 0 }),
    Object.freeze({ route_id: 2, dsp_name: 'A', pickup_volume: 4 }),
    Object.freeze({ route_id: 3, dsp_name: 'Z', pickup_volume: 8 }),
    Object.freeze({ route_id: 4, dsp_name: ' ' }),
    Object.freeze({ route_id: 5 }),
  ]);
  const before = structuredClone(f.state.rows);
  await f.e['profile-station'].listeners.change();
  assert.deepEqual(select.children.map(option => option.value), ['', 'A', 'Z']);
  assert.equal(select.children[0].textContent, '全部 DSP'); assert.equal(select.disabled, false);
  assert.equal(f.e.total.textContent, '5 \u6761');
  select.value = 'Z'; select.listeners.change();
  const order = () => f.e['profile-routes'].children.map(row => row.attributes['data-route-id']);
  assert.deepEqual(order(), ['1', '3']); assert.equal(f.e.total.textContent, '2 / 5 \u6761');
  f.e['sort-pickup_volume'].listeners.click(); assert.deepEqual(order(), ['3', '1']);
  f.e['sort-pickup_volume'].listeners.click(); assert.deepEqual(order(), ['1', '3']);
  select.value = ''; select.listeners.change(); assert.deepEqual(order(), ['1', '2', '3', '4', '5']);
  assert.deepEqual(f.state.rows, before);
  select.value = 'Z'; select.listeners.change();
  f.e['profile-district'].value = 'second'; await f.e['profile-district'].listeners.change();
  assert.equal(select.value, 'Z');
  f.state.rows = [{ route_id: 6, dsp_name: 'B' }];
  await f.e['profile-station'].listeners.change();
  assert.equal(select.value, ''); assert.deepEqual(select.children.map(option => option.value), ['', 'B']);
  f.state.rows = []; await f.e.retry.listeners.click();
  assert.deepEqual(select.children.map(option => option.value), ['']); assert.equal(select.disabled, false);
  assert.equal(f.e.total.textContent, '0 \u6761');
  let release; f.state.profile = () => new Promise(resolve => { release = resolve; });
  const pending = f.e.retry.listeners.click(); assert.equal(select.disabled, true);
  release(reply({ error: 'internal_error' }, 500)); await pending; assert.equal(select.disabled, true);
  assert.ok(f.saved.every(write => !Object.hasOwn(write.value, 'dsp')));
});

test('PD1 DSP change clears ZIP feedback and highlight while keeping a persistent panel and invalidates pending queries', async t => {
  const f = await fixture(t);
  f.state.rows = [{ route_id: 2, dsp_name: 'A' }, { route_id: 3, dsp_name: 'B' }];
  await f.e['profile-station'].listeners.change();
  await f.submit(); assert.equal(f.e['route-detail'].open, undefined);
  const oldRow = f.e['profile-routes'].children[0];
  f.e['profile-dsp'].value = 'A'; f.e['profile-dsp'].listeners.change();
  assert.equal(f.result(), ''); assert.equal(oldRow.className, 'profile-route');
  assert.equal(f.e['profile-routes'].children[0].className, 'profile-route'); assert.equal(f.e['route-detail'].open, undefined);
  assert.equal(f.e['profile-zip'].value, '');
  let release; f.state.zip = () => new Promise(resolve => { release = resolve; });
  const pending = f.submit();
  f.e['profile-dsp'].value = 'B'; f.e['profile-dsp'].listeners.change();
  release(reply({ status: 'covered', station: 'MOCKB', route_id: 2 })); await pending;
  assert.equal(f.result(), ''); assert.equal(f.e['profile-dsp'].value, 'B');
  assert.equal(f.e['route-detail'].open, undefined);
});

test('PD1 excluded ZIP offers explicit reveal; stale buttons cannot change filters; multi-station uses same path', async t => {
  const f = await fixture(t), select = f.e['profile-dsp'];
  f.state.rows = [{ route_id: 2, dsp_name: 'B' }, { route_id: 3, dsp_name: 'A' }];
  await f.e['profile-station'].listeners.change();
  select.value = 'A'; select.listeners.change();
  await f.submit();
  assert.equal(select.value, 'A'); assert.equal(f.e['profile-routes'].children[0].attributes['data-route-id'], '3');
  assert.match(f.result(), /ZIP 00123 · 站点 MOCKB · 线路 Mock B · DSP Mock DSP · 不在当前 DSP 筛选（A）中/);
  const stale = f.e['profile-zip-result'].children[0]; assert.equal(stale.textContent, '显示该线路');
  f.state.zip = { status: 'uncovered' }; await f.submit('00987');
  await stale.listeners.click(); assert.equal(select.value, 'A'); assert.match(f.result(), /未找到/);
  f.state.zip = { status: 'multi_station', owners: [{ station: 'MOCKC', route_id: 2, route_name: 'Mock C' }] };
  await f.submit(); await f.e['profile-zip-result'].children[0].listeners.click();
  assert.equal(select.value, 'A'); assert.match(f.result(), /不在当前 DSP 筛选/);
  await f.e['profile-zip-result'].children[0].listeners.click();
  assert.equal(select.value, ''); assert.equal(f.e.total.textContent, '2 \u6761');
  assert.equal(f.e['profile-routes'].children[0].className, 'profile-route zip-target-row'); assert.equal(f.e['route-detail'].open, undefined);
  assert.ok(descendants(f.e['detail-content']).some(node => node.className === 'zip-target'));
  select.value = 'B'; select.listeners.change();
  f.state.zip = { status: 'covered', station: 'MOCKC', route_id: 2 }; await f.submit();
  assert.equal(select.value, 'B'); assert.equal(f.e['profile-routes'].children[0].className, 'profile-route zip-target-row');
});

test('NAV1 shared navigation, active state and larger click targets', async () => {
  for (const [name, active] of [['index', '/'], ['map', '/map']]) {
    const html = await readFile(new URL(`../../web/${name}.html`, import.meta.url), 'utf8');
    const nav = html.match(/<nav class="page-nav" aria-label="页面">(.*?)<\/nav>/s)?.[1];
    assert.ok(nav); assert.match(nav, /href="\/"/); assert.match(nav, /href="\/map"/);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
    assert.ok(nav.includes(`href="${active}" aria-current="page"`));
    if (name === 'map') { assert.match(nav, /data-map-text="profiles"/); assert.match(nav, /data-map-text="title"/); }
  }
  const css = await readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.page-nav a \{[^}]*font-size: var\(--fs-16\);[^}]*padding: 8px 12px/);
  assert.match(css, /\.page-nav a\[aria-current="page"\]/);
  assert.match(css, /\.page-nav a:focus-visible/);
  const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<form id="profile-zip-form">.*<button type="submit">搜索<\/button><\/form>/);
});

test('PZ1 form validation never requests invalid ZIPs; pending query disables submit', async t => {
  const f = await fixture(t), initial = f.calls.length;
  for (const input of ['', '1234', '123456', 'abcde', '１２３４５']) { await f.submit(input); assert.equal(f.result(), '请输入 5 位 ZIP'); }
  assert.equal(f.calls.length, initial);
  let release; f.state.zip = () => new Promise(resolve => { release = resolve; });
  const pending = f.submit(' 00123 '); assert.equal(f.button.disabled, true); assert.equal(f.result(), '查询中…');
  release(reply({ status: 'uncovered' })); await pending;
  assert.equal(f.calls.at(-1), '/api/route-map/zip?postal_code=00123'); assert.equal(f.button.disabled, false);
});

test('PZ1 covered ZIP crosses district through shared selection, highlights and scrolls both rows', async t => {
  const f = await fixture(t); await f.submit();
  assert.equal(f.e['profile-district'].value, 'second'); assert.equal(f.e['profile-station'].value, 'MOCKB');
  assert.deepEqual(f.saved.at(-1).value, { district: 'second', station: 'MOCKB' });
  const row = f.e['profile-routes'].children[0]; assert.equal(row.className, 'profile-route zip-target-row'); assert.deepEqual(row.scrolled, { block: 'nearest' });
  assert.equal(f.e['route-detail'].open, undefined);
  const zip = descendants(f.e['detail-content']).find(node => node.className === 'zip-target');
  assert.ok(zip); assert.deepEqual(zip.scrolled, { block: 'center' });
  assert.equal(f.result(), 'ZIP 00123 · 站点 MOCKB · 线路 Mock B · DSP Mock DSP');
  assert.equal(row.attributes['aria-pressed'], 'true');
  f.state.zip.station = 'MOCKC'; await f.submit(); assert.equal(f.e['profile-district'].value, 'unassigned');
});

test('PZ1 multi_station waits for explicit owner choice', async t => {
  const f = await fixture(t);
  f.state.zip = { status: 'multi_station', owners: [{ station: 'MOCKB', route_id: 2, route_name: 'Mock B' }, { station: 'MOCKC', route_id: 2, route_name: 'Mock C' }] };
  await f.submit(); assert.equal(f.e['profile-station'].value, 'MOCKA'); assert.equal(f.saved.length, 0);
  assert.equal(f.e['profile-zip-result'].children.length, 2);
  await f.e['profile-zip-result'].children[1].listeners.click();
  assert.equal(f.e['profile-station'].value, 'MOCKC'); assert.equal(f.e['profile-routes'].children[0].className, 'profile-route zip-target-row');
});

test('PZ1 distinct statuses and fixed errors, with omitted empty fields and DSP fallback', async t => {
  const f = await fixture(t); f.state.zip.status = 'covered_no_boundary'; await f.submit();
  assert.match(f.result(), /有线路归属，但无地图边界/);
  f.state.zip = { status: 'covered', station: 'MOCKB', route_id: 2, route_name: '', dsp_name: 'Fallback' }; await f.submit();
  assert.equal(f.result(), 'ZIP 00123 · 站点 MOCKB · DSP Fallback');
  delete f.state.zip.dsp_name; await f.submit(); assert.equal(f.result(), 'ZIP 00123 · 站点 MOCKB');
  for (const [status, text] of [['uncovered', '当前数据中未找到该 ZIP 的线路归属'], ['no_boundary', '当前数据中未找到该 ZIP 的线路归属（该 ZIP 也没有地图边界）'], ['out_of_range', '该 ZIP 不在当前数据覆盖的州范围内，未找到线路归属']]) {
    f.state.zip = { status }; await f.submit(); assert.equal(f.result(), text); assert.equal(f.e['profile-zip-result'].className, '');
  }
  for (const status of [400, 500]) { f.state.zipStatus = status; await f.submit(); assert.equal(f.result(), 'ZIP 查询失败，请稍后重试'); assert.equal(f.e['profile-zip-result'].className, 'zip-error'); }
  f.state.zipStatus = 200; f.state.zip = Error('private response'); await f.submit(); assert.equal(f.result(), 'ZIP 查询失败，请稍后重试');
});

test('PZ1 missing station, missing route, absent ZIP and absent detail keep real empty states', async t => {
  const f = await fixture(t); f.state.zip.station = 'UNKNOWN'; await f.submit();
  assert.equal(f.result(), '该 ZIP 属于 UNKNOWN，但当前片区配置中没有这个站点');
  f.state.zip.station = 'MOCKB'; f.state.rows = []; await f.submit(); assert.equal(f.result(), '当前快照中找不到该线路');
  f.state.rows = [{ route_id: 2, route_name: 'Mock B' }]; await f.e.retry.listeners.click();
  f.state.zips = [{ postal_code: '00987' }]; await f.submit(); assert.match(f.result(), /该线路的 ZIP 明细中没有这个 ZIP/);
  f.state.detailStatus = 404; await f.submit(); assert.doesNotMatch(f.result(), /该线路的 ZIP 明细中没有这个 ZIP/);
  assert.match(f.e['detail-content'].textContent, /该线路暂无详细数据/);
});

test('PZ1 newer query wins; manual selectors invalidate pending searches and clear highlights', async t => {
  const f = await fixture(t); let release;
  f.state.zip = () => new Promise(resolve => { release = resolve; }); const old = f.submit();
  f.state.zip = { status: 'out_of_range' }; await f.submit('99999');
  release(reply({ status: 'covered', station: 'MOCKB', route_id: 2 })); await old;
  assert.equal(f.e['profile-station'].value, 'MOCKA'); assert.match(f.result(), /不在当前数据覆盖/);
  f.state.zip = { status: 'covered', station: 'MOCKB', route_id: 2 }; await f.submit();
  f.e['profile-station'].value = 'MOCKB'; await f.e['profile-station'].listeners.change();
  assert.equal(f.e['profile-routes'].children[0].className, 'profile-route'); assert.equal(f.e['route-detail'].open, undefined); assert.equal(f.e['profile-zip'].value, '');
  f.state.zip = () => new Promise(resolve => { release = resolve; }); const pending = f.submit();
  f.e['profile-district'].value = 'first'; await f.e['profile-district'].listeners.change();
  release(reply({ status: 'covered', station: 'MOCKC', route_id: 2 })); await pending;
  assert.equal(f.e['profile-district'].value, 'first'); assert.equal(f.e['profile-routes'].children[0].className, 'profile-route');
});

test('PZ1 a new query during profile or detail loading blocks stale highlight and feedback', async t => {
  const f = await fixture(t); let release;
  f.state.profile = () => new Promise(resolve => { release = resolve; });
  const old = f.submit(); await tick();
  f.state.zip = { status: 'uncovered' }; await f.submit('00987');
  release(reply({ rows: f.state.rows, total: 1 })); await old;
  assert.equal(f.e['profile-routes'].children[0].className, 'profile-route'); assert.match(f.result(), /未找到/);
  delete f.state.profile; f.state.zip = { status: 'covered', station: 'MOCKB', route_id: 2 };
  f.state.detail = () => new Promise(resolve => { release = resolve; });
  const detail = f.submit(); await tick();
  f.state.zip = { status: 'out_of_range' }; await f.submit('99999');
  release(reply({ zips: f.state.zips })); await detail;
  assert.equal(f.e['route-detail'].open, undefined); assert.match(f.result(), /不在当前数据覆盖/);
  assert.equal(descendants(f.e['detail-content']).filter(node => node.className === 'zip-target').length, 0);
});

test('PZ1 latest covered query waits for an already loading target station', async t => {
  const f = await fixture(t); let release;
  f.state.profile = () => new Promise(resolve => { release = resolve; });
  const old = f.submit('00987'); await tick();
  const latest = f.submit('00123'); await tick();
  assert.equal(f.e['profile-station'].value, 'MOCKB');
  release(reply({ rows: f.state.rows, total: 1 })); await Promise.all([old, latest]);
  assert.match(f.result(), /^ZIP 00123/); assert.equal(f.e['profile-routes'].children[0].className, 'profile-route zip-target-row');
  // Initial default, target station default, then the latest ZIP highlight request.
  assert.equal(f.calls.filter(url => url.includes('/api/route-details')).length, 3);
  assert.equal(f.calls.at(-1), '/api/route-details?route_id=2');
  assert.ok(descendants(f.e['detail-content']).some(node => node.className === 'zip-target'));
});

 test('PS1 header cycle, exclusive sort, no requests, selector retention and ZIP target by ID', async t => {
  const f = await fixture(t);
  f.state.rows = [{ route_id: 2, route_name: 'Target', pickup_volume: 0, pph: 5 }, { route_id: 3, route_name: 'Other', pickup_volume: 10, pph: 1 }];
  await f.e['profile-station'].listeners.change();
  const volume = f.e['sort-pickup_volume'], pph = f.e['sort-pph'];
  const order = () => f.e['profile-routes'].children.map(row => row.attributes['data-route-id']);
  const initial = f.calls.length, writes = f.saved.length;
  assert.equal(volume.attributes['aria-pressed'], 'false');
  volume.listeners.click(); assert.deepEqual(order(), ['3', '2']); assert.equal(volume.attributes['aria-pressed'], 'true');
  volume.listeners.click(); assert.deepEqual(order(), ['2', '3']); assert.equal(volume.querySelector('span').textContent, '↑');
  volume.listeners.click(); assert.deepEqual(order(), ['2', '3']); assert.equal(volume.attributes['aria-pressed'], 'false');
  volume.listeners.click(); pph.listeners.click(); assert.equal(volume.attributes['aria-pressed'], 'false'); assert.equal(pph.attributes['aria-pressed'], 'true');
  assert.equal(f.calls.length, initial); assert.equal(f.saved.length, writes);
  volume.listeners.click();
  await f.e['profile-station'].listeners.change(); assert.deepEqual(order(), ['3', '2']);
  f.e['profile-district'].value = 'second'; await f.e['profile-district'].listeners.change(); assert.deepEqual(order(), ['3', '2']);
  f.e['profile-district'].value = 'first'; await f.e['profile-district'].listeners.change();
  await f.submit(); assert.deepEqual(order(), ['3', '2']);
  assert.equal(f.e['profile-routes'].children[1].className, 'profile-route zip-target-row'); assert.equal(volume.attributes['aria-pressed'], 'true');

});

test('PS1 fresh page defaults to API order with the name button active', async t => {
  const f = await fixture(t);
  for (const key of ['name', 'pickup_volume', 'pph', 'price', 'route_difficulty']) assert.equal(f.e['sort-' + key].attributes['aria-pressed'], String(key === 'name'));
});

test('RM13c profile presentation retains metric values and filter totals', async t => {
  const f = await fixture(t);
  const { formatUpdated } = await import('../../web/format.js');
  assert.equal(f.e.updated.textContent, formatUpdated('2026-10-08T12:00:00Z'));
  assert.equal(f.e.updated.title, '2026-10-08T12:00:00Z');
  f.state.rows = [{ route_id: 1, dsp_name: 'A' }, { route_id: 2, dsp_name: 'B' }];
  await f.e['profile-station'].listeners.change();
  assert.equal(f.e.total.textContent, '2 \u6761');
  f.e['profile-dsp'].value = 'A'; f.e['profile-dsp'].listeners.change();
  assert.equal(f.e.total.textContent, '1 / 2 \u6761');
  assert.equal(f.e.updated.textContent, formatUpdated('2026-10-08T12:00:00Z'));
  const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/" aria-current="page">线路档案/);
  assert.match(html, /id="profile-data-summary"/);
  assert.equal((html.match(/id="sort-/g) || []).length, 5);
  const css = await readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.profile-sort button[aria-pressed="true"]'));
});
