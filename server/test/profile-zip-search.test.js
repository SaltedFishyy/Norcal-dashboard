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
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = (data, status = 200) => ({ status, json: async () => data });
let counter = 0;
async function fixture(t) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const ids = ['updated', 'total', 'rows', 'table-container', 'message', 'retry', 'profiles', 'profile-station', 'profile-district', 'profile-dsp', 'profile-zip-form', 'profile-zip', 'profile-zip-result', 'route-detail', 'detail-content', 'detail-close', 'detail-title'];
  const e = Object.fromEntries(ids.map(id => [id, new Element()]));
  for (const key of ['pickup_volume', 'pph']) {
    const th = new Element('th'), control = new Element('button');
    control.append(new Element('span')); control.parentNode = th; th.append(control); e['sort-' + key] = control;
  }
  const button = new Element('button'); e['profile-zip-form'].append(button);
  globalThis.document = { getElementById: id => e[id], createElement: tag => new Element(tag), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }) };
  const saved = [], calls = [];
  globalThis.localStorage = { getItem: () => null, setItem: (key, value) => saved.push({ key, value: JSON.parse(value) }) };
  const districts = ['first', 'second', 'unassigned'].map((id, i) => ({ id, name_zh: id, stations: [{ code: ['MOCKA', 'MOCKB', 'MOCKC'][i], has_snapshot: true }] }));
  const state = { zip: { status: 'covered', station: 'MOCKB', route_id: 2, route_name: 'Mock B', route: { dsp_name: 'Mock DSP' }, dsp_name: 'Fallback' },
    rows: [{ route_id: 2, route_name: 'Mock B', station: 'MOCKB' }], zips: [{ postal_code: '00123' }], detailStatus: 200 };
  globalThis.fetch = async url => {
    calls.push(url);
    if (url === '/api/districts') return reply({ districts });
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
  assert.equal(f.e.total.textContent, '5');
  select.value = 'Z'; select.listeners.change();
  const order = () => f.e.rows.children.map(row => row.attributes['data-route-id']);
  assert.deepEqual(order(), ['1', '3']); assert.equal(f.e.total.textContent, '2 / 5');
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
  assert.equal(f.e.total.textContent, '0');
  let release; f.state.profile = () => new Promise(resolve => { release = resolve; });
  const pending = f.e.retry.listeners.click(); assert.equal(select.disabled, true);
  release(reply({ error: 'internal_error' }, 500)); await pending; assert.equal(select.disabled, true);
  assert.ok(f.saved.every(write => !Object.hasOwn(write.value, 'dsp')));
});

test('PD1 DSP change clears ZIP feedback, highlight and dialog but preserves input and invalidates pending queries', async t => {
  const f = await fixture(t);
  f.state.rows = [{ route_id: 2, dsp_name: 'A' }, { route_id: 3, dsp_name: 'B' }];
  await f.e['profile-station'].listeners.change();
  await f.submit(); assert.equal(f.e['route-detail'].open, true);
  const oldRow = f.e.rows.children[0];
  f.e['profile-dsp'].value = 'A'; f.e['profile-dsp'].listeners.change();
  assert.equal(f.result(), ''); assert.equal(oldRow.className, '');
  assert.equal(f.e.rows.children[0].className, ''); assert.equal(f.e['route-detail'].open, false);
  assert.equal(f.e['profile-zip'].value, '00123');
  let release; f.state.zip = () => new Promise(resolve => { release = resolve; });
  const pending = f.submit();
  f.e['profile-dsp'].value = 'B'; f.e['profile-dsp'].listeners.change();
  release(reply({ status: 'covered', station: 'MOCKB', route_id: 2 })); await pending;
  assert.equal(f.result(), ''); assert.equal(f.e['profile-dsp'].value, 'B');
  assert.equal(f.e['route-detail'].open, false);
});

