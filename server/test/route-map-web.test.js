import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { polygonStyle, selectRoute, POLYGON_STYLE, hoverStyle, uncoveredZipStyle, vividRouteColor } from '../../web/map-state.js';
import { MAP_RENDER, basemaps, createMapView, ROUTE_LABEL } from '../../web/map-view.js';
import { routeColor, palette } from '../../web/route-colors.js';
import { buildRouteMap, lookupZip } from '../src/route-map/route-map.js';
import { profiles, boundaries } from './route-map-fixtures.js';

test('route colors are stable FNV-1a palette values independent of input order', () => {
  const ids = [1, 2, 99, null, 'Mock route', 10001];
  const result = new Map(ids.map(id => [id, routeColor(id)]));
  for (const id of ids.toReversed()) {
    assert.equal(routeColor(id), result.get(id)); assert.ok(palette.includes(routeColor(id)));
  }
  assert.equal(routeColor(99), routeColor('99'));
  assert.equal(routeColor(''), palette[0x811c9dc5 % palette.length]);
  assert.equal(routeColor('a'), palette[0xe40c292c % palette.length]);
});

test('unified ZIP search renders five distinct statuses, selection rows and real geometry highlights', async () => {
  const { elements: e, page, replies, reply, groups, map } = await fixture();
  const data = profiles(); data.stations.MOCKA.rows[1].postal_codes = ['00002'];
  const boundary = boundaries(); boundary.inScope = zip => ['00002', '00004', '00009', '00123', '00024'].includes(zip);
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, buildRouteMap({ profiles: data, station: 'MOCKA', boundaries: boundary })));
  await page.start();
  assert.equal(e['map-search'].placeholder, '搜索线路或邮编');
  for (const [postalCode, status, badge] of [['00002', 'covered', '有线路覆盖'], ['00004', 'covered_no_boundary', '有线路覆盖'],
    ['00123', 'uncovered', '当前无线路覆盖'], ['00024', 'no_boundary', '暂无可用边界数据'], ['10001', 'out_of_range', '不在支持范围内']]) {
    const result = lookupZip({ profiles: data, boundaries: boundary, postalCode });
    replies.push(reply(200, result)); const beforeFits = map.fits.length;
    e['map-search'].value = postalCode; await e['map-search'].listeners.input();
    const current = e['map-selection'].children[0];
    assert.equal(current.children[0].textContent, postalCode);
    assert.equal(current.children[1].textContent, badge);
    assert.equal(e['map-zip-panel'].hidden, false);
    assert.equal(e['map-summary-panel'].hidden, !status.startsWith('covered'));
    assert.equal(map.fits.length, beforeFits + (result.geometry ? 1 : 0));
    if (result.geometry) {
      const highlighted = groups.filter(group => !group.options.pane).at(-2); // Last group is the geometry used solely to compute fit bounds.
      assert.equal(highlighted.front, true);
      assert.equal(highlighted.layers[0].styles[0].weight, status === 'uncovered' ? uncoveredZipStyle().weight : POLYGON_STYLE.selectedZip.weight);
      assert.equal(highlighted.layers[0].styles[0].color, '#334155');
      if (status === 'uncovered') {
        assert.equal(highlighted.layers[0].styles[0].dashArray, '8 6');
        assert.equal(groups[0].layers[0].styles.at(-1).fillOpacity, POLYGON_STYLE.focused.fillOpacity);
      }
    }
    if (status === 'no_boundary') assert.match(allText(e['map-selection']), /暂无可用边界数据/);
    if (status === 'covered_no_boundary') assert.match(allText(e['map-selection']), /有线路覆盖.*暂无可用边界数据/);
  }
  e['map-search'].value = '023'; await e['map-search'].listeners.input();
  assert.equal(e['map-search-hint'].hidden, false);
  e['map-search'].value = '00009';
  replies.push(reply(200, lookupZip({ profiles: data, boundaries: boundary, postalCode: '00009' })));
  await e['map-search'].listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(e['map-station'].value, 'MOCKA'); assert.equal(e['map-search'].value, '00009');
  assert.equal(e['map-summary'].children[0].textContent, 'Mock-C');
  // An owned ZIP without geometry leaves the viewport and selected Station unchanged.
  data.stations.MOCKA.rows[0].postal_codes.push('00024');
  const beforeFits = map.fits.length;
  replies.push(reply(200, lookupZip({ profiles: data, boundaries: boundary, postalCode: '00024' })));
  await page.searchQuery('00024', true);
  assert.equal(e['map-station'].value, 'MOCKA');
  assert.equal(map.fits.length, beforeFits);
  assert.match(allText(e['map-selection']), /暂无可用边界数据/);
});

test('ZIP errors are separate from no-boundary results and stale replies cannot replace newer choices', async () => {
  const { elements: e, page, replies, reply, doc } = await fixture();
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, payload())); await page.start();
  for (const failure of [reply(500, { error: 'boundary_invalid' }), new Error('private secret')]) {
    replies.push(failure); await page.searchQuery('00002', true);
    assert.equal(e['map-search-message'].className, 'map-error');
    assert.equal(e['map-search-message'].attributes.role, 'alert');
    assert.match(e['map-search-message'].textContent, /boundary_invalid|network_error/);
    assert.doesNotMatch(e['map-search-message'].textContent, /暂无|private|secret/);
    assert.equal(e['map-zip-panel'].hidden, true);
  }
  for (const action of ['clear', 'input', 'route', 'station', 'new-search']) {
    let release;
    replies.push(() => new Promise(resolve => { release = resolve; }));
    const pending = page.searchQuery('00002', false);
    if (action === 'clear') doc.listeners.keydown({ key: 'Escape' });
    if (action === 'input') await page.searchQuery('Mock', false);
    if (action === 'route') e['map-routes'].children[0].listeners.click();
    if (action === 'station') {
      replies.push(reply(200, payload())); await page.loadStation();
    }
    if (action === 'new-search') {
      replies.push(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '10001' })));
      await page.searchQuery('10001', true);
    }
    release(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00002' }))); await pending;
    const current = e['map-selection'].children[0]?.children[0].textContent ?? '—';
    assert.equal(current, action === 'new-search' ? '10001' : '—');
  }
});

export class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.textContent = ''; this.listeners = {}; this.attributes = {}; this.style = {}; }
  append(...children) {
    for (const child of children) {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(node => node !== child);
      child.parentNode = this; this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

export async function fixture(search = '', basemapStatus = 206, storage = null, warehouseOptions = {}) {
  const { createMapPage } = await import('../../web/map.js');
  const warehouseModules = await Promise.all([import('../../web/warehouse-layer.js'), import('../../web/warehouse-panel.js')]);
  const ids = ['route-map', ...['district', 'station', 'dsp', 'message', 'retry', 'content', 'selection', 'coverage',
    'missing', 'missing-empty', 'regenerate', 'source', 'updated', 'search', 'routes', 'no-match', 'clear', 'summary', 'zip-panel', 'coverage-count', 'missing-details', 'missing-title', 'basemap-message', 'zip-heading', 'summary-heading', 'search-hint', 'search-message', 'summary-panel', 'conflicts-details', 'conflicts-title', 'conflicts'].map(id => `map-${id}`)];
  ids.push('map-warehouses', 'map-warehouse-message', 'map-warehouse-notice');
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const doc = { querySelectorAll: () => [], listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, getElementById: id => elements[id], createElement: tag => new Element(tag) };
  elements['route-map'].getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });
  elements['route-map'].querySelectorAll = () => [];
  doc.body = new Element('body');
  const map = { panes: {}, createPane(name) { const values = new Set(); return this.panes[name] = { style: {}, classList: { add: name => values.add(name), remove: name => values.delete(name), contains: name => values.has(name) } }; }, listeners: {}, fits: [], removed: [], attributionControl: {
    setPrefix(value) { this.prefix = value; }, addAttribution(value) { this.text = value; },
  }, setView() {}, on(name, fn) { this.listeners[name] = fn; }, removeLayer(layer) { this.removed.push(layer); },
  fitBounds(bounds, options) { this.fits.push({ bounds, options }); } };
  map.zoom = 11;
  map.getZoom = () => map.zoom;
  map.getContainer = () => elements['route-map'];
  map.projections = 0;
  map.latLngToContainerPoint = ([lat, lng]) => { map.projections++; return { x: 200 + lng * 10, y: 200 + lat * 10 }; };
  const groups = [];
  const controls = [], baselayers = [], renderers = [];
  const leaflet = { svg: options => { const renderer = { options }; renderers.push(renderer); return renderer; }, control: () => ({ addTo() { controls.push(this.onAdd()); } }),
    featureGroup: layers => ({ getBounds: () => ({ isValid: () => layers.length > 0 }) }),
    map: (element, options) => { map.options = options; return map; }, DomEvent: { disableClickPropagation() {}, stopPropagation(event) { event.stopped = true; } },
    geoJSON(features, options = {}) {
      if (features.type === 'Feature') features = { type: 'FeatureCollection', features: [features] };
      const group = { options, layers: [], addTo() { return this; },
        bringToFront() { this.front = true; }, getBounds: () => ({ isValid: () => features.features.length > 0 }) };
      for (const feature of features.features) {
        const layer = { feature, options: { ...options }, styles: [options.style?.(feature)],
          setStyle(value) { this.styles.push(value); },
          bindTooltip(value, options) { this.tooltip = value; this.tooltipOptions = options; },
          on(listeners) { this.listeners = listeners; } };
        options.onEachFeature?.(feature, layer); group.layers.push(layer);
      }
      groups.push(group); return group;
    } };
  leaflet.control.zoom = options => ({ addTo() { map.zoomTitles = options; } });
  let initialCapabilities = true;
  const requests = [], replies = [], warehouseRequests = [], warehouseReplies = [], markers = [], routeMarkers = [];
  map.flyTo = (point, zoom) => { map.flight = { point, zoom }; };
  leaflet.divIcon = options => ({ ...options, createIcon: () => new Element() });
  leaflet.marker = (point, options) => {
    const node = new Element();
    node.className = options.icon.className + ' leaflet-marker-icon leaflet-zoom-animated';
    const classes = () => new Set(node.className.split(/\s+/));
    node.classList = {
      add(name) { const values = classes(); values.add(name); node.className = [...values].join(' '); },
      remove(name) { const values = classes(); values.delete(name); node.className = [...values].join(' '); },
      contains: name => classes().has(name),
      toggle(name, enabled) { this[enabled ? 'add' : 'remove'](name); },
    };
    const marker = { point, options, node, bindPopup(value) { this.popup = value; return this; },
      addTo() { (options.pane === 'route-labels' ? routeMarkers : markers).push(this); return this; }, getLatLng: () => point, getElement: () => node,
      openPopup() { this.popupOpen = true; } };
    return marker;
  };
  const page = createMapPage({ document: doc, leaflet, search, storage,
    loadWarehouseModules: () => Promise.resolve(warehouseModules), ...warehouseOptions, protomaps: {
    PmtilesSource: class { constructor(url) { this.p = { url, getZxy: async () => { throw new Error('mock archive unavailable'); } }; } },
    leafletLayer(options) {
    const layer = { options, on(name, fn) { this.error = fn; }, addTo() { baselayers.push(this); return this; } }; return layer;
  } }, fetch: async (url, options) => {
    if (url.startsWith('/basemap/')) return { status: basemapStatus, arrayBuffer: async () => Uint8Array.from([80,77,84,105,108,101,115,3]).buffer };
    if (url === '/api/capabilities' && initialCapabilities) {
      initialCapabilities = false;
      const reply = warehouseOptions.capabilityReply;
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply() : reply ?? { ok: true, status: 200, json: async () => ({ warehouse_write: true }) };
    }
    if (url.startsWith('/api/warehouses') || url === '/api/capabilities') {
      warehouseRequests.push({ url, options });
      const response = warehouseReplies.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response() : response || { ok: true, status: 200, json: async () => url === '/api/capabilities' ? { warehouse_write: true } : { warehouses: [] } };
    }
    requests.push({ url, options });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  } });
  const reply = (status, data) => ({ status, json: async () => {
    if (data?.stations && !data.routes && typeof data.stations[0] !== 'object') return { districts: [{ id: 'mock', name_zh: '测试片区', name_en: 'Mock District', stations: data.stations.map(code => ({ code, has_snapshot: true })) }] };
    if (data?.routes && !data.stations) return { ...data, routes: data.routes.map(route => ({ ...route, station: data.station })), district: 'mock', stations: [{ code: data.station, fetched_at: data.fetched_at, route_count: data.routes.length }], missing: data.missing.map(row => ({ ...row, station: data.station })) };
    return data;
  } });
  await page.basemapReady;
  return { doc, leaflet, controls, baselayers, renderers, elements, map, groups, page, requests, replies, reply, warehouseRequests, warehouseReplies, markers, routeMarkers };
}
const payload = () => buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() });

