import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, Element } from './route-map-web.test.js';
import { createWarehouseLayer } from '../../web/warehouse-layer.js';
import { createWarehousePanel } from '../../web/warehouse-panel.js';
import { buildRouteMap, lookupZip } from '../src/route-map/route-map.js';
import { profiles, boundaries } from './route-map-fixtures.js';
import { createApiServer } from '../src/api/server.js';
import { isStaticPath } from '../src/api/static-files.js';

const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const warehouse = overrides => ({ id: 'mock-warehouse', warehouse_name: 'Mock Warehouse', address: 'Mock Address',
  district_id: 'mock', district_name_zh: '测试片区', district_known: true, station_id: null, station_known: true,
  latitude: 37, longitude: -122, updated_at: '2026-10-09T00:00:00Z', ...overrides });
const nodes = node => [node, ...node.children.flatMap(nodes)];
const text = node => nodes(node).map(n => n.textContent).join(' ');
const find = (node, tag, label) => nodes(node).find(n => n.tagName === tag && (label === undefined || n.textContent === label));
const click = (node, label) => find(node, 'button', label).listeners.click();
const fill = (dialog, values = {}) => {
  for (const [key, value] of Object.entries({ warehouse_name: 'Mock Warehouse', address: 'Mock Address', district_id: 'mock', station_id: '', ...values }))
    nodes(dialog).find(n => n.name === key).value = value;
};
const save = dialog => find(dialog, 'form').listeners.submit({ preventDefault() {} });
async function started() {
  const f = await fixture();
  f.replies.push(f.reply(200, { stations: ['MOCKA', 'MOCKB'] }), f.reply(200, {
    station: 'MOCKA', routes: [], features: { type: 'FeatureCollection', features: [] },
    missing: [], coverage: { total: 0, mapped: 0, missing: 0 }, boundary_source: {},
  }));
  await f.page.start(); await settle(); return f;
}