test('PD1 excluded ZIP offers explicit reveal; stale buttons cannot change filters; multi-station uses same path', async t => {
  const f = await fixture(t), select = f.e['profile-dsp'];
  f.state.rows = [{ route_id: 2, dsp_name: 'B' }, { route_id: 3, dsp_name: 'A' }];
  await f.e['profile-station'].listeners.change();
  select.value = 'A'; select.listeners.change();
  await f.submit();
  assert.equal(select.value, 'A'); assert.notEqual(f.e['route-detail'].open, true);
  assert.match(f.result(), /ZIP 00123 · 站点 MOCKB · 线路 Mock B · DSP Mock DSP · 不在当前 DSP 筛选（A）中/);
  const stale = f.e['profile-zip-result'].children[0]; assert.equal(stale.textContent, '显示该线路');
  f.state.zip = { status: 'uncovered' }; await f.submit('00987');
  await stale.listeners.click(); assert.equal(select.value, 'A'); assert.match(f.result(), /未找到/);
  f.state.zip = { status: 'multi_station', owners: [{ station: 'MOCKC', route_id: 2, route_name: 'Mock C' }] };
  await f.submit(); await f.e['profile-zip-result'].children[0].listeners.click();
  assert.equal(select.value, 'A'); assert.match(f.result(), /不在当前 DSP 筛选/);
  await f.e['profile-zip-result'].children[0].listeners.click();
  assert.equal(select.value, ''); assert.equal(f.e.total.textContent, '2');
  assert.equal(f.e.rows.children[0].className, 'zip-target-row'); assert.equal(f.e['route-detail'].open, true);
  assert.ok(descendants(f.e['detail-content']).some(node => node.className === 'zip-target'));
  select.value = 'B'; select.listeners.change();
  f.state.zip = { status: 'covered', station: 'MOCKC', route_id: 2 }; await f.submit();
  assert.equal(select.value, 'B'); assert.equal(f.e.rows.children[0].className, 'zip-target-row');
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
  assert.match(css, /\.page-nav a \{[^}]*font-size: 17px;[^}]*padding: 8px 12px/);
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
  const row = f.e.rows.children[0]; assert.equal(row.className, 'zip-target-row'); assert.deepEqual(row.scrolled, { block: 'center' });
  assert.equal(f.e['route-detail'].open, true);
  const zip = descendants(f.e['detail-content']).find(node => node.className === 'zip-target');
  assert.ok(zip); assert.deepEqual(zip.scrolled, { block: 'center' });
  assert.equal(f.result(), 'ZIP 00123 · 站点 MOCKB · 线路 Mock B · DSP Mock DSP');
  f.e['detail-close'].listeners.click(); assert.equal(row.children[0].children[0].focused, true);
  f.state.zip.station = 'MOCKC'; await f.submit(); assert.equal(f.e['profile-district'].value, 'unassigned');
});

test('PZ1 multi_station waits for explicit owner choice', async t => {
  const f = await fixture(t);
  f.state.zip = { status: 'multi_station', owners: [{ station: 'MOCKB', route_id: 2, route_name: 'Mock B' }, { station: 'MOCKC', route_id: 2, route_name: 'Mock C' }] };
  await f.submit(); assert.equal(f.e['profile-station'].value, 'MOCKA'); assert.equal(f.saved.length, 0);
  assert.equal(f.e['profile-zip-result'].children.length, 2);
  await f.e['profile-zip-result'].children[1].listeners.click();
  assert.equal(f.e['profile-station'].value, 'MOCKC'); assert.equal(f.e.rows.children[0].className, 'zip-target-row');
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
  assert.equal(f.e.rows.children[0].className, ''); assert.equal(f.e['route-detail'].open, false); assert.equal(f.e['profile-zip'].value, '00123');
  f.state.zip = () => new Promise(resolve => { release = resolve; }); const pending = f.submit();
  f.e['profile-district'].value = 'first'; await f.e['profile-district'].listeners.change();
  release(reply({ status: 'covered', station: 'MOCKC', route_id: 2 })); await pending;
  assert.equal(f.e['profile-district'].value, 'first'); assert.equal(f.e.rows.children[0].className, '');
});