test('MS-T2b Map restores manual preference without saving startup or automatic ZIP switches', async () => {
  let saved = JSON.stringify({ district: 'mock', station: 'MOCKB' }); const writes = [];
  const storage = { getItem: key => key === 'nc-ops-console.selection' ? saved : null, setItem: (key, value) => { if (key === 'nc-ops-console.selection') saved = value; writes.push([key, value]); } };
  const { elements: e, page, replies, reply } = await fixture('', 206, storage);
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, payload()));
  await page.start(); assert.equal(e['map-station'].value, 'MOCKB'); assert.deepEqual(writes, []);
  e['map-station'].value = 'MOCKA'; replies.push(reply(200, payload()));
  await e['map-station'].listeners.change();
  assert.deepEqual(writes, [['nc-ops-console.selection', JSON.stringify({ district: 'mock', station: 'MOCKA' })], ['nc-ops-console.map-scope', 'station']]);
  replies.push(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00009' })));
  await page.searchQuery('00009', true);
  assert.equal(e['map-station'].value, 'MOCKA'); assert.equal(JSON.parse(saved).station, 'MOCKA'); assert.equal(writes.length, 2);
  const restored = await fixture('', 206, storage);
  restored.replies.push(restored.reply(200, { stations: ['MOCKB', 'MOCKA'] }), restored.reply(200, payload()));
  await restored.page.start(); assert.equal(restored.elements['map-station'].value, 'MOCKA');
});

test('map DOM uses API coverage and missing rows, safe tooltip elements and persistent click selection', async () => {
  const { elements: e, page, map, groups, requests, replies, reply } = await fixture('?station=MOCKA', 206, { getItem: key => key === 'nc-ops-console.map-scope' ? 'district' : null });
  const data = payload(), malicious = '<img src=x onerror=alert(1)>';
  data.features.features.forEach(feature => feature.properties.route_name = malicious);
  data.missing[0].route_name = malicious;
  // Deliberately differ from the feature count: the UI must use API counts, not recompute them.
  data.coverage = { total: 269, mapped: 254, missing: 15, missing_no_zcta: 14, missing_not_checked: 1 };
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, data));
  await page.start();
  assert.equal(e['map-station'].value, ''); assert.equal(e['map-station'].disabled, false);
  assert.deepEqual(requests.map(item => item.url), ['/api/districts', '/api/route-map/district?district=mock']);
  assert.ok(requests.every(item => item.options.cache === 'no-store'));
  assert.equal(e['map-coverage'].textContent, '94.42%');
  assert.equal(e['map-regenerate'].textContent, '14 无 Census ZCTA · 1 需重新生成边界');
  assert.equal(e['map-regenerate'].hidden, false);
  assert.equal(e['map-missing'].children.length, data.missing.length);
  assert.deepEqual(e['map-missing'].children.map(row => row.children.map(cell => cell.textContent)), [
    ['00004', 'MOCKA', malicious, '无 Census ZCTA'], ['00005', 'MOCKA', 'Mock-B', '边界数据未覆盖（需重新生成）'],
  ]);
  assert.equal(map.fits.length, 1);
  assert.equal(map.attributionControl.prefix, undefined);
  assert.equal(map.attributionControl.text, 'Boundaries: US Census 2020 ZCTA');
  const [layer, sameRoute] = groups[0].layers;
  assert.ok(layer.tooltip instanceof Element);
  assert.deepEqual(layer.tooltipOptions, { direction: 'auto', sticky: true });
  assert.equal(layer.tooltip.children[1].children[1].textContent, malicious);
  assert.equal(layer.styles[0].fillColor, vividRouteColor(routeColor(layer.feature.properties.route_id)));
  assert.equal(layer.options.bubblingMouseEvents, false);
  layer.listeners.mouseover(); assert.equal(layer.styles.at(-1).weight, POLYGON_STYLE.hover.weight);
  layer.listeners.mouseout(); assert.equal(layer.styles.at(-1).weight, POLYGON_STYLE.normal.weight);
  const originalEvent = {}; layer.listeners.click({ originalEvent });
  assert.equal(originalEvent.stopped, true);
  const panel = e['map-selection'].children[0];
  assert.equal(panel.children[0].textContent, '00002');
  assert.match(allText(e['map-selection']), /有线路覆盖/);
  assert.equal(sameRoute.styles.at(-1).weight, POLYGON_STYLE.selectedRoute.weight);
  map.listeners.click();
  assert.equal(e['map-zip-panel'].hidden, true);
  assert.equal(layer.styles.at(-1).weight, POLYGON_STYLE.normal.weight);
  replies.push(reply(200, { ...payload(), station: 'MOCKB' })); e['map-station'].value = 'MOCKB';
  await e['map-station'].listeners.change();
  assert.equal(requests.at(-1).url, '/api/route-map/district?district=mock');
  assert.equal(map.removed.filter(layer => layer.options?.pane !== 'route-labels').length, 6);
  assert.equal(map.removed.filter(layer => layer.options?.pane === 'route-labels').length, 1);
});

test('map page loading, no data, known errors, retries and network failures clear stale data', async () => {
  const { elements: e, page, groups, map, replies, reply } = await fixture('?station=UNKNOWN');
  let release;
  replies.push(() => new Promise(resolve => { release = () => resolve(reply(200, { stations: ['MOCKA'] })); }), reply(200, payload()));
  const pending = page.start();
  assert.equal(e['map-content'].attributes['aria-busy'], 'true');
  assert.equal(e['map-message'].textContent, '正在加载站点…');
  release(); await pending;
  assert.equal(e['map-station'].value, 'MOCKA');
  assert.equal(e['map-content'].attributes['aria-busy'], 'false');
  for (const [status, code] of [[404, 'snapshot_not_found'], [404, 'station_not_found'],
    [409, 'postal_codes_missing'], [500, 'route_zip_conflict'], [500, 'boundary_invalid'],
    [500, 'boundary_not_found'], [500, 'snapshot_invalid'], [400, 'invalid_station'], [500, 'C:/private/path stack']]) {
    replies.push(reply(status, { error: code })); await page.loadStation();
    assert.equal(e['map-retry'].hidden, false);
    assert.equal(e['map-coverage'].textContent, '—');
    assert.equal(e['map-missing'].children.length, 0);
    assert.doesNotMatch(e['map-message'].textContent, /private|stack/);
    if (code === 'postal_codes_missing') assert.match(e['map-message'].textContent, /npm run dms:scrape -- --station MOCKA/);
    if (status === 404) assert.match(e['map-message'].textContent, /暂无数据/);
  }
  replies.push(new Error('private-path')); await page.loadStation();
  assert.match(e['map-message'].textContent, /本地服务器/);
  replies.push({ status: 200, json: async () => { throw new Error('private'); } }); await page.loadStation();
  assert.doesNotMatch(e['map-message'].textContent, /private/);
  const empty = payload(); empty.features.features = []; empty.missing = []; empty.routes = [];
  empty.coverage = { total: 0, mapped: 0, missing: 0, missing_no_zcta: 0, missing_not_checked: 0 };
  replies.push(reply(200, empty)); await e['map-retry'].listeners.click();
  assert.equal(e['map-missing-empty'].hidden, false);
  assert.equal(e['map-regenerate'].className, '');
  assert.match(e['map-message'].textContent, /暂无数据/);
  assert.equal(groups.at(-1).layers.length, 0); assert.equal(map.fits.length, 1);
});