test('warehouse modules are served as JavaScript and every relative map import is whitelisted', async t => {
  const server = createApiServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  for (const name of ['warehouse-layer', 'warehouse-panel']) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/${name}.js`);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /^text\/javascript(?:;|$)/);
    await result.text();
  }
  for (const name of ['map', 'warehouse-layer', 'warehouse-panel']) {
    const source = await readFile(new URL(`../../web/${name}.js`, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)['"]\.\/([^'"]+\.js)['"]/g)];
    assert.ok(imports.length, `${name} imports were parsed`);
    for (const [, imported] of imports) assert.equal(isStaticPath(`/${imported}`), true, `${name} imports ${imported}`);
  }
});

test('WH-AC5: failed warehouse load retries on Station change, then successful load is reused', async () => {
  const f = await fixture();
  const payload = () => buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() });
  f.replies.push(f.reply(200, { stations: ['MOCKA', 'MOCKB'] }), f.reply(200, payload()));
  f.warehouseReplies.push(response(503, { error: 'data_source_unavailable' }));
  await f.page.start(); await settle();
  assert.match(f.elements['map-warehouse-message'].textContent, /仓库信息暂时无法加载/);
  assert.equal(f.markers.length, 0);
  const count = f.warehouseRequests.length;
  f.elements['map-station'].value = 'MOCKB'; f.replies.push(f.reply(200, payload()));
  f.warehouseReplies.push(response(200, { warehouses: [warehouse()] }));
  await f.elements['map-station'].listeners.change(); await settle();
  assert.equal(f.warehouseRequests.length, count + 1); assert.equal(f.markers.length, 1);
  assert.equal(f.elements['map-warehouse-message'].textContent, '');
  const marker = f.markers[0];
  f.elements['map-station'].value = 'MOCKA'; f.replies.push(f.reply(200, payload()));
  await f.elements['map-station'].listeners.change(); await settle();
  assert.equal(f.warehouseRequests.length, count + 1);
  assert.equal(f.markers.length, 1); assert.equal(f.map.removed.includes(marker), false);
});

test('WH-AC1/2: POST and PATCH refresh markers, focus/highlight and carry concurrency version', async () => {
  const f = await started(); await f.elements['map-warehouses'].listeners.click();
  const dialog = f.doc.body.children[0]; click(dialog, '添加仓库'); fill(dialog);
  f.warehouseReplies.push(response(201, { warehouse: warehouse(), geocode: { matched_address: 'Matched Mock' }, warnings: ['duplicate_name'] }),
    response(200, { warehouses: [warehouse()] }), response(200, { warehouses: [warehouse()] }));
  await save(dialog);
  assert.equal(find(dialog, 'form').hidden, true); assert.equal(dialog.open, false);
  assert.match(text(f.elements['map-warehouse-notice']), /已定位：Matched Mock/);
  assert.match(text(f.elements['map-warehouse-notice']), /已有同名仓库/);
  assert.equal(f.elements['map-warehouse-message'].textContent, '');
  assert.deepEqual(f.map.flight, { point: [37, -122], zoom: 13 });
  assert.equal(f.markers.at(-1).node.classList.contains('warehouse-marker--highlight'), true);
  assert.equal(f.markers.at(-1).popupOpen, true);
  const post = f.warehouseRequests.find(r => r.options?.method === 'POST');
  assert.equal(post.options.headers['X-NC-Warehouse'], '1'); assert.equal(post.options.headers['Content-Type'], 'application/json');
  assert.equal(post.options.headers.Origin, undefined);
  f.warehouseReplies.push(response(200, { warehouse_write: true }), response(200, { warehouses: [warehouse()] }));
  await f.elements['map-warehouses'].listeners.click();
  assert.equal(text(f.elements['map-warehouse-notice']), '');
  click(dialog, '编辑'); fill(dialog, { address: 'Changed Mock Address' });
  f.warehouseReplies.push(response(200, { warehouse: warehouse({ latitude: 38 }), geocode: { matched_address: 'Changed Matched Mock' }, warnings: [] }),
    response(200, { warehouses: [warehouse({ latitude: 38 })] }), response(200, { warehouses: [warehouse({ latitude: 38 })] }));
  await save(dialog);
  assert.equal(JSON.parse(f.warehouseRequests.find(r => r.options?.method === 'PATCH').options.body).expected_updated_at, warehouse().updated_at);
  assert.deepEqual(f.map.flight.point, [38, -122]);
  assert.equal(dialog.open, false);
  assert.equal(f.markers.at(-1).node.classList.contains('warehouse-marker--highlight'), true);
  assert.match(text(f.elements['map-warehouse-notice']), /已定位：Changed Matched Mock/);
  f.replies.push(f.reply(200, { station: 'MOCKA', routes: [], features: { type: 'FeatureCollection', features: [] },
    missing: [], coverage: { total: 0, mapped: 0, missing: 0 }, boundary_source: {} }));
  await f.elements['map-district'].listeners.change();
  assert.equal(text(f.elements['map-warehouse-notice']), '');
});

function panelFixture({ writable = true, confirm = () => true } = {}) {
  const entry = new Element(), pageNotice = new Element(), doc = { body: new Element(),
    getElementById: id => id === 'map-warehouse-notice' ? pageNotice : entry, createElement: tag => new Element(tag) };
  const calls = [], replies = [], saved = [], deleted = [], viewed = [];
  const districts = [{ id: 'mock', name_zh: '测试片区', stations: [{ code: 'MOCKA' }] }, { id: 'other', name_zh: '另一个片区', stations: [{ code: 'MOCKB' }] }];
  const panel = createWarehousePanel({ document: doc, confirm, getDistricts: () => districts, getCurrentDistrict: () => 'mock',
    onSaved: value => { if (value.warehouse?.district_id === 'mock') assert.equal(panel.isOpen(), false); saved.push(value); },
    onDeleted: id => deleted.push(id), onView: row => viewed.push(row),
    fetch: async (url, options) => { calls.push({ url, options }); const next = replies.shift();
      if (next instanceof Error) throw next;
      return next || response(200, url === '/api/capabilities' ? { warehouse_write: writable } : { warehouses: [] }); } });
  return { panel, entry, dialog: doc.body.children[0], calls, replies, saved, deleted, viewed };
}

test('WH-AC1/2: current District POST and PATCH close panel before onSaved', async () => {
  const p = panelFixture();
  await p.panel.open(); click(p.dialog, '添加仓库'); fill(p.dialog);
  p.replies.push(response(201, { warehouse: warehouse(), warnings: [] }), response(200, { warehouses: [warehouse()] }));
  await save(p.dialog); assert.equal(p.panel.isOpen(), false);
  p.replies.push(response(200, { warehouse_write: true }), response(200, { warehouses: [warehouse()] }));
  await p.panel.open(); click(p.dialog, '编辑'); fill(p.dialog);
  p.replies.push(response(200, { warehouse: warehouse(), warnings: [] }));
  await save(p.dialog); assert.equal(p.panel.isOpen(), false); assert.equal(p.saved.length, 2);
});

test('WH-AC3: delete cancel sends nothing; confirmed DELETE includes name/address and refreshes markers', async () => {
  let approved = false, message;
  const p = panelFixture({ confirm: value => { message = value; return approved; } });
  p.replies.push(response(200, { warehouse_write: true }), response(200, { warehouses: [warehouse()] })); await p.panel.open();
  const before = p.calls.length; await click(p.dialog, '删除'); assert.equal(p.calls.length, before);
  assert.match(message, /Mock Warehouse/); assert.match(message, /Mock Address/);
  approved = true; p.replies.push(response(204)); await click(p.dialog, '删除');
  assert.equal(p.calls.at(-2).options.method, 'DELETE'); assert.deepEqual(p.deleted, ['mock-warehouse']);
  assert.equal(p.panel.isOpen(), true);
  const f = await started(), fake = layerFake(f); let rows = [warehouse()];
  const layer = createWarehouseLayer({ leaflet: fake.L, map: f.map, document: f.doc, fetch: async () => response(200, { warehouses: rows }) });
  await layer.load('mock'); const marker = fake.created[0]; rows = []; await layer.load('mock');
  assert.ok(f.map.removed.includes(marker)); assert.equal(f.controls.at(-1).hidden, true);
});

test('WH-AC5/6: Station/DSP/Route/ZIP/color/search preserve warehouse identity, style and request count', async () => {
  const f = await fixture();
  const payload = () => buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() });
  f.replies.push(f.reply(200, { stations: ['MOCKA', 'MOCKB'] }), f.reply(200, payload()));
  f.warehouseReplies.push(response(200, { warehouses: [warehouse()] })); await f.page.start(); await settle();
  const marker = f.markers[0], count = f.warehouseRequests.length, icon = marker.options.icon;
  f.elements['map-routes'].children[0].listeners.click();
  const selected = text(f.elements['map-summary']);
  // Leaflet's marker bubbling flag prevents the map click handler from running.
  marker.openPopup(); if (marker.options.bubblingMouseEvents) f.map.listeners.click();
  assert.equal(text(f.elements['map-summary']), selected);
  f.controls[1].children[1].listeners.click();
  f.elements['map-dsp'].value = ''; f.elements['map-dsp'].listeners.change();
  f.groups[0].layers[0].listeners.click({});
  f.replies.push(f.reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00002' })));
  await f.page.searchQuery('00002', true);
  f.elements['map-station'].value = 'MOCKB'; f.replies.push(f.reply(200, payload())); await f.elements['map-station'].listeners.change(); await settle();
  assert.equal(f.warehouseRequests.length, count); assert.equal(f.markers.length, 1);
  assert.equal(marker.options.icon, icon); assert.equal(f.map.removed.includes(marker), false);
  assert.equal(marker.options.opacity, undefined);
});

test('WH-AC19 integration: View shares District preference flow, loads routes/layer then focuses', async () => {
  const writes = [], f = await fixture('', 206, { getItem: () => null, setItem: (key, value) => writes.push([key, value]) });
  const districts = [{ id: 'mock', name_zh: '测试片区', stations: [{ code: 'MOCKA', has_snapshot: true }] },
    { id: 'other', name_zh: '另一个片区', stations: [{ code: 'MOCKB', has_snapshot: true }] }];
  const payload = buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() });
  f.replies.push(f.reply(200, { districts }), f.reply(200, payload)); await f.page.start(); await settle();
  await f.elements['map-warehouses'].listeners.click(); const dialog = f.doc.body.children[0]; click(dialog, '添加仓库'); fill(dialog, { district_id: 'other' });
  const other = warehouse({ district_id: 'other' });
  f.warehouseReplies.push(response(201, { warehouse: other, warnings: [] }), response(200, { warehouses: [] }), response(200, { warehouses: [] }));
  await save(dialog); assert.equal(f.elements['map-district'].value, 'mock');
  assert.equal(dialog.open, true); assert.ok(find(dialog, 'button', '查看仓库'));
  f.replies.push(f.reply(200, payload)); f.warehouseReplies.push(response(200, { warehouses: [other] }));
  await click(dialog, '查看仓库'); assert.equal(f.elements['map-district'].value, 'other');
  assert.equal(f.requests.at(-1).url, '/api/route-map/district?district=other');
  assert.equal(f.warehouseRequests.at(-1).url, '/api/warehouses?district=other');
  assert.equal(f.markers.at(-1).popupOpen, true); assert.equal(f.map.flight.zoom, 13);
  assert.ok(writes.some(([key, value]) => key.endsWith('.selection') && JSON.parse(value).district === 'other'));
  assert.ok(writes.some(([key]) => key.endsWith('.map-scope')));
});

function layerFake(f) {
  const created = [];
  const L = { control: () => ({ addTo() { f.controls.push(this.onAdd()); } }),
    divIcon: options => ({ ...options, createIcon: () => new Element() }),
    marker: (point, options) => {
      const node = new Element(), classes = new Set(); node.classList = { add: c => classes.add(c), remove: c => classes.delete(c) };
      const m = { point, options, bindPopup(popup) { this.popup = popup; return this; }, addTo() { created.push(this); return this; },
        getLatLng: () => point, getElement: () => node, openPopup() {} }; return m;
    } };
  return { L, created };
}
test('WH-AC4/6/15: stale district replies ignored, DOM popup safe, optional Station, legend and error isolation', async () => {
  const f = await fixture(), fake = layerFake(f); let resolve, errors = [], calls = [];
  const layer = createWarehouseLayer({ leaflet: fake.L, map: f.map, document: f.doc, onError: v => errors.push(v),
    fetch: async url => { calls.push(url); if (url.endsWith('old')) return new Promise(r => { resolve = r; });
      return response(200, { warehouses: [warehouse({ warehouse_name: '<img src=x onerror=alert(1)>', station_id: 'MOCKA' })] }); } });
  const old = layer.load('old'); await layer.load('mock'); resolve(response(200, { warehouses: [warehouse({ id: 'old' })] })); await old;
  assert.deepEqual(calls, ['/api/warehouses?district=old', '/api/warehouses?district=mock']); assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].popup.children.length, 4); assert.match(text(fake.created[0].popup), /<img src=x onerror=alert\(1\)>/);
  assert.equal(find(fake.created[0].popup, 'img'), undefined); assert.equal(fake.created[0].options.bubblingMouseEvents, false);
  assert.equal(fake.created[0].options.pane, 'warehouse'); assert.equal(f.map.panes.warehouse.style.zIndex, '620');
  layer.clear(); assert.ok(f.map.removed.includes(fake.created[0]));
  const emptyLayer = createWarehouseLayer({ leaflet: fake.L, map: f.map, document: f.doc, fetch: async () => response(200, { warehouses: [warehouse()] }) });
  await emptyLayer.load('mock'); assert.equal(fake.created.at(-1).popup.children.length, 3);
  const broken = createWarehouseLayer({ leaflet: fake.L, map: f.map, document: f.doc, onError: v => errors.push(v), fetch: async () => { throw new Error(); } });
  await broken.load('mock'); assert.match(errors.at(-1), /仓库信息暂时无法加载/); assert.equal(f.elements['map-message'].textContent, '');
});

for (const code of ['geocode_failed', 'geocode_ambiguous', 'geocode_unavailable']) test(`WH-AC9: ${code} preserves input and enables collapsed manual fallback`, async () => {
  const p = panelFixture(); await p.panel.open(); click(p.dialog, '添加仓库'); fill(p.dialog);
  assert.equal(find(p.dialog, 'details').hidden, true);
  p.replies.push(response(code === 'geocode_unavailable' ? 503 : 422, { error: code })); await save(p.dialog);
  assert.equal(nodes(p.dialog).find(n => n.name === 'address').value, 'Mock Address');
  assert.equal(find(p.dialog, 'details').hidden, false); assert.equal(find(p.dialog, 'details').open, false);
  fill(p.dialog, { latitude: '37.2', longitude: '-122.1' });
  p.replies.push(response(201, { warehouse: warehouse(), warnings: [] })); await save(p.dialog);
  assert.deepEqual(JSON.parse(p.calls.findLast(c => c.options?.method === 'POST').options.body).manual_coordinates, { latitude: 37.2, longitude: -122.1 });
});

test('confirmation includes duplicate/distance/matched address; return retains input and confirm re-submits reasons', async () => {
  const p = panelFixture(); await p.panel.open(); click(p.dialog, '添加仓库'); fill(p.dialog);
  const conflict = response(409, { error: 'confirmation_required', reasons: ['duplicate_address', 'far_from_district'],
    duplicates: [warehouse()], distance_km: 70, geocode: { matched_address: 'Matched Mock' } });
  p.replies.push(conflict); await save(p.dialog);
  assert.match(text(p.dialog), /可能重复/); assert.match(text(p.dialog), /约 70 km/); assert.match(text(p.dialog), /识别地址：Matched Mock/);
  click(p.dialog, '返回修改'); assert.equal(nodes(p.dialog).find(n => n.name === 'address').value, 'Mock Address');
  p.replies.push(conflict); await save(p.dialog);
  p.replies.push(response(201, { warehouse: warehouse(), warnings: [] })); await click(p.dialog, '确认保存');
  assert.deepEqual(JSON.parse(p.calls.findLast(c => c.options?.method === 'POST').options.body).confirm, ['duplicate_address', 'far_from_district']);
});

test('warehouse_changed/not_found refresh list and map while preserving input; errors retain form', async () => {
  for (const code of ['warehouse_changed', 'warehouse_not_found', 'station_not_in_district', 'district_not_found', 'invalid_warehouse', 'forbidden_header']) {
    const p = panelFixture(); await p.panel.open(); click(p.dialog, '添加仓库'); fill(p.dialog);
    p.replies.push(response(409, { error: code, fields: ['address'] })); await save(p.dialog);
    assert.equal(find(p.dialog, 'form').hidden, false); assert.equal(nodes(p.dialog).find(n => n.name === 'address').value, 'Mock Address');
    assert.ok(text(find(p.dialog, 'form')).length); assert.equal(p.saved.length, ['warehouse_changed', 'warehouse_not_found'].includes(code) ? 1 : 0);
  }
});

test('read-only capability false or request failure hides writes and still loads list', async () => {
  for (const reply of [response(200, { warehouse_write: false }), new Error('network')]) {
    const p = panelFixture(); p.replies.push(reply, response(200, { warehouses: [warehouse()] })); await p.panel.open();
    assert.equal(find(p.dialog, 'button', '添加仓库').hidden, true); assert.match(text(p.dialog), /当前服务未开启仓库编辑/);
    assert.equal(find(p.dialog, 'button', '编辑').parentNode.hidden, true);
    assert.equal(find(p.dialog, 'button', '删除').parentNode.hidden, true);
  }
});

test('WH-AC15: all tab marks orphan district/station; edit requires new district and district change resets Station', async () => {
  const p = panelFixture(); await p.panel.open();
  p.replies.push(response(200, { warehouses: [warehouse({ district_known: false, station_known: false })] }));
  await click(p.dialog, '全部仓库'); assert.equal(p.calls.at(-1).url, '/api/warehouses');
  assert.match(text(p.dialog), /Unknown District/); assert.match(text(p.dialog), /站点不存在/);
  click(p.dialog, '编辑'); const district = nodes(p.dialog).find(n => n.name === 'district_id'), station = nodes(p.dialog).find(n => n.name === 'station_id');
  assert.equal(district.value, ''); assert.equal(district.required, true);
  district.value = 'other'; district.listeners.change(); assert.equal(station.value, ''); assert.equal(station.children[1].value, 'MOCKB');
});

test('WH-AC19: other district save waits for View; button closes panel and calls destination flow', async () => {
  const p = panelFixture(); await p.panel.open(); click(p.dialog, '添加仓库'); fill(p.dialog, { district_id: 'other' });
  p.replies.push(response(201, { warehouse: warehouse({ district_id: 'other' }), warnings: [] })); await save(p.dialog);
  assert.equal(p.viewed.length, 0); assert.match(text(p.dialog), /已保存到 另一个片区/);
  assert.equal(p.panel.isOpen(), true); assert.ok(find(p.dialog, 'button', '查看仓库'));
  await click(p.dialog, '查看仓库'); assert.equal(p.viewed[0].district_id, 'other'); assert.equal(p.panel.isOpen(), false);
});

test('Escape closes panel, restores entry focus and blocks map key handler', async () => {
  const p = panelFixture(); await p.panel.open(); let stopped = false;
  p.dialog.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true); assert.equal(p.panel.isOpen(), false); assert.equal(p.entry.focused, true);
});

test('FIX2-AC1: legend icon overrides Leaflet positioning and inline anchor margins', async () => {
  const css = await readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.warehouse-legend\s+\.warehouse-legend-icon\s*\{([^}]+)\}/);
  assert.ok(rule, 'legend icon must have a scoped CSS rule');
  assert.match(rule[1], /(?:^|;)\s*position:\s*static\s*;/);
  assert.match(rule[1], /(?:^|;)\s*margin:\s*0\s*!important\s*;/);
});

test('WH-AC17 / CSP: responsive bounded table/cards, fullscreen mobile, reduced motion and static icon', async () => {
  const css = await readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.warehouse-list \{ min-width: 0; width: 100%; table-layout: fixed;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.warehouse-panel \{ width: 100vw; max-width: 100vw; height: 100dvh/);
  assert.match(css, /\.warehouse-list, \.warehouse-list tbody, \.warehouse-list tr, \.warehouse-list td \{ display: block; width: 100%; min-width: 0;/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  for (const name of ['warehouse-layer.js', 'warehouse-panel.js', 'map.html']) {
    const source = await readFile(new URL(`../../web/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /style\s*=|on(?:click|error)\s*=|<script(?![^>]*\bsrc=)/);
  }
});