test('PZ1 a new query during profile or detail loading blocks stale highlight and feedback', async t => {
  const f = await fixture(t); let release;
  f.state.profile = () => new Promise(resolve => { release = resolve; });
  const old = f.submit(); await tick();
  f.state.zip = { status: 'uncovered' }; await f.submit('00987');
  release(reply({ rows: f.state.rows, total: 1 })); await old;
  assert.equal(f.e.rows.children[0].className, ''); assert.match(f.result(), /未找到/);
  delete f.state.profile; f.state.zip = { status: 'covered', station: 'MOCKB', route_id: 2 };
  f.state.detail = () => new Promise(resolve => { release = resolve; });
  const detail = f.submit(); await tick();
  f.state.zip = { status: 'out_of_range' }; await f.submit('99999');
  release(reply({ zips: f.state.zips })); await detail;
  assert.equal(f.e['route-detail'].open, false); assert.match(f.result(), /不在当前数据覆盖/);
  assert.equal(descendants(f.e['detail-content']).filter(node => node.className === 'zip-target').length, 0);
});

test('PZ1 latest covered query waits for an already loading target station', async t => {
  const f = await fixture(t); let release;
  f.state.profile = () => new Promise(resolve => { release = resolve; });
  const old = f.submit('00987'); await tick();
  const latest = f.submit('00123'); await tick();
  assert.equal(f.e['profile-station'].value, 'MOCKB');
  release(reply({ rows: f.state.rows, total: 1 })); await Promise.all([old, latest]);
  assert.match(f.result(), /^ZIP 00123/); assert.equal(f.e.rows.children[0].className, 'zip-target-row');
  assert.equal(f.calls.filter(url => url.includes('/api/route-details')).length, 1);
});

 test('PS1 header cycle, exclusive sort, no requests, selector retention and ZIP target by ID', async t => {
  const f = await fixture(t);
  f.state.rows = [{ route_id: 2, route_name: 'Target', pickup_volume: 0, pph: 5 }, { route_id: 3, route_name: 'Other', pickup_volume: 10, pph: 1 }];
  await f.e['profile-station'].listeners.change();
  const volume = f.e['sort-pickup_volume'], pph = f.e['sort-pph'];
  const order = () => f.e.rows.children.map(row => row.attributes['data-route-id']);
  const initial = f.calls.length, writes = f.saved.length;
  assert.equal(volume.parentNode.attributes['aria-sort'], 'none');
  volume.listeners.click(); assert.deepEqual(order(), ['3', '2']); assert.equal(volume.parentNode.attributes['aria-sort'], 'descending');
  volume.listeners.click(); assert.deepEqual(order(), ['2', '3']); assert.equal(volume.querySelector('span').textContent, '↑');
  volume.listeners.click(); assert.deepEqual(order(), ['2', '3']); assert.equal(volume.parentNode.attributes['aria-sort'], 'none');
  volume.listeners.click(); pph.listeners.click(); assert.equal(volume.parentNode.attributes['aria-sort'], 'none'); assert.equal(pph.parentNode.attributes['aria-sort'], 'descending');
  assert.equal(f.calls.length, initial); assert.equal(f.saved.length, writes);
  volume.listeners.click();
  await f.e['profile-station'].listeners.change(); assert.deepEqual(order(), ['3', '2']);
  f.e['profile-district'].value = 'second'; await f.e['profile-district'].listeners.change(); assert.deepEqual(order(), ['3', '2']);
  f.e['profile-district'].value = 'first'; await f.e['profile-district'].listeners.change();
  await f.submit(); assert.deepEqual(order(), ['3', '2']);
  assert.equal(f.e.rows.children[1].className, 'zip-target-row'); assert.equal(volume.parentNode.attributes['aria-sort'], 'descending');

});

test('PS1 fresh page defaults to API order with inactive headers', async t => {
  const f = await fixture(t);
  for (const key of ['pickup_volume', 'pph']) assert.equal(f.e['sort-' + key].parentNode.attributes['aria-sort'], 'none');
});