test('map Station loading handles absent snapshots, empty list and retry', async () => {
  const { elements: e, page, replies, reply } = await fixture();
  replies.push(reply(404, { error: 'snapshot_not_found' })); await page.start();
  assert.match(e['map-message'].textContent, /暂无数据/); assert.equal(e['map-station'].disabled, true);
  const empty = payload(); empty.features.features = []; empty.routes = []; empty.missing = []; empty.coverage = { total: 0, mapped: 0, missing: 0, missing_no_zcta: 0, missing_not_checked: 0 };
  replies.push(reply(200, { stations: [] }), reply(200, empty)); await e['map-retry'].listeners.click();
  assert.match(e['map-message'].textContent, /暂无数据/);
  replies.push(new Error('secret')); await page.start();
  assert.match(e['map-message'].textContent, /本地服务器/);
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, payload())); await page.start();
  assert.equal(e['map-retry'].hidden, true);
});

test('rapid Station changes ignore stale success and error responses', async () => {
  const { elements: e, page, replies, reply } = await fixture();
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, payload())); await page.start();
  for (const stale of [reply(200, payload()), reply(500, { error: 'boundary_invalid' })]) {
    let release;
    replies.push(() => new Promise(resolve => { release = () => resolve(stale); }));
    const pending = page.loadStation(); e['map-station'].value = 'MOCKB';
    replies.push(reply(200, { ...payload(), station: 'MOCKB' })); await page.loadStation();
    release(); await pending;
    assert.equal(e['map-message'].textContent, 'MOCKB 线路地图已加载。');
  }
});

test('web sources contain no external resource URLs or HTML injection and map uses local modules', async () => {
  const dir = new URL('../../web/', import.meta.url);
  for (const filename of await fs.readdir(dir)) {
    const source = await fs.readFile(new URL(filename, dir), 'utf8');
    assert.doesNotMatch(source, /innerHTML|https?:\/\//, filename);
  }
  const html = await fs.readFile(new URL('map.html', dir), 'utf8');
  assert.doesNotMatch(html, /style=|<style|<script(?![^>]*src=)/);
  assert.match(html, /<script type="module" src="\/map.js">/);
  const js = await fs.readFile(new URL('map.js', dir), 'utf8');
  assert.match(js, /leaflet = globalThis.L/);
  assert.match(html, /src="\/vendor\/leaflet\/leaflet.js"/);
  assert.match(html, /src="\/vendor\/protomaps-leaflet\/protomaps-leaflet.js"/);
  assert.doesNotMatch(js, /tileLayer|\bpostal_codes\b|validatePostalCodes/);
  const css = await fs.readFile(new URL('styles.css', dir), 'utf8');
  assert.match(css, /@media \(max-width: 750px\)/);
  assert.match(css, /\.map-missing \{ min-width: 0;/);
});

test('RM2 search, list selection, summary, clearing, Fit Station and basemap setup', async () => {
  const { elements: e, page, map, groups, replies, reply, doc, controls, baselayers } = await fixture();
  const data = payload();
  Object.assign(data.routes[0], { dsp_name: 'Mock DSP', pickup_volume: 12345, pph: 12.345 });
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, data)); await page.start();
  assert.equal(e['map-missing-details'].open, false);
  assert.equal(map.options.minZoom, 3); assert.equal(map.options.maxZoom, 16);
  assert.equal(map.options.maxBounds, undefined);
  assert.deepEqual(map.zoomTitles, { zoomInTitle: '放大', zoomOutTitle: '缩小' });
  assert.equal(e['map-missing-title'].textContent, '缺少边界的邮编 (2)');
  assert.deepEqual(baselayers.map(layer => layer.options.maxDataZoom), [6, 10, 10, 14]);
  assert.ok(baselayers.every(layer => layer.options.flavor === 'light'));
  assert.deepEqual(baselayers.map(layer => layer.options.url.url), ['/basemap/us.pmtiles', '/basemap/norcal.pmtiles', '/basemap/mountain.pmtiles', '/basemap/ops.pmtiles']);
  assert.equal(baselayers[0].options.bounds, undefined);
  assert.deepEqual(baselayers[1].options.bounds, [[35.5, -124.6], [42.5, -119.0]]);
  assert.deepEqual(baselayers[2].options.bounds, [[34.0, -116.5], [47.0, -103.0]]);
  assert.deepEqual(baselayers[3].options.bounds, [[36.43, -123.16], [39.01, -121.06]]);
  const search = e['map-search']; search.value = ' mock-a '; search.listeners.input();
  assert.equal(e['map-routes'].children.length, 1);
  search.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(map.fits.length, 2);
  assert.equal(e['map-routes'].children[0].attributes['aria-pressed'], 'true');
  const summary = e['map-summary'].children;
  assert.equal(summary[0].textContent, 'Mock-A'); assert.equal(summary[0].className, 'map-route-name');
  assert.equal(summary[1].textContent, '站点 MOCKA · DSP Mock DSP');
  const values = Object.fromEntries(summary[2].children.map(row => row.children.slice(0, 2).map(node => node.textContent)));
  assert.equal(values['ZIP 数'], '2'); assert.equal(summary[2].children[0].children[2].textContent, '已上图 2');
  assert.equal(values['Pickup Volume'], '12,345'); assert.equal(values.PPH, '12.35');
  assert.match(summary[3].textContent, /^更新时间 /);
  assert.equal(e['map-zip-panel'].hidden, true);
  controls[0].children[0].listeners.click(); assert.equal(map.fits.length, 3);
  assert.equal(e['map-routes'].children[0].attributes['aria-pressed'], 'true');
  doc.listeners.keydown({ key: 'Escape' }); assert.equal(e['map-clear'].disabled, true);
  search.value = 'mock'; search.listeners.input();
  search.listeners.keydown({ key: 'Enter', preventDefault() {} }); assert.equal(map.fits.length, 3);
  e['map-routes'].children[1].listeners.click();
  assert.equal(map.fits.length, 3); // Route B has no mapped polygons.
  assert.match(e['map-summary'].children[3].textContent, /暂无已上图边界/);
  assert.equal(e['map-summary'].children[2].children[1].children[1].textContent, '—');
  e['map-clear'].listeners.click(); assert.equal(e['map-clear'].disabled, true);
  groups[0].layers[0].listeners.click({}); assert.equal(e['map-zip-panel'].hidden, false);
  e['map-clear'].listeners.click(); assert.equal(e['map-zip-panel'].hidden, true);
  search.value = 'does not exist'; search.listeners.input(); assert.equal(e['map-no-match'].hidden, false);
  baselayers[0].error(); assert.match(e['map-basemap-message'].textContent, /底图尚未安装/);
  assert.equal(await baselayers[0].options.url.getZxy(1, 1, 1), undefined);
  assert.equal(groups[0].layers.length, 2);
});

test('RM2 missing basemap archives show a hint without blocking route polygons', async () => {
  const { elements: e, page, groups, replies, reply, baselayers } = await fixture('', 404);
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, payload())); await page.start();
  assert.equal(baselayers.length, 0);
  assert.equal(e['map-basemap-message'].hidden, false);
  assert.match(e['map-basemap-message'].textContent, /底图尚未安装/);
  assert.equal(groups[0].layers.length, 2);
  groups[0].layers[0].listeners.click({}); assert.equal(e['map-zip-panel'].hidden, false);
});

test('RM2 Enter prefers exact matches over multiple results, then accepts a unique substring', async () => {
  const { elements: e, page, replies, reply } = await fixture();
  const data = payload();
  data.routes.push({ ...data.routes[0], route_id: 99, route_name: 'Mock-A Extra', mapped_count: 0 });
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, data)); await page.start();
  const search = e['map-search']; search.value = ' MOCK-a '; search.listeners.input();
  assert.equal(e['map-routes'].children.length, 2);
  search.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(e['map-summary'].children[0].textContent, 'Mock-A');
  search.value = 'ock-b'; search.listeners.input();
  search.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(e['map-summary'].children[0].textContent, 'Mock-B');
});

const allNodes = node => [node, ...node.children.flatMap(allNodes)];
const allText = node => allNodes(node).map(node => node.textContent).join(' ');