const settle = () => new Promise(resolve => setImmediate(resolve));

const modules = [{ createWarehouseLayer }, { createWarehousePanel }];
async function mainFixture(options = {}) {
  const f = await fixture('', 206, null, options);
  f.replies.push(f.reply(200, { districts: [
    { id: 'mock', name_zh: '测试片区', stations: [{ code: 'MOCKA', has_snapshot: true }, { code: 'MOCKB', has_snapshot: true }] },
    { id: 'other', name_zh: '另一个片区', stations: [{ code: 'MOCKB', has_snapshot: true }] },
  ] }), f.reply(200, buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() })));
  return f;
}
function assertMain(f) {
  assert.ok(f.elements['map-district'].children.length);
  assert.ok(f.elements['map-station'].children.length);
  assert.ok(f.groups.some(group => group.layers.length));
  assert.equal(f.elements['map-dsp'].disabled, false);
  assert.equal(f.elements['map-content'].attributes['aria-busy'], 'false');
  assert.doesNotMatch(f.elements['map-message'].textContent, /正在加载/);
}
for (const [name, loader] of [
  ['module rejection', () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))],
  ['layer constructor', () => Promise.resolve([{ createWarehouseLayer() { throw new Error('constructor'); } }, modules[1]])],
  ['panel constructor', () => Promise.resolve([modules[0], { createWarehousePanel() { throw new Error('constructor'); } }])],
]) test(`FIX-AC1: ${name} leaves main map usable without unhandled rejection`, async () => {
  const rejected = [], listener = error => rejected.push(error);
  process.on('unhandledRejection', listener);
  try {
    const f = await mainFixture({ loadWarehouseModules: loader });
    await f.page.start(); await settle(); assertMain(f);
    assert.equal(f.elements['map-warehouses'].hidden, true);
    assert.equal(f.elements['map-warehouse-message'].textContent, '仓库信息暂时无法加载');
    assert.deepEqual(rejected, []);
  } finally { process.removeListener('unhandledRejection', listener); }
});
for (const status of [500, 503, 'non-json']) test(`FIX-AC3: warehouse ${status} is isolated from main interactions`, async () => {
  const f = await mainFixture();
  f.warehouseReplies.push(status === 'non-json' ? { ok: true, json: async () => { throw new SyntaxError('HTML'); } } : response(status, {}));
  await f.page.start(); await settle(); assertMain(f);
  assert.equal(f.markers.length, 0);
  assert.equal(f.elements['map-warehouse-message'].textContent, '仓库信息暂时无法加载');
  f.elements['map-dsp'].value = ''; f.elements['map-dsp'].listeners.change();
  f.elements['map-routes'].children[0].listeners.click();
  f.elements['map-station'].value = 'MOCKB';
  f.replies.push(f.reply(200, buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() })));
  await f.elements['map-station'].listeners.change(); assertMain(f);
});
test('FIX-AC3: empty warehouse array hides legend without errors in layer and panel', async () => {
  const f = await mainFixture(); await f.page.start(); await settle(); assertMain(f);
  assert.equal(f.markers.length, 0); assert.equal(f.controls.at(-1).hidden, true);
  assert.equal(f.elements['map-warehouse-message'].textContent, '');
  const p = panelFixture(); await p.panel.open(); assert.match(text(p.dialog), /暂无仓库/);
  assert.doesNotMatch(text(p.dialog), /暂时无法加载/);
  p.replies.push({ ok: true, json: async () => { throw new SyntaxError('HTML'); } });
  await p.panel.load(); assert.match(text(p.dialog), /仓库信息暂时无法加载/);
});
test('FIX-AC2: hanging warehouse request never blocks Station or District load', async () => {
  const f = await mainFixture(); f.warehouseReplies.push(() => new Promise(() => {}));
  await f.page.start(); assertMain(f);
  f.replies.push(f.reply(200, buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() })));
  assert.equal(await f.page.loadStation(), true); assertMain(f);
  f.elements['map-district'].value = 'other';
  f.replies.push(f.reply(200, buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() })));
  f.warehouseReplies.push(() => new Promise(() => {}));
  assert.equal(await f.elements['map-district'].listeners.change(), true); assertMain(f);
  assert.equal(f.requests.at(-1).url, '/api/route-map/district?district=other');
});
test('FIX-AC1: delayed modules catch up with current District after main render', async () => {
  let release;
  const f = await mainFixture({ loadWarehouseModules: () => new Promise(resolve => { release = resolve; }) });
  await f.page.start(); assertMain(f);
  assert.equal(f.elements['map-warehouses'].disabled, true); assert.equal(f.warehouseRequests.length, 0);
  f.warehouseReplies.push(response(200, { warehouses: [warehouse()] }));
  release(modules); await settle();
  assert.equal(f.elements['map-warehouses'].disabled, false);
  assert.equal(f.warehouseRequests.at(-1).url, '/api/warehouses?district=mock');
  assert.equal(f.markers.length, 1);
});
test('FIX-AC1: map source has no static warehouse imports', async () => {
  const source = await readFile(new URL('../../web/map.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import\s+[^;]*?from\s*['"]\.\/warehouse-/);
});


for (const [name, capabilityReply] of [
  ['readonly', response(200, { warehouse_write: false })],
  ['network error', new Error('mock failure')],
  ['500', response(500, { warehouse_write: true })],
  ['non-JSON', { ok: true, json: async () => { throw new SyntaxError('mock HTML'); } }],
  ['non-boolean', response(200, { warehouse_write: 'true' })],
]) test('T4 capabilities ' + name + ' keeps markers and popup without management panel', async () => {
  const f = await mainFixture({ capabilityReply });
  f.warehouseReplies.push(response(200, { warehouses: [warehouse()] }));
  await f.page.start(); await settle(); assertMain(f);
  assert.equal(f.elements['map-warehouses'].hidden, true);
  assert.equal(f.elements['map-warehouses'].disabled, true);
  assert.equal(f.doc.body.children.length, 0);
  assert.equal(f.elements['map-warehouse-message'].textContent, '');
  assert.equal(f.markers.length, 1);
  assert.match(text(f.markers[0].popup), /Mock Warehouse.*Mock Address/);
});

test('T4 writable capabilities reveal management entry and open panel with markers', async () => {
  const f = await mainFixture(); f.warehouseReplies.push(response(200, { warehouses: [warehouse()] }));
  await f.page.start(); await settle(); assertMain(f);
  assert.equal(f.markers.length, 1); assert.match(text(f.markers[0].popup), /Mock Warehouse/);
  assert.equal(f.elements['map-warehouses'].hidden, false); assert.equal(f.elements['map-warehouses'].disabled, false);
  await f.elements['map-warehouses'].listeners.click(); assert.equal(f.doc.body.children[0].open, true);
});

test('T4 hanging capabilities never blocks main map or warehouse markers', async () => {
  const f = await mainFixture({ capabilityReply: () => new Promise(() => {}) });
  f.warehouseReplies.push(response(200, { warehouses: [warehouse()] }));
  await f.page.start(); await settle(); assertMain(f);
  assert.equal(f.markers.length, 1); assert.equal(f.elements['map-warehouses'].hidden, true);
});

test('T4 HTML hides management entry before initialization', async () => {
  const html = await readFile(new URL('../../web/map.html', import.meta.url), 'utf8');
  assert.match(html, /<button[^>]*id="map-warehouses"[^>]*\bhidden\b/);
});