test('RM5b outlines stack dark/white route and ZIP strokes, pass events through and leave no stale layers', async () => {
  const { page, controls, elements: e, groups, map, requests, replies, reply, doc } = await fixture();
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, payload())); await page.start();
  const active = () => groups.filter(group => group.options.pane === 'selection-outline' && !map.removed.includes(group));
  const check = (group, color, weight, dashArray = null) => {
    assert.equal(group.options.pane, 'selection-outline');
    for (const layer of group.layers) {
      assert.deepEqual(layer.styles[0], { fill: false, interactive: false, bubblingMouseEvents: false,
        opacity: 1, color, weight, dashArray });
      assert.equal(layer.options.interactive, false); assert.equal(layer.options.bubblingMouseEvents, false);
      assert.equal(layer.listeners, undefined);
    }
  };
  assert.deepEqual(map.panes['selection-outline'].style, { zIndex: '450', pointerEvents: 'none' });
  assert.equal(active().length, 0);
  e['map-routes'].children[0].listeners.click();
  assert.equal(active().length, 2);
  assert.deepEqual(active()[0].layers.map(layer => layer.feature.properties.postal_code), ['00002', '00123']);
  check(active()[0], '#0b1220', 3.5); check(active()[1], '#ffffff', 1.5);
  groups[0].layers[0].listeners.click({});
  assert.equal(active().length, 4);
  assert.deepEqual(active()[0].layers.map(layer => layer.feature.properties.postal_code), ['00123']);
  check(active()[0], '#0b1220', 3.5); check(active()[1], '#ffffff', 1.5);
  check(active()[2], '#0b1220', 5); check(active()[3], '#ffffff', 3);
  assert.deepEqual(active()[2].layers[0].feature.geometry, groups[0].layers[0].feature.geometry);
  const before = active(), fits = map.fits.length, calls = requests.length;
  for (const mode of [1, 0, 1]) controls[1].children[mode].listeners.click();
  assert.deepEqual(active(), before); assert.equal(map.fits.length, fits); assert.equal(requests.length, calls);
  const polygon = groups[0].layers[0], baseStyle = polygon.styles.at(-1); polygon.listeners.mouseover();
  assert.deepEqual(polygon.styles.at(-1), hoverStyle(baseStyle));
  polygon.listeners.mouseout(); assert.equal(polygon.styles.at(-1).color, '#334155');
  doc.listeners.keydown({ key: 'Escape' }); assert.equal(active().length, 0);
  e['map-routes'].children[0].listeners.click();
  e['map-station'].value = 'MOCKB'; replies.push(reply(200, { ...payload(), station: 'MOCKB' }));
  await e['map-station'].listeners.change(); assert.equal(active().length, 0);
  const uncoveredProfiles = profiles(); uncoveredProfiles.stations.MOCKA.rows.find(row => row.route_id === 1).postal_codes = ['00002'];
  replies.push(reply(200, lookupZip({ profiles: uncoveredProfiles, boundaries: boundaries(), postalCode: '00123' })));
  await page.searchQuery('00123', true);
  assert.equal(active().length, 2); check(active()[0], '#0b1220', 5); check(active()[1], '#ffffff', 3, '8 6');
  const fill = groups.filter(group => !group.options.pane && group.layers[0]?.styles[0]).at(-1).layers[0].styles[0];
  assert.equal(fill.fillColor, '#db2777'); assert.equal(fill.fillOpacity, 0.15);
  controls[1].children[0].listeners.click(); assert.equal(active().length, 2);
  e['map-clear'].listeners.click(); assert.equal(active().length, 0);
});

test('RM5 mode controls and legend preserve selection, bounds, layer identity and requests', async () => {
  const { page, controls, elements: e, groups, map, requests, replies, reply, doc } = await fixture();
  const { details } = await import('./route-map-fixtures.js');
  const { difficultyColor } = await import('../../web/difficulty.js');
  const source = profiles(); source.stations.MOCKA.rows.find(row => row.route_id === 1).route_difficulty = 'B级 中';
  source.stations.MOCKA.rows.find(row => row.route_id === 2).route_difficulty = 'D级 极易';
  const data = buildRouteMap({ profiles: source, boundaries: boundaries(), station: 'MOCKA', details: details() });
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, data)); await page.start();
  const mode = controls[1], legend = controls[2];
  assert.equal(mode.attributes.role, 'group'); assert.equal(mode.attributes['aria-label'], '地图颜色模式');
  assert.deepEqual(mode.children.map(node => node.textContent), ['按线路', '按难易度']);
  assert.ok(mode.children.every(button => button.type === 'button')); // Native buttons support Enter and Space.
  assert.deepEqual(mode.children.map(node => node.attributes['aria-pressed']), ['true', 'false']);
  assert.equal(legend.hidden, true);
  const fits = map.fits.length, calls = requests.length, count = groups.length;
  mode.children[1].listeners.click();
  assert.equal(legend.hidden, false); assert.equal(legend.children[0].textContent, '颜色：线路难度');
  assert.deepEqual(legend.children.slice(1).map(row => row.children[1].textContent), ['S 极难', 'A 难', 'B 中', 'C 易', 'D 极易', '无数据']);
  assert.deepEqual(legend.children.slice(1).map(row => row.children[0].style.backgroundColor), ['S', 'A', 'B', 'C', 'D', null].map(difficultyColor));
  assert.equal(groups[0].layers[0].styles.at(-1).fillColor, difficultyColor('B'));
  assert.equal(groups[0].layers[0].tooltip.children.length, 3);
  assert.deepEqual(e['map-routes'].children.map(row => row.children[2].textContent), ['B', 'D']);
  assert.deepEqual(e['map-routes'].children.map(row => row.children[0].style.backgroundColor), [difficultyColor('B'), difficultyColor('D')]);
  assert.equal(map.fits.length, fits); assert.equal(requests.length, calls); assert.equal(groups.length, count);
  groups[0].layers[0].listeners.click({});
  const selected = allText(e['map-selection']), selectedFits = map.fits.length, selectedGroups = groups.length;
  assert.equal(legend.children[0].textContent, '颜色：Mock-A 的 ZIP 难度');
  assert.equal(groups[0].layers[0].styles.at(-1).fillColor, difficultyColor('A'));
  assert.equal(groups[0].layers[1].styles.at(-1).fillColor, difficultyColor(null));
  assert.equal(groups[0].layers[1].tooltip.children.length, 3);
  assert.match(allText(e['map-summary']), /已有 1 个 ZIP/); // Cache row count, not profile ZIP count.
  assert.match(allText(e['map-selection']), /ZIP 难度 A级 难/);
  const highlight = groups.filter(group => !group.options.pane).at(-1).layers[0];
  assert.equal(highlight.styles[0].fillColor, difficultyColor('A')); assert.equal(highlight.styles[0].color, '#334155');
  mode.children[0].listeners.click();
  assert.equal(legend.hidden, true);
  assert.equal(highlight.styles.at(-1).fillColor, polygonStyle({route_id: 1}, selectRoute(1)).fillColor);
  assert.equal(highlight.tooltip.children.length, 3);
  mode.children[1].listeners.click();
  assert.equal(allText(e['map-selection']), selected); assert.equal(map.fits.length, selectedFits);
  assert.equal(requests.length, calls); assert.equal(groups.length, selectedGroups);
  assert.deepEqual(mode.children.map(node => node.attributes['aria-pressed']), ['false', 'true']);
  groups[0].layers[0].listeners.mouseover(); assert.equal(groups[0].layers[0].styles.at(-1).color, POLYGON_STYLE.hover.color);
  groups[0].layers[0].listeners.mouseout(); assert.equal(groups[0].layers[0].styles.at(-1).color, POLYGON_STYLE.selectedZip.color);
  doc.listeners.keydown({ key: 'Escape' }); assert.equal(legend.children[0].textContent, '颜色：线路难度');
});

test('RM5 missing, null, absent ZIP and invalid-cache messages do not inherit route difficulty', async () => {
  const { page, controls, elements: e, groups, replies, reply } = await fixture();
  const data = payload(); data.details_status = 'invalid';
  data.routes[0].route_difficulty = 'S级 极难';
  data.features.features.forEach(f => f.properties.route_difficulty = 'S级 极难');
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, data)); await page.start();
  assert.match(e['map-message'].textContent, /线路详情文件无效，ZIP 难度不可用/);
  assert.equal(e['map-message'].className, 'map-warning');
  controls[1].children[1].listeners.click(); e['map-routes'].children[0].listeners.click();
  assert.match(allText(e['map-summary']), /暂无 ZIP 难度数据/);
  assert.doesNotMatch(allText(e['map-summary']), /npm run/);
  assert.ok(groups[0].layers.every(layer => layer.styles.at(-1).fillColor === '#9ca3af'));
  assert.equal(groups[0].layers[0].tooltip.children.length, 3);
  const { details } = await import('./route-map-fixtures.js');
  const cache = details(); cache.routes['1'].zips[0].postal_code_difficulty = null;
  const updated = buildRouteMap({ profiles: profiles(), boundaries: boundaries(), station: 'MOCKA', details: cache });
  replies.push(reply(200, updated)); await page.loadStation();
  assert.doesNotMatch(e['map-message'].textContent, /文件无效/);
  const current = groups.at(-1).layers;
  current[0].listeners.click({});
  assert.equal(current[0].tooltip.children.length, 3);
  assert.equal(e['map-selection'].children[1].children[3].children[1].textContent, '—');
  current[1].listeners.click({});
  assert.equal(e['map-selection'].children[1].children[3].children[1].textContent, '—');
});

test('RM5 ZIP search highlight uses the same difficulty fields as polygon clicks and preserves uncovered styles', async () => {
  const { page, controls, elements: e, groups, replies, reply } = await fixture();
  const { details } = await import('./route-map-fixtures.js');
  const cache = details(), data = buildRouteMap({ profiles: profiles(), boundaries: boundaries(), station: 'MOCKA', details: cache });
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, data)); await page.start();
  const highlightLayer = () => groups.filter(group => !group.options.pane && group.layers[0]?.styles[0]).at(-1).layers[0];
  controls[1].children[1].listeners.click();
  replies.push(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00002', details: cache })));
  await page.searchQuery('00002', true);
  assert.equal(highlightLayer().styles[0].fillColor, '#dc2626');
  assert.equal(highlightLayer().styles[0].color, '#334155');
  assert.match(allText(e['map-selection']), /ZIP 难度 A级 难/);
  // Covered polygon click and the lookup API must agree.
  groups[0].layers[0].listeners.click({});
  assert.equal(highlightLayer().styles[0].fillColor, '#dc2626');
  const uncoveredProfiles = profiles(); uncoveredProfiles.stations.MOCKA.rows.find(row => row.route_id === 1).postal_codes = ['00002'];
  replies.push(reply(200, lookupZip({ profiles: uncoveredProfiles, boundaries: boundaries(), postalCode: '00123', details: cache })));
  await page.searchQuery('00123', true);
  assert.equal(highlightLayer().styles[0].dashArray, '8 6');
  const highlight = highlightLayer(); controls[1].children[0].listeners.click();
  assert.deepEqual(highlight.styles.at(-1), highlight.styles[0]);
});

test('MS-T2 warnings collapse, multi-Station ZIP keeps Station and highlights only ZIP', async () => {
  const { elements: e, page, replies, reply, requests, groups, map } = await fixture('?station=MOCKB');
  const data = profiles(); data.stations.MOCKB.rows[0].postal_codes.push('00002');
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, buildRouteMap({ profiles: data, station: 'MOCKB', boundaries: boundaries() })));
  await page.start();
  assert.equal(e['map-conflicts-details'].hidden, false); assert.equal(e['map-conflicts-details'].open, false);
  assert.match(e['map-conflicts'].children[0].textContent, /00002.*MOCKA.*MOCKB/);
  e['map-conflicts-details'].open = true; assert.equal(e['map-conflicts-details'].open, true);
  const before = requests.length, fits = map.fits.length;
  replies.push(reply(200, lookupZip({ profiles: data, boundaries: boundaries(), postalCode: '00002' })));
  await page.searchQuery('00002', true);
  assert.equal(e['map-station'].value, 'MOCKB'); assert.equal(requests.length, before + 1); assert.equal(map.fits.length, fits + 1);
  assert.equal(e['map-summary-panel'].hidden, true);
  assert.match(allText(e['map-selection'].children[3]), /MOCKA/);
  assert.match(allText(e['map-selection'].children[3]), /MOCKB/);
  const outlines = groups.filter(group => group.options.pane && !map.removed.includes(group));
  assert.equal(outlines.length, 2); assert.ok(outlines.every(group => group.layers.length === 1));
  replies.push(reply(200, payload())); await page.loadStation();
  assert.equal(e['map-conflicts-details'].hidden, true); assert.equal(e['map-conflicts-details'].open, false);
});

test('DS map selectors, grouped overview, Station focus, ZIP search and manual persistence', async () => {
  const values = new Map(), writes = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); writes.push([key, value]); } };
  const { elements: e, page, replies, reply, map, groups, controls, requests } = await fixture('', 206, storage);
  const districts = [{ id: 'mock', name_zh: '测试片区', name_en: 'Mock District', stations: [{ code: 'MOCKA', has_snapshot: true }, { code: 'MOCKB', has_snapshot: true }, { code: 'ABSENT', has_snapshot: false }] }, { id: 'other', name_zh: '其他片区', name_en: 'Other District', stations: [{ code: 'OTHER', has_snapshot: true }] }];
  const { buildDistrictMap } = await import('../src/route-map/route-map.js');
  const data = buildDistrictMap({ profiles: profiles(), districts, district: 'mock', boundaries: boundaries() });
  replies.push(reply(200, { districts }), reply(200, data)); await page.start();
  assert.equal(e['map-district'].children.length, 2); assert.equal(e['map-district'].children[0].title, 'Mock District');
  assert.equal(e['map-station'].children[0].textContent, '全部站点（片区总览）');
  assert.equal(e['map-station'].children[3].disabled, true); assert.equal(writes.length, 0);
  assert.equal(e['map-station'].value, 'MOCKA');
  const initial = groups[0];
  assert.equal(initial.layers.find(layer => layer.feature.properties.station === 'MOCKB').styles[0].fillOpacity, POLYGON_STYLE.dimmed.fillOpacity);
  assert.equal(e['map-coverage-count'].textContent, '2 / 4 ZIP 已上图');
  assert.equal(e['map-missing'].children[0].children[1].textContent, 'MOCKA');
  e['map-station'].value = ''; replies.push(reply(200, data)); await e['map-station'].listeners.change();
  assert.equal(controls[0].children[0].textContent, '定位片区'); assert.equal(values.get('nc-ops-console.map-scope'), 'district');
  assert.equal(JSON.parse(values.get('nc-ops-console.selection')).station, 'MOCKA');
  assert.deepEqual(e['map-routes'].children.filter(node => node.tagName === 'h3').map(node => node.textContent), ['MOCKA', 'MOCKB']);
  assert.equal(e['map-coverage-count'].textContent, '3 / 5 ZIP 已上图');
  const before = writes.length;
  replies.push(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00009' })));
  await page.searchQuery('00009', true); assert.equal(e['map-station'].value, ''); assert.equal(writes.length, before);
  e['map-station'].value = 'MOCKA'; replies.push(reply(200, data)); await e['map-station'].listeners.change();
  assert.equal(controls[0].children[0].textContent, '定位站点');
  e['map-search'].value = 'Mock-C'; await e['map-search'].listeners.input();
  assert.equal(e['map-routes'].children[0].children[1].textContent, 'Mock-C');
  const fits = map.fits.length; const requestCount = requests.length;
  await page.searchQuery('Mock-C', true); assert.equal(map.fits.length, fits + 1); assert.equal(requests.length, requestCount);
  assert.equal(e['map-station'].value, 'MOCKA');
  const active = groups.filter(group => !map.removed.includes(group) && !group.options.pane && group.layers.length > 1).at(-1);
  assert.equal(active.layers.find(layer => layer.feature.properties.station === 'MOCKB').styles.at(-1).fillOpacity, POLYGON_STYLE.selectedRoute.fillOpacity);
  const saved = values.get('nc-ops-console.selection');
  replies.push(reply(200, { ...lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00009' }), station: 'OTHER' }));
  const beforeOutside = map.fits.length; await page.searchQuery('00009', true);
  assert.equal(e['map-search-message'].textContent, '该 ZIP 属于 其他片区/OTHER'); assert.equal(map.fits.length, beforeOutside);
  assert.equal(values.get('nc-ops-console.selection'), saved);
  e['map-district'].value = 'other';
  replies.push(reply(200, { ...data, district: 'other', stations: [], routes: [], missing: [], features: { type: 'FeatureCollection', features: [] }, coverage: { total: 0, mapped: 0, missing: 0, missing_no_zcta: 0, missing_not_checked: 0 } }));
  await e['map-district'].listeners.change(); assert.equal(e['map-station'].value, 'OTHER');
  assert.deepEqual(JSON.parse(values.get('nc-ops-console.selection')), { district: 'other', station: 'OTHER' });
  const restored = await fixture('', 206, storage); restored.replies.push(restored.reply(200, { districts }), restored.reply(200, data));
  await restored.page.start(); assert.equal(restored.elements['map-district'].value, 'other'); assert.equal(restored.elements['map-station'].value, 'OTHER');
});

test('RM6 compact ZIP fields, badges, safe three-row tooltips and shared clear button', async () => {
  const { elements: e, page, replies, reply, groups, controls } = await fixture();
  const { details } = await import('./route-map-fixtures.js');
  const source = profiles(), cache = details();
  source.stations.MOCKA.rows[1].dsp_name = '<Mock DSP>';
  Object.assign(cache.routes['1'].zips[0], { experienced_pph: 0, pickup_volume_daily: 1234 });
  const data = buildRouteMap({ profiles: source, station: 'MOCKA', boundaries: boundaries(), details: cache });
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, data)); await page.start();
  e['map-routes'].children[0].listeners.click();
  assert.equal(e['map-clear'].parentNode, e['map-summary-heading']);
  for (const mode of [0, 1]) {
    controls[1].children[mode].listeners.click();
    const tooltip = groups[0].layers[0].tooltip;
    assert.deepEqual(tooltip.children.map(row => row.children.map(n => n.textContent)), [['ZIP', '00002'], ['线路', 'Mock-A'], ['DSP', '<Mock DSP>']]);
  }
  groups[0].layers[0].listeners.click({});
  assert.equal(e['map-clear'].parentNode, e['map-zip-heading']);
  const nodes = e['map-selection'].children;
  assert.equal(nodes[0].children[0].textContent, '00002');
  assert.deepEqual(nodes[1].children.map(row => row.children.map(n => n.textContent)), [['熟手 PPH', '0.00'], ['领件量（日均）', '1,234'], ['DSP', '<Mock DSP>'], ['ZIP 难度', 'A级 难']]);
  assert.deepEqual(nodes[2].children.map(row => row.children.map(n => n.textContent)), [['站点', 'MOCKA']]);
  assert.equal(nodes[1].children[3].children[1].style.backgroundColor, '#dc2626');
  assert.doesNotMatch(allText(e['map-selection']), /地图已定位|DMS 无数据|该 ZIP 不在线路详情/);
  e['map-clear'].listeners.click(); assert.equal(e['map-zip-panel'].hidden, true); assert.equal(e['map-summary-panel'].hidden, true);
  groups[0].layers[1].listeners.click({});
  assert.equal(e['map-selection'].children[1].children[0].children[1].textContent, '—');
  assert.equal(e['map-selection'].children[1].children[1].children[1].textContent, '—');
  assert.equal(e['map-selection'].children[1].children[3].children[1].textContent, '—');
  const html = await fs.readFile(new URL('../../web/map.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /map-current|当前选择|<style/);
  assert.ok(html.indexOf('id="map-zip-panel"') < html.indexOf('id="map-summary-panel"'));
  assert.equal((html.match(/id="map-clear"/g) || []).length, 1);
});

test('RM7 DSP options, selection table, map clicks, ZIP lookup and session-only state', async () => {
  const writes = [];
  const f = await fixture('', 206, { getItem: () => null, setItem: (...args) => writes.push(args) });
  const { elements: e, page, replies, reply, groups, doc } = f;
  const data = payload();
  data.routes.forEach((r, i) => r.dsp_name = i ? 'Beta' : 'Alpha');
  data.features.features.forEach(feature => feature.properties.dsp_name = data.routes.find(r => r.route_id === feature.properties.route_id).dsp_name);
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, data));
  assert.equal(e['map-dsp'].disabled, true);
  await page.start();
  assert.deepEqual(e['map-dsp'].children.map(o => [o.value, o.textContent]), [['', '全部 DSP'], ['Alpha', 'Alpha'], ['Beta', 'Beta']]);
  assert.equal(e['map-dsp'].value, ''); assert.equal(e['map-dsp'].disabled, false);
  const change = value => { e['map-dsp'].value = value; e['map-dsp'].listeners.change(); };
  change('Alpha'); assert.equal(e['map-routes'].children.length, 1);
  const layer = groups[0].layers[0];
  const owner = layer.feature.properties.dsp_name, other = owner === 'Alpha' ? 'Beta' : 'Alpha';
  change(other); assert.equal(layer.styles.at(-1).fillOpacity, POLYGON_STYLE.dimmed.fillOpacity);
  layer.listeners.mouseover(); layer.listeners.mouseout(); assert.equal(layer.styles.at(-1).fillOpacity, POLYGON_STYLE.dimmed.fillOpacity);
  layer.listeners.click({}); assert.equal(layer.styles.at(-1).fillOpacity, POLYGON_STYLE.selectedZip.fillOpacity);
  assert.equal(e['map-dsp'].value, other);
  change(''); assert.equal(e['map-zip-panel'].hidden, false);
  change(owner); assert.equal(e['map-zip-panel'].hidden, false);
  change(other); assert.equal(e['map-zip-panel'].hidden, true);
  e['map-routes'].children[0].listeners.click();
  change(other); assert.equal(e['map-summary-panel'].hidden, false);
  change(owner); assert.equal(e['map-summary-panel'].hidden, true);
  replies.push(reply(200, { postal_code: '00002', station: 'MOCKA', status: 'covered', route_id: layer.feature.properties.route_id, dsp_name: other }));
  await page.searchQuery('00002', true); assert.equal(e['map-zip-panel'].hidden, false); assert.equal(e['map-dsp'].value, owner);
  for (const status of ['uncovered', 'no_boundary', 'out_of_range', 'multi_station']) {
    replies.push(reply(200, { postal_code: '99999', status, owners: [] }));
    await page.searchQuery('99999', true); change(other); change(owner);
    assert.equal(e['map-zip-panel'].hidden, false);
    assert.equal(e['map-selection'].children[0].children[0].textContent, '99999');
  }
  doc.listeners.keydown({ key: 'Escape' });
  const excluded = data.routes.find(r => r.dsp_name !== owner);
  e['map-search'].value = excluded.route_name; await e['map-search'].listeners.input();
  assert.equal(e['map-no-match'].hidden, false);
  await page.searchQuery(excluded.route_name, true); assert.equal(e['map-summary-panel'].hidden, true);
  const included = data.routes.find(r => r.dsp_name === owner);
  await page.searchQuery(included.route_name, true); assert.equal(e['map-summary-panel'].hidden, false);
  replies.push(reply(200, data)); await page.loadStation(); assert.equal(e['map-dsp'].value, owner);
  replies.push(reply(200, { ...data, routes: [] })); await page.loadStation(); assert.equal(e['map-dsp'].value, '');
  assert.deepEqual(writes, []);
});

test('RM7 Station, overview and District changes retain only available DSPs; cross-Station search remains', async () => {
  const { buildDistrictMap } = await import('../src/route-map/route-map.js');
  const source = profiles();
  source.stations.MOCKA.rows.forEach((r, i) => r.dsp_name = i ? 'Shared' : 'Only-A');
  source.stations.MOCKB.rows[0].dsp_name = 'Shared';
  const districts = [{ id: 'mock', name_zh: '模拟', stations: [{ code: 'MOCKA', has_snapshot: true }, { code: 'MOCKB', has_snapshot: true }] },
    { id: 'other', name_zh: '其他', stations: [{ code: 'MOCKB', has_snapshot: true }] }];
  const data = buildDistrictMap({ profiles: source, districts, district: 'mock', boundaries: boundaries() });
  const { elements: e, replies, reply, page } = await fixture();
  replies.push(reply(200, { districts }), reply(200, data)); await page.start();
  const change = value => { e['map-dsp'].value = value; e['map-dsp'].listeners.change(); };
  change('Shared');
  e['map-station'].value = 'MOCKB'; replies.push(reply(200, data)); await e['map-station'].listeners.change();
  assert.equal(e['map-dsp'].value, 'Shared');
  e['map-station'].value = ''; replies.push(reply(200, data)); await e['map-station'].listeners.change();
  assert.deepEqual(e['map-dsp'].children.map(o => o.value), ['', 'Only-A', 'Shared']);
  change('Only-A'); e['map-station'].value = 'MOCKB'; replies.push(reply(200, data)); await e['map-station'].listeners.change();
  assert.equal(e['map-dsp'].value, '');
  e['map-station'].value = 'MOCKA'; replies.push(reply(200, data)); await e['map-station'].listeners.change(); change('Shared');
  e['map-search'].value = 'Mock-C'; await e['map-search'].listeners.input();
  assert.equal(e['map-routes'].children[0].children[1].textContent, 'Mock-C');
  await page.searchQuery('Mock-C', true); assert.equal(e['map-summary-panel'].hidden, false);
  e['map-district'].value = 'other'; replies.push(reply(200, buildDistrictMap({ profiles: source, districts, district: 'other', boundaries: boundaries() })));
  await e['map-district'].listeners.change(); assert.equal(e['map-dsp'].value, 'Shared');
  e['map-district'].value = 'mock'; replies.push(reply(200, data)); await e['map-district'].listeners.change(); change('Only-A');
  e['map-district'].value = 'other'; replies.push(reply(200, buildDistrictMap({ profiles: source, districts, district: 'other', boundaries: boundaries() })));
  await e['map-district'].listeners.change(); assert.equal(e['map-dsp'].value, '');
});

test('RM8 retains text, hints, filtering, viewport and invalidates old ZIPs across selectors and retry', async () => {
  const { elements: e, page, replies, reply, map, requests, doc } = await fixture();
  const data = payload();
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, data)); await page.start();
  e['map-search'].value = '00002';
  let release; replies.push(() => new Promise(resolve => { release = resolve; }));
  const pending = page.searchQuery('00002', true);
  const fits = map.fits.length, calls = requests.length;
  e['map-station'].value = 'MOCKB'; replies.push(reply(200, data)); await e['map-station'].listeners.change();
  assert.equal(e['map-search'].value, '00002'); assert.match(e['map-search-message'].textContent, /已保留 ZIP 00002，按 Enter 在当前范围重新查询/);
  assert.equal(requests.length, calls + 1);
  release(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00002' }))); await pending;
  assert.equal(e['map-zip-panel'].hidden, true);
  e['map-station'].value = 'MOCKA'; replies.push(reply(200, data)); await e['map-station'].listeners.change();
  assert.ok(map.fits.length > fits);
  e['map-dsp'].listeners.change(); assert.equal(e['map-search'].value, '00002');
  e['map-district'].value = 'mock'; replies.push(reply(200, data)); await e['map-district'].listeners.change();
  assert.equal(e['map-search'].value, '00002');
  replies.push(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00002' })));
  await e['map-search'].listeners.keydown({ key: 'Enter', preventDefault() {} }); assert.equal(e['map-zip-panel'].hidden, false);
  e['map-clear'].listeners.click(); doc.listeners.keydown({ key: 'Escape' }); assert.equal(e['map-search'].value, '00002');
  e['map-search'].value = ''; await e['map-search'].listeners.input(); assert.equal(e['map-search-message'].textContent, ''); assert.ok(e['map-routes'].children.length > 0);
  e['map-search'].value = 'absent route'; replies.push(reply(200, data)); await page.loadStation();
  assert.equal(e['map-search'].value, 'absent route'); assert.equal(e['map-no-match'].hidden, false);
  replies.push(reply(500, { error: 'internal_error' })); await page.loadStation();
  replies.push(reply(200, data)); await e['map-retry'].listeners.click(); assert.equal(e['map-search'].value, 'absent route');
  e['map-search'].value = data.routes[0].route_name; await e['map-search'].listeners.input();
  await e['map-search'].listeners.keydown({ key: 'Enter', preventDefault() {} }); assert.equal(e['map-summary-panel'].hidden, false);
});


test('R1 SVG renderers share configurable padding across polygons, highlights and outlines', async () => {
  const { page, groups, renderers, replies, reply } = await fixture();
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, payload()));
  await page.start();
  assert.equal(renderers.length, 2);
  assert.deepEqual(renderers.map(renderer => renderer.options), [
    { padding: MAP_RENDER.svgPadding }, { pane: 'selection-outline', padding: MAP_RENDER.svgPadding },
  ]);
  assert.equal(groups[0].options.renderer, renderers[0]);
  groups[0].layers[0].listeners.click({});
  const highlights = groups.filter(group => !group.options.pane && group !== groups[0]);
  assert.equal(highlights.length, 1); assert.equal(highlights[0].options.renderer, renderers[0]);
  const outlines = groups.filter(group => group.options.pane === 'selection-outline');
  assert.equal(outlines.length, 4);
  for (const group of outlines) {
    assert.equal(group.options.renderer, renderers[1]);
    assert.equal(group.options.renderer.options.padding, MAP_RENDER.svgPadding);
    assert.equal(group.options.renderer.options.pane, 'selection-outline');
  }
});

test('R1 basemap zoom options retain unrestricted US coverage and deferred zoom updates', async () => {
  const { baselayers } = await fixture();
  assert.equal(baselayers.length, basemaps.length);
  for (const [index, layer] of baselayers.entries()) {
    const { name, ...options } = basemaps[index];
    assert.equal(layer.options.updateWhenZooming, false);
    assert.equal(layer.options.flavor, 'light'); assert.equal(layer.options.noWrap, true);
    for (const [key, value] of Object.entries(options)) assert.deepEqual(layer.options[key], value);
    assert.equal(layer.options.url.url, '/basemap/' + name + '.pmtiles');
  }
  assert.equal(Object.hasOwn(baselayers[0].options, 'minZoom'), false);
  assert.equal(Object.hasOwn(baselayers[0].options, 'maxZoom'), false);
  assert.deepEqual(baselayers.slice(1).map(layer => layer.options.minZoom), [7, 7, 10]);
});

test('R1 focus outline suppression is scoped to interactive map SVG paths', async () => {
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#route-map path\.leaflet-interactive:focus\s*\{\s*outline:\s*none;\s*\}/);
});

test('R1b scale overrides stay scoped to the map with bounded responsive sizes and readable fonts', async () => {
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  const marker = '/* MAP-R1b: map page scale (PO 2026-10-09) */';
  assert.equal(css.split(marker).length, 2, 'one appended scale block');
  const block = css.split(marker)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => !selector.trim().startsWith('@media'));
  assert.ok(rules.length > 20);
  for (const [, selectors, declarations] of rules) {
    for (const selector of selectors.split(',')) {
      assert.ok(selector.trim().startsWith('.map-page'), selector);
      assert.doesNotMatch(selector, /data-dialog|warehouse-panel/);
    }
    for (const [, size] of declarations.matchAll(/font-size:\s*(\d+)px/g)) {
      assert.ok(Number(size) >= 13 || (selectors.trim() === '.map-page .leaflet-control-attribution' && size === '11'));
    }
    assert.doesNotMatch(declarations, /(?:color|background|opacity)\s*:/);
  }
  assert.match(block, /\.map-page \{ max-width: 1800px; font-size: 16px;/);
  assert.match(block, /\.map-page #route-map \{ height: 78vh; min-height: 480px;/);
  assert.match(block, /\.map-page \.map-routes \{ max-height: 360px;/);
  assert.match(block, /@media \(max-width: 750px\)\s*\{\s*\.map-page #route-map \{ height: 60vh; min-height: 360px;/);
  assert.match(block, /@media \(min-width: 751px\)\s*\{\s*\.map-page > \.snapshot \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
  assert.match(block, /\.map-page > \.snapshot:hover, \.map-page > \.snapshot:focus-within \{ white-space: normal;/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 280px/);
  assert.match(block, /dd:not\(:where\(\.map-zip-metrics dd\)\)/);
  assert.match(block, /p:not\(:where\(#map-coverage\)\)/);
  for (const [selector, size] of [
    ['.map-sidebar .map-route-name', 20], ['.map-sidebar .map-summary-metrics dd', 19],
    ['.map-sidebar .map-zip-info dd', 14], ['.map-sidebar .map-summary-updated', 13],
    ['.leaflet-tooltip dd', 15], ['.leaflet-tooltip dt', 13], ['.warehouse-popup dt', 13],
  ]) assert.ok(block.includes(`.map-page ${selector} { font-size: ${size}px; }`), selector);
});


async function labelFixture() {
  const f = await fixture();
  f.view = createMapView({ leaflet: f.leaflet, document: f.doc, onZip() {}, onClear() {}, onColorMode() {} });
  const square = x => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] });
  f.data = { routes: [], features: { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { route_id: 1, route_name: 'MOCK-001', station: 'A', dsp_name: 'Alpha' }, geometry: square(0) },
    { type: 'Feature', properties: { route_id: 2, route_name: 'MOCK-002', station: 'B', dsp_name: 'Beta' }, geometry: square(10) },
  ] } };
  return f;
}
const labelVisible = marker => !marker.node.className.includes('route-label--hidden');

test('RM10d label dimming matches polygons for station focus, DSP filtering and route selection at every tier', async () => {
  for (const zoom of [7, 10, 12]) {
    const { view, map, data, routeMarkers, groups } = await labelFixture();
    data.features.features.forEach((feature, index) => { feature.properties.postal_code = `0000${index + 1}`; });
    map.zoom = zoom;
    map.latLngToContainerPoint = ([lat, lng]) => ({ x: 200 + lng * 30, y: 200 });
    view.render(data, { fitToStation: false, focusStation: 'A' });
    let layers = groups.at(-1).layers;
    const check = (dimmed, selected = [false, false]) => {
      routeMarkers.slice(-2).forEach((marker, index) => {
        assert.equal(labelVisible(marker), true);
        assert.equal(marker.node.classList.contains('route-label--dimmed'), dimmed[index]);
        assert.equal(marker.node.classList.contains('route-label--selected'), selected[index]);
        assert.equal(layers[index].styles.at(-1).fillOpacity,
          dimmed[index] ? POLYGON_STYLE.dimmed.fillOpacity
            : selected[index] ? POLYGON_STYLE.selectedRoute.fillOpacity : POLYGON_STYLE.focused.fillOpacity);
      });
    };
    check([false, true]);
    // Beta reverses the match, then removing station focus isolates the DSP filter.
    view.setDsp('Beta'); check([true, true]);
    view.render(data, { fitToStation: false });
    layers = groups.at(-1).layers;
    check([true, false]);
    view.applySelection({ station: 'A', route: { route_id: 1 }, zip: null });
    check([false, true], [true, false]);
    view.applySelection({ station: 'B', route: { route_id: 2 }, zip: null });
    check([true, false], [false, true]);
  }
});

test('RM10b labels at all zoom levels, classes, safe DOM content, viewport culling and pane preserve interactions', async () => {
  const f = await labelFixture(), { view, map, data, routeMarkers } = f;
  data.features.features[1].properties.route_name = 'X-<img src=x onerror=alert(1)>';
  map.latLngToContainerPoint = ([lat, lng]) => ({ x: 200 + lng * 30, y: 200 + lat * 30 });
  map.zoom = 7; view.render(data, { fitToStation: false });
  assert.equal(routeMarkers.length, 2); assert.ok(routeMarkers.every(labelVisible));
  assert.equal(map.panes['route-labels'].style.zIndex, '610');
  assert.equal(map.panes['route-labels'].style.pointerEvents, 'none');
  for (const m of routeMarkers) {
    assert.equal(m.options.interactive, false); assert.equal(m.options.keyboard, false);
    assert.equal(m.options.pane, 'route-labels');
    assert.ok(m.node.classList.contains('leaflet-marker-icon'));
    assert.ok(m.node.classList.contains('leaflet-zoom-animated'));
    assert.equal(m.options.icon.html.tagName, 'span'); assert.deepEqual(m.options.icon.html.children, []);
  }
  assert.equal(routeMarkers[1].options.icon.html.textContent, '<img src=x onerror=alert(1)>');
  map.zoom = 11; map.listeners.zoomend(); assert.ok(routeMarkers.every(labelVisible));
  view.setColorMode('difficulty'); assert.ok(routeMarkers.every(m => !labelVisible(m)));
  view.setColorMode('route'); assert.ok(routeMarkers.every(labelVisible));
  map.zoom = 9; view.applySelection({ station: 'A', route: { route_id: 1 }, zip: null });
  assert.equal(labelVisible(routeMarkers[0]), true); assert.match(routeMarkers[0].node.className, /route-label--selected/);
  assert.equal(labelVisible(routeMarkers[1]), true);
  map.zoom = 8; map.listeners.zoomend(); assert.ok(routeMarkers.every(labelVisible));
  map.zoom = 11; map.latLngToContainerPoint = () => ({ x: -100, y: 100 }); map.listeners.moveend();
  assert.ok(routeMarkers.every(m => !labelVisible(m)));
  view.clear(); assert.ok(routeMarkers.every(m => map.removed.includes(m)));
});

test('R2a greedy labels prioritize selection, focus, normal and area, and avoid warehouse DOM rectangles', async () => {
  const { view, map, data, routeMarkers, elements } = await labelFixture();
  map.latLngToContainerPoint = () => ({ x: 100, y: 100 });
  // Larger second Route wins a tie in normal state.
  data.features.features[1].geometry.coordinates[0] = [[0,0], [2,0], [2,2], [0,2], [0,0]];
  view.render(data, { fitToStation: false });
  assert.deepEqual(routeMarkers.map(labelVisible), [false, true]);
  view.setDsp('Alpha'); assert.deepEqual(routeMarkers.map(labelVisible), [true, false]);
  assert.match(routeMarkers[1].node.className, /route-label--dimmed/);
  view.applySelection({ station: 'B', route: { route_id: 2 }, zip: null });
  assert.deepEqual(routeMarkers.map(labelVisible), [false, true]);
  view.applySelection({ station: null, route: null, zip: null }); view.setDsp(null);
  view.render(data, { fitToStation: false, focusStation: 'A' });
  assert.deepEqual(routeMarkers.slice(-2).map(labelVisible), [true, false]);
  assert.ok(routeMarkers.slice(0, 2).every(m => map.removed.includes(m)));
  const warehouse = { getBoundingClientRect: () => ({ left: 90, right: 110, top: 90, bottom: 110, width: 20, height: 20 }) };
  elements['route-map'].querySelectorAll = selector => { assert.equal(selector, '.warehouse-marker'); return [warehouse]; };
  map.listeners.moveend(); assert.ok(routeMarkers.slice(-2).every(m => !labelVisible(m)));
});

test('R2a zoom animation does not lay out labels or recalculate cached geometry', async () => {
  const { view, map, data, routeMarkers } = await labelFixture();
  let geometryReads = 0;
  for (const feature of data.features.features) {
    const geometry = feature.geometry;
    Object.defineProperty(feature, 'geometry', { get() { geometryReads++; return geometry; } });
  }
  view.render(data, { fitToStation: false });
  const reads = geometryReads, projections = map.projections, points = routeMarkers.map(m => m.point);
  map.listeners.zoomstart(); map.zoom = 12;
  map.listeners.moveend(); view.setDsp('Alpha'); view.setColorMode('difficulty');
  assert.equal(map.projections, projections); assert.equal(geometryReads, reads);
  view.setColorMode('route');
  map.listeners.zoomend(); assert.ok(map.projections > projections);
  assert.equal(geometryReads, reads); assert.deepEqual(routeMarkers.map(m => m.point), points);
  const after = map.projections; map.listeners.moveend(); assert.ok(map.projections > after);
  assert.equal(geometryReads, reads);
  assert.equal(map.listeners.zoom, undefined); assert.equal(map.listeners.zoomanim, undefined);
});

test('R2a label CSS removes divIcon defaults, centers text and uses classes without inline style strings', async () => {
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  const source = await fs.readFile(new URL('../../web/map-view.js', import.meta.url), 'utf8');
  assert.match(css, /\.route-label \{[^}]*background: transparent;[^}]*border: 0;[^}]*pointer-events: none;[^}]*font-size: 16px;/);
  assert.match(css, /transform: translate\(-50%, -50%\)/);
  const labelRules = css.match(/\.route-label[^{}]*\{[^}]*\}/g).join('\n');
  assert.doesNotMatch(labelRules, /text-shadow:/);
  assert.match(css, /\.route-label > span \{[^}]*background: rgba\(255,255,255,.72\);[^}]*padding: 0 4px;[^}]*border-radius: 2px;[^}]*box-shadow: 0 0 0 1px rgba\(15,23,42,.08\);/);
  assert.match(css, /\.route-label--selected > span \{[^}]*padding: 1px 5px;[^}]*border-radius: 3px;[^}]*box-shadow: 0 0 0 1px rgba\(15,23,42,.3\), 0 1px 3px rgba\(15,23,42,.2\);/);
  assert.doesNotMatch(labelRules, /\.route-label[^{}]*> span\s*\{[^}]*opacity:/);
  assert.match(css, /\.route-label--selected > span \{[^}]*font-size: 18px;[^}]*line-height: 22px;[^}]*font-weight: 700;[^}]*color: #0f172a;[^}]*background: rgba\(255,255,255,.95\);/);
  assert.match(css, /\.route-label\.route-label--dimmed \{ opacity: 0.4; color: #475569; font-weight: 600; \}/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|cssText|setAttribute\(['"]style/);
});


test('RM10b secondary tiers and same-route distance use placed centers with a strict 160px boundary', async () => {
  const { view, map, data, routeMarkers } = await labelFixture();
  data.features.features[1].properties = { ...data.features.features[0].properties };
  let distance = 160;
  map.latLngToContainerPoint = ([lat, lng]) => ({ x: 200 + (lng > 5 ? distance : 0), y: 200 });
  map.zoom = 9; view.render(data, { fitToStation: false });
  assert.deepEqual(routeMarkers.map(labelVisible), [true, false]);
  map.zoom = 10; map.listeners.zoomend();
  assert.deepEqual(routeMarkers.map(labelVisible), [true, true]);
  distance = 159; map.listeners.moveend();
  assert.deepEqual(routeMarkers.map(labelVisible), [true, false]);
  distance = 160; map.zoom = 9;
  view.applySelection({ station: 'A', route: { route_id: 1 }, zip: null });
  assert.deepEqual(routeMarkers.map(labelVisible), [true, true]);
  map.zoom = 10; map.listeners.zoomend();
  assert.deepEqual(routeMarkers.map(labelVisible), [true, true]);
  view.setColorMode('difficulty'); assert.ok(routeMarkers.every(m => !labelVisible(m)));
  view.setColorMode('route'); assert.ok(routeMarkers.every(labelVisible));
});

test('RM10 primary regions beat larger secondary regions at the same priority', async () => {
  const { view, map, data, routeMarkers } = await labelFixture();
  const first = data.features.features[0], second = data.features.features[1];
  const square = (x, size) => ({ type: 'Polygon', coordinates: [[[x, 0], [x + size, 0], [x + size, size], [x, size], [x, 0]]] });
  first.geometry = square(0, 3);
  second.geometry = square(20, 1);
  data.features.features.push({ ...first, geometry: square(10, 2) });
  map.latLngToContainerPoint = ([lat, lng]) => ({ x: lng < 5 ? 100 : 400, y: 200 });
  map.zoom = 12; view.render(data, { fitToStation: false });
  assert.deepEqual(routeMarkers.map(labelVisible), [true, false, true]);
});


test('RM10b tiers use exclusive boundaries, padded collisions and unpadded viewport bounds', async () => {
  const { view, map, data, routeMarkers } = await labelFixture();
  let edge = false;
  map.latLngToContainerPoint = ([lat, lng]) => ({ x: edge ? 9 : 200 + (lng > 5 ? 30 : 0), y: 200 });
  map.zoom = 7; view.render(data, { fitToStation: false });
  for (const [zoom, tier, visible] of [[7, 'far', [true, false]], [9, 'far', [true, false]],
    [10, 'mid', [true, true]], [12, 'near', [true, true]]]) {
    map.zoom = zoom; map.listeners.zoomend();
    for (const candidate of ROUTE_LABEL.tiers) assert.equal(map.panes['route-labels'].classList.contains(`route-labels--${candidate.name}`), candidate.name === tier);
    assert.deepEqual(routeMarkers.map(labelVisible), visible);
    view.setColorMode('difficulty'); assert.ok(routeMarkers.every(m => !labelVisible(m)));
    view.setColorMode('route'); assert.deepEqual(routeMarkers.map(labelVisible), visible);
  }
  map.zoom = 7; edge = true; map.listeners.zoomend();
  assert.deepEqual(routeMarkers.map(labelVisible), [true, false]);
});


test('RM10e CSS preserves tier sizes and layout dimensions and selection stays prominent', async () => {
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  for (const [tier, font, opacity, height] of [['far', 18, '0.95', 18], ['mid', 15, '1', 20]]) {
    assert.ok(css.includes(`.route-labels--${tier} .route-label { font-size: ${font}px; opacity: ${opacity}; }`));
    assert.ok(css.includes(`.route-labels--${tier} .route-label > span { line-height: ${height}px; }`));
    assert.ok(!css.includes(`.route-labels--${tier} .route-label--dimmed`));
    assert.equal(ROUTE_LABEL.tiers.find(t => t.name === tier).height, height);
  }
  assert.match(css, /\.route-labels--far \.route-label--selected,\s*\.route-labels--mid \.route-label--selected \{ opacity: 1; \}/);
  assert.match(css, /font-size: 17px; line-height: 22px;/);
  assert.match(css, /\.route-label \{[^}]*font-weight: 700;[^}]*color: #334155;[^}]*opacity: 1;/);
  assert.match(css, /\.route-label > span \{[^}]*line-height: 22px;/);
  assert.deepEqual(ROUTE_LABEL.tiers.map(t => [t.name, t.characterWidth, t.height, t.padding, t.selectedCharacterWidth, t.selectedHeight]), [
    ['far', 8.5, 18, 10, 10.5, 26], ['mid', 9, 20, 5, 10.5, 26], ['near', 9.5, 22, 2, 11, 26],
  ]);
});


test('RM10b far selected labels still yield to warehouses and viewport edges', async () => {
  const { view, map, data, routeMarkers, elements } = await labelFixture();
  map.zoom = 7;
  map.latLngToContainerPoint = () => ({ x: 100, y: 100 });
  view.render(data, { fitToStation: false });
  view.applySelection({ station: 'B', route: { route_id: 2 }, zip: null });
  assert.deepEqual(routeMarkers.map(labelVisible), [false, true]);
  elements['route-map'].querySelectorAll = () => [{ getBoundingClientRect: () => ({ left: 90, right: 110, top: 90, bottom: 110, width: 20, height: 20 }) }];
  map.listeners.moveend(); assert.ok(routeMarkers.every(m => !labelVisible(m)));
  elements['route-map'].querySelectorAll = () => [];
  map.latLngToContainerPoint = () => ({ x: -100, y: 100 });
  map.listeners.moveend(); assert.ok(routeMarkers.every(m => !labelVisible(m)));
});


test('RM11 shared assignments persist in view and focused labels track priority', async () => {
  const { view, data, groups, routeMarkers } = await labelFixture();
  const colors = new Map([[1, palette[0]], [2, palette[1]]]);
  view.render(data, { focusStation: 'A', routeColors: colors });
  const layers = groups.at(-1).layers;
  assert.ok(routeMarkers.at(-2).node.classList.contains('route-label--focused'));
  assert.equal(layers[0].styles.at(-1).fillColor, polygonStyle(data.features.features[0].properties, undefined, 'route', 'A', null, colors).fillColor);
  view.applySelection(selectRoute(1));
  assert.equal(routeMarkers.at(-2).node.classList.contains('route-label--focused'), false);
  view.setColorMode('difficulty'); view.setColorMode('route'); view.setDsp('Alpha');
  assert.equal(layers[0].styles.at(-1).fillColor, polygonStyle(data.features.features[0].properties, selectRoute(1), 'route', 'A', 'Alpha', colors).fillColor);
  const source = await fs.readFile(new URL('../../web/map.js', import.meta.url), 'utf8');
  assert.equal(source.match(/assignRouteColors\(/g).length, 1);
  assert.match(source, /panel.render\(data, \{ focusStation: station, routeColors \}\)/);
  assert.match(source, /view.render\(data, \{ fitToStation: true, focusStation: station, routeColors \}\)/);
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.route-label--focused \{ color: #0f172a; \}/);
  assert.match(css, /\.route-label--focused > span \{ background: rgba\(255,255,255,\.9\); \}/);
});


test('RM11 panel consumes supplied palette assignments and falls back after a new render', async () => {
  const { createMapPanel } = await import('../../web/map-panel.js');
  const { doc, elements: e } = await fixture();
  const panel = createMapPanel({ document: doc, onRoute() {}, onClear() {}, onSearch() {} });
  const data = payload(), route = data.routes[0];
  const colors = new Map([[route.route_id, palette[0]]]);
  panel.render(data, { routeColors: colors });
  const swatches = () => e['map-routes'].children.filter(row => row.className === 'map-route').map(row => row.children[0].style.backgroundColor);
  assert.equal(swatches()[0], palette[0]);
  panel.applySelection(selectRoute(route.route_id)); panel.setDsp(null);
  panel.setColorMode('difficulty'); panel.setColorMode('route');
  assert.equal(swatches()[0], palette[0]);
  panel.render(data);
  assert.deepEqual(swatches(), data.routes.map(row => routeColor(row.route_id)));
});
