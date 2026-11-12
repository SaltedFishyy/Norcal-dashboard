import test from 'node:test';
import { namedFlavor } from '@protomaps/basemaps';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { polygonStyle, selectRoute, POLYGON_STYLE, hoverStyle, uncoveredZipStyle } from '../../web/map-state.js';
import { MAP_RENDER, basemaps, createMapView, ROUTE_LABEL, BASEMAP_FLAVOR, SERVICE_BOUNDS, serviceTile } from '../../web/map-view.js';
import { routeColor, palette } from '../../web/route-colors.js';
import { buildRouteMap, lookupZip } from '../src/route-map/route-map.js';
import { profiles, boundaries } from './route-map-fixtures.js';
import { mapUpdatedSummary } from '../../web/map-panel.js';
import { formatUpdated } from '../../web/format.js';

test('RM13 updated summary uses chronological range, single instant and missing fallback', () => {
  const early = '2026-10-14T17:02:00Z', late = '2026-10-30T00:14:00Z';
  assert.equal(mapUpdatedSummary([{ fetched_at: late }, { fetched_at: early }]), `${formatUpdated(early)} – ${formatUpdated(late)}`);
  assert.equal(mapUpdatedSummary([{ fetched_at: late }]), formatUpdated(late));
  assert.equal(mapUpdatedSummary([{ fetched_at: late }, { fetched_at: '2026-10-29T17:14:00-07:00' }]), formatUpdated(late));
  assert.equal(mapUpdatedSummary([{ fetched_at: null }, { fetched_at: 'invalid' }]), '—');
  assert.equal(mapUpdatedSummary([], early), formatUpdated(early));
});

test('RM13 map presentation keeps warnings visible and the responsive layout stacked', async () => {
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  const block = css.split('/* RM13:')[1];
  assert.match(block, /\.map-page > p:empty/);
  assert.match(block, /\.data-status > p:not\(:empty\)/);
  assert.match(block, /\.map-mode button\[aria-pressed="true"\]/);
  assert.match(block, /@media \(max-width: 750px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  const html = await fs.readFile(new URL('../../web/map.html', import.meta.url), 'utf8');
  assert.match(html, /placeholder="搜索线路编号或邮编"/);
  assert.ok(html.indexOf('map-route-panel') < html.indexOf('id="map-zip-panel"'));
});

test('RM13 successful map message is visually hidden while loading, failure and empty states remain visible', async () => {
  const { elements: e, page, replies, reply } = await fixture();
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, payload()));
  await page.start();
  assert.equal(e['map-message'].className, 'sr-only');
  assert.match(e['map-message'].textContent, /\u7ebf\u8def\u5730\u56fe\u5df2\u52a0\u8f7d/);
  let release;
  replies.push(() => new Promise(resolve => { release = () => resolve(reply(500, { error: 'boundary_invalid' })); }));
  const pending = page.loadStation();
  assert.equal(e['map-message'].className, '');
  release(); await pending;
  assert.equal(e['map-message'].className, 'map-error');
  replies.push(reply(404, { error: 'snapshot_not_found' })); await page.loadStation();
  assert.equal(e['map-message'].className, '');
  const empty = payload(); empty.routes = []; empty.features.features = [];
  replies.push(reply(200, empty)); await page.loadStation();
  assert.equal(e['map-message'].className, '');
  const noBoundaries = payload(); noBoundaries.routes.forEach(route => { route.mapped_count = 0; });
  replies.push(reply(200, noBoundaries)); await page.loadStation();
  assert.equal(e['map-message'].className, '');
});

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
  assert.equal(e['map-search'].placeholder, '搜索线路编号或邮编');
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
  getAttribute(name) { return this.attributes[name]; }
  scrollIntoView(options) { this.scrolled = options; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

export async function fixture(search = '', basemapStatus = 206, storage = null, warehouseOptions = {}, basemapTile = async () => { throw new Error('mock archive unavailable'); }) {
  const { createMapPage } = await import('../../web/map.js');
  const warehouseModules = await Promise.all([import('../../web/warehouse-layer.js'), import('../../web/warehouse-panel.js')]);
  const ids = ['route-map', ...['district', 'station', 'dsp', 'message', 'retry', 'content', 'selection', 'coverage',
    'missing', 'missing-empty', 'regenerate', 'source', 'updated', 'search', 'routes', 'no-match', 'clear', 'summary', 'zip-panel', 'coverage-count', 'missing-details', 'missing-title', 'basemap-message', 'zip-heading', 'summary-heading', 'search-hint', 'search-message', 'summary-panel', 'conflicts-details', 'conflicts-title', 'conflicts'].map(id => `map-${id}`)];
  ids.push(...['date', 'date-field', 'date-notice', 'date-text', 'date-missing', 'date-latest'].map(id => `map-${id}`));
  ids.push('map-warehouses', 'map-warehouse-message', 'map-warehouse-notice');
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const doc = { querySelectorAll: () => [], listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, getElementById: id => elements[id], createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
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
          closeTooltip() { this.tooltipOpen = false; this.tooltipCloses = (this.tooltipCloses || 0) + 1; },
          openTooltip() { this.tooltipOpen = true; this.listeners.tooltipopen?.(); },
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
    paintRules: flavor => [{ flavor }], labelRules: (flavor, lang) => [{ flavor, lang }],
    PmtilesSource: class { constructor(url) { this.p = { url, getZxy: (...args) => basemapTile(url, ...args) }; } },
    leafletLayer(options) {
    const layer = { options, on(name, fn) { this.error = fn; }, addTo() { baselayers.push(this); return this; } }; return layer;
  } }, fetch: async (url, options) => {
    if (url.startsWith('/basemap/')) return { status: typeof basemapStatus === 'function' ? basemapStatus(url) : basemapStatus, arrayBuffer: async () => Uint8Array.from([80,77,84,105,108,101,115,3]).buffer };
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
    if (url.startsWith('/api/snapshot-days')) return warehouseOptions.daysReply ? warehouseOptions.daysReply(url) : { status: 200, json: async () => ({ available: false }) };
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

const calendarReply = () => ({ status: 200, json: async () => ({ available: true, days: [
  { day: '2026-11-08', has_data: true, stations_with_data: ['MOCKA'] },
  { day: '2026-11-07', has_data: false, stations_with_data: [] },
] }) });

test('DV-T4 map and ZIP use the selected date, preserve URL context and return to latest', async () => {
  const urls = [];
  const { page, doc, elements: e, requests, replies, reply } = await fixture('?station=MOCKA&date=2026-11-08', 206, null,
    { daysReply: calendarReply, history: { replaceState: (_, __, url) => urls.push(url) } });
  const link = new Element('a'); link.setAttribute('href', '/?district=mock');
  doc.querySelectorAll = selector => selector === '.page-nav a' ? [link] : [];
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, payload()));
  await page.start();
  assert.equal(e['map-date'].value, '2026-11-08');
  assert.equal(e['map-date-notice'].hidden, false);
  assert.match(e['map-date-text'].textContent, /正在查看 11\/08 的数据/);
  assert.equal(e['map-date'].children[2].textContent, '11/07（空）');
  assert.equal(requests.at(-1).url, '/api/route-map/district?district=mock&date=2026-11-08');
  assert.equal(link.getAttribute('href'), '/?district=mock&date=2026-11-08');
  replies.push(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00002' })));
  await page.searchQuery('00002', true);
  assert.equal(requests.at(-1).url, '/api/route-map/zip?postal_code=00002&date=2026-11-08');
  replies.push(reply(200, payload())); await e['map-date-latest'].listeners.click();
  assert.equal(urls.at(-1), '/map?station=MOCKA');
  assert.equal(link.getAttribute('href'), '/?district=mock');
  assert.equal(e['map-date-notice'].hidden, true);
  assert.equal(requests.at(-1).url, '/api/route-map/district?district=mock');
  replies.push(reply(200, payload())); e['map-date'].value = '2026-11-07'; await e['map-date'].listeners.change();
  assert.equal(urls.at(-1), '/map?station=MOCKA&date=2026-11-07');
  assert.equal(e['map-message'].textContent, '该站点在 11/07 没有数据');
});

test('DV-T4 partial district, empty dates, unknown calendar date and station 404 are empty states', async () => {
  const storage = { getItem: key => key === 'nc-ops-console.map-scope' ? 'district' : null };
  const { page, elements: e, replies, reply } = await fixture('?date=2026-11-08', 206, storage, { daysReply: calendarReply });
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, payload())); await page.start();
  assert.equal(e['map-date-missing'].textContent, ' · 当天无数据的站点：MOCKB');
  assert.equal(e['map-message'].className, 'sr-only');
  for (const result of [reply(404, { error: 'station_not_found' }), reply(404, { error: 'snapshot_not_found' }),
    reply(200, { ...payload(), routes: [], features: { type: 'FeatureCollection', features: [] } })]) {
    e['map-station'].value = 'MOCKB'; replies.push(result); await e['map-station'].listeners.change();
    assert.equal(e['map-message'].textContent, '该站点在 11/08 没有数据');
    assert.equal(e['map-message'].className, '');
  }
  e['map-station'].value = ''; replies.push(reply(200, payload())); await e['map-station'].listeners.change();
  e['map-date'].value = '2026-11-07'; replies.push(reply(200, payload())); await e['map-date'].listeners.change();
  assert.equal(e['map-message'].textContent, '该日无数据');
  const other = await fixture('?date=2026-01-01', 206, storage, { daysReply: calendarReply });
  other.replies.push(other.reply(200, { stations: ['MOCKA'] }), other.reply(200, payload())); await other.page.start();
  assert.equal(other.elements['map-date'].value, '2026-01-01');
  assert.match(other.elements['map-date'].children.at(-1).textContent, /（空）/);
  assert.equal(other.elements['map-message'].textContent, '该日无数据');
});

test('DV-T4 unavailable calendar hides selector and loads latest', async () => {
  for (const daysReply of [() => ({ status: 200, json: async () => ({ available: false }) }), () => { throw Error('offline'); }]) {
    const { page, elements: e, requests, replies, reply } = await fixture('?date=2026-11-08', 206, null, { daysReply });
    replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, payload())); await page.start();
    assert.equal(e['map-date-field'].hidden, true);
    assert.equal(e['map-date-notice'].hidden, true);
    assert.equal(requests.at(-1).url, '/api/route-map/district?district=mock');
  }
});

test('DV-T4 date changes discard old map and ZIP responses and rebuild DSPs', async () => {
  const { page, elements: e, replies, reply } = await fixture('?date=2026-11-08', 206, null, { daysReply: calendarReply });
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, payload())); await page.start();
  let releaseMap, releaseZip;
  replies.push(() => new Promise(resolve => { releaseMap = resolve; })); const oldMap = page.loadStation();
  replies.push(() => new Promise(resolve => { releaseZip = resolve; })); const oldZip = page.searchQuery('00002', true);
  const next = payload(); next.routes.forEach(route => { route.dsp_name = 'Daily DSP'; });
  replies.push(reply(200, next)); await e['map-date-latest'].listeners.click();
  releaseMap(reply(500, { error: 'boundary_invalid' })); releaseZip(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00002' })));
  await Promise.all([oldMap, oldZip]);
  assert.equal(e['map-message'].className, 'sr-only');
  assert.equal(e['map-zip-panel'].hidden, true);
  assert.equal(e['map-dsp'].children[1].textContent, 'Daily DSP');
});

test('DV-T4 district changes reload calendars and discard stale district calendars', async () => {
  const calendars = [], pending = [];
  const { page, elements: e, replies, reply } = await fixture('?date=2026-11-08', 206, null, {
    daysReply: url => { calendars.push(url); return pending.length ? pending.shift()() : calendarReply(); },
  });
  replies.push(reply(200, { districts: [
    { id: 'mock', stations: [{ code: 'MOCKA', has_snapshot: true }] },
    { id: 'other', stations: [{ code: 'MOCKB', has_snapshot: true }] },
  ] }), reply(200, payload())); await page.start();
  let release;
  pending.push(() => new Promise(resolve => { release = resolve; }));
  e['map-district'].value = 'other'; const old = e['map-district'].listeners.change();
  e['map-district'].value = 'mock'; replies.push(reply(200, payload())); await e['map-district'].listeners.change();
  release({ status: 200, json: async () => ({ available: false }) }); await old;
  assert.deepEqual(calendars, ['/api/snapshot-days?district=mock', '/api/snapshot-days?district=other', '/api/snapshot-days?district=mock']);
  assert.equal(e['map-date-field'].hidden, false);
  assert.equal(e['map-date'].value, '2026-11-08');
  const empty = payload(); empty.routes = []; empty.features.features = [];
  replies.push(reply(200, empty)); await page.loadStation();
  assert.equal(e['map-message'].textContent, '该站点在 11/08 没有数据');
});

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
  assert.equal(layer.styles[0].fillColor, polygonStyle(layer.feature.properties).fillColor);
  assert.equal(layer.options.bubblingMouseEvents, false);
  layer.listeners.mouseover(); assert.equal(layer.styles.at(-1).weight, POLYGON_STYLE.hover.weight);
  layer.listeners.mouseout(); assert.equal(layer.styles.at(-1).weight, POLYGON_STYLE.focused.weight);
  const originalEvent = {}; layer.listeners.click({ originalEvent });
  assert.equal(originalEvent.stopped, true);
  const panel = e['map-selection'].children[0];
  assert.equal(panel.children[0].textContent, '00002');
  assert.match(allText(e['map-selection']), /有线路覆盖/);
  assert.equal(sameRoute.styles.at(-1).weight, POLYGON_STYLE.selectedRoute.weight);
  map.listeners.click();
  assert.equal(e['map-zip-panel'].hidden, true);
  assert.equal(layer.styles.at(-1).weight, POLYGON_STYLE.focused.weight);
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
    assert.doesNotMatch(source.replaceAll('http://www.w3.org/2000/svg', ''), /innerHTML|https?:\/\//, filename);
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
  assert.deepEqual(baselayers.map(layer => layer.options.maxDataZoom), [6, 10, 10, 10, 10, 10, 10, 14, 14]);
  assert.ok(baselayers.every(layer => !('flavor' in layer.options) && layer.options.paintRules[0].flavor === BASEMAP_FLAVOR && layer.options.labelRules[0].lang === 'en'));
  assert.deepEqual(baselayers.map(layer => layer.options.url.url), ['/basemap/us.pmtiles', '/basemap/norcal.pmtiles', '/basemap/socal.pmtiles', '/basemap/mountain.pmtiles', '/basemap/pnw.pmtiles', '/basemap/az.pmtiles', '/basemap/hawaii.pmtiles', '/basemap/ops.pmtiles', '/basemap/service.pmtiles']);
  assert.deepEqual(basemaps.find(layer => layer.name === 'us').bounds, [[24.0, -125.0], [49.5, -66.5]]);
  assert.deepEqual(baselayers[0].options.bounds, [[24.0, -125.0], [49.5, -66.5]]);
  assert.deepEqual(baselayers[1].options.bounds, [[35.5, -124.6], [42.5, -119.0]]);
  assert.deepEqual(baselayers[3].options.bounds, [[34.0, -116.5], [47.0, -103.0]]);
  assert.deepEqual(baselayers[4].options.bounds, [[42.0, -124.9], [49.1, -116.4]]);
  assert.deepEqual(baselayers[5].options.bounds, [[31.2, -115.0], [37.4, -108.8]]);
  assert.deepEqual(baselayers[7].options.bounds, [[36.43, -123.16], [39.01, -121.06]]);
  assert.deepEqual(baselayers[2].options.bounds, [[32.4, -121.5], [35.6, -114.0]]);
  assert.deepEqual(baselayers[6].options.bounds, [[18.8, -160.6], [22.4, -154.7]]);
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
  assert.match(summary[3].textContent, /^数据更新时间 /);
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
  // Service preflight is lazy: the layer exists but requests no data until z11+.
  assert.equal(baselayers.length, 1);
  assert.equal(baselayers[0].options.url.url, '/basemap/service.pmtiles');
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
  for (const mode of [3, 0, 3]) controls[1].children[mode].listeners.click();
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
  assert.deepEqual(mode.children.map(node => node.textContent), ['按线路', '按 DSP', '按站点', '按难易度']);
  assert.ok(mode.children.every(button => button.type === 'button')); // Native buttons support Enter and Space.
  assert.deepEqual(mode.children.map(node => node.attributes['aria-pressed']), ['true', 'false', 'false', 'false']);
  assert.equal(legend.hidden, false);
  const fits = map.fits.length, calls = requests.length, count = groups.length;
  mode.children[3].listeners.click();
  assert.equal(legend.hidden, false); assert.equal(legend.children[0].textContent, '颜色：线路难度');
  assert.deepEqual(legend.children.slice(1).map(row => row.children[1].textContent), ['S 极难', 'A 难', 'B 中', 'C 易', 'D 极易', '无数据']);
  assert.deepEqual(legend.children.slice(1).map(row => row.children[0].style.backgroundColor), ['S', 'A', 'B', 'C', 'D', null].map(difficultyColor));
  assert.equal(groups[0].layers[0].styles.at(-1).fillColor, difficultyColor('B'));
  assert.equal(groups[0].layers[0].tooltip.children.length, 4);
  assert.deepEqual(e['map-routes'].children.map(row => row.children[2].textContent), ['B', 'D']);
  assert.deepEqual(e['map-routes'].children.map(row => row.children[0].style.backgroundColor), [difficultyColor('B'), difficultyColor('D')]);
  assert.equal(map.fits.length, fits); assert.equal(requests.length, calls); assert.equal(groups.length, count);
  groups[0].layers[0].listeners.click({});
  const selected = allText(e['map-selection']), selectedFits = map.fits.length, selectedGroups = groups.length;
  assert.equal(legend.children[0].textContent, '颜色：Mock-A 的 ZIP 难度');
  assert.equal(groups[0].layers[0].styles.at(-1).fillColor, difficultyColor('A'));
  assert.equal(groups[0].layers[1].styles.at(-1).fillColor, difficultyColor(null));
  assert.equal(groups[0].layers[1].tooltip.children.length, 4);
  assert.match(allText(e['map-summary']), /已有 1 个 ZIP/); // Cache row count, not profile ZIP count.
  assert.match(allText(e['map-selection']), /ZIP 难度 A级 难/);
  const highlight = groups.filter(group => !group.options.pane).at(-1).layers[0];
  assert.equal(highlight.styles[0].fillColor, difficultyColor('A')); assert.equal(highlight.styles[0].color, '#334155');
  mode.children[0].listeners.click();
  assert.equal(legend.hidden, false);
  assert.equal(highlight.styles.at(-1).fillColor, polygonStyle({route_id: 1}, selectRoute(1)).fillColor);
  assert.equal(highlight.tooltip.children.length, 4);
  mode.children[3].listeners.click();
  assert.equal(allText(e['map-selection']), selected); assert.equal(map.fits.length, selectedFits);
  assert.equal(requests.length, calls); assert.equal(groups.length, selectedGroups);
  assert.deepEqual(mode.children.map(node => node.attributes['aria-pressed']), ['false', 'false', 'false', 'true']);
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
  controls[1].children[3].listeners.click(); e['map-routes'].children[0].listeners.click();
  assert.match(allText(e['map-summary']), /暂无 ZIP 难度数据/);
  assert.doesNotMatch(allText(e['map-summary']), /npm run/);
  assert.ok(groups[0].layers.every(layer => layer.styles.at(-1).fillColor === '#9ca3af'));
  assert.equal(groups[0].layers[0].tooltip.children.length, 4);
  const { details } = await import('./route-map-fixtures.js');
  const cache = details(); cache.routes['1'].zips[0].postal_code_difficulty = null;
  const updated = buildRouteMap({ profiles: profiles(), boundaries: boundaries(), station: 'MOCKA', details: cache });
  replies.push(reply(200, updated)); await page.loadStation();
  assert.doesNotMatch(e['map-message'].textContent, /文件无效/);
  const current = groups.at(-1).layers;
  current[0].listeners.click({});
  assert.equal(current[0].tooltip.children.length, 4);
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
  controls[1].children[3].listeners.click();
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
  assert.equal(initial.layers.find(layer => layer.feature.properties.station === 'MOCKB').styles[0].fillOpacity, POLYGON_STYLE.outside.fillOpacity);
  assert.equal(e['map-coverage-count'].textContent, '2 / 4 ZIP 已上图');
  assert.equal(e['map-missing'].children[0].children[1].textContent, 'MOCKA');
  e['map-station'].value = ''; replies.push(reply(200, data)); await e['map-station'].listeners.change();
  assert.equal(controls[0].children[0].attributes['aria-label'], '定位片区'); assert.equal(values.get('nc-ops-console.map-scope'), 'district');
  assert.equal(JSON.parse(values.get('nc-ops-console.selection')).station, 'MOCKA');
  assert.deepEqual(e['map-routes'].children.filter(node => node.tagName === 'h3').map(node => node.textContent), ['MOCKA', 'MOCKB']);
  assert.equal(e['map-coverage-count'].textContent, '3 / 5 ZIP 已上图');
  const before = writes.length;
  replies.push(reply(200, lookupZip({ profiles: profiles(), boundaries: boundaries(), postalCode: '00009' })));
  await page.searchQuery('00009', true); assert.equal(e['map-station'].value, ''); assert.equal(writes.length, before);
  e['map-station'].value = 'MOCKA'; replies.push(reply(200, data)); await e['map-station'].listeners.change();
  assert.equal(controls[0].children[0].attributes['aria-label'], '定位站点');
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

test('RM6 compact ZIP fields, badges, safe four-row tooltips and shared clear button', async () => {
  const { elements: e, page, replies, reply, groups, controls } = await fixture();
  const { details } = await import('./route-map-fixtures.js');
  const source = profiles(), cache = details();
  source.stations.MOCKA.rows[1].dsp_name = '<Mock DSP>';
  Object.assign(cache.routes['1'].zips[0], { experienced_pph: 0, pickup_volume_daily: 1234 });
  const data = buildRouteMap({ profiles: source, station: 'MOCKA', boundaries: boundaries(), details: cache });
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, data)); await page.start();
  e['map-routes'].children[0].listeners.click();
  assert.equal(e['map-clear'].parentNode, e['map-summary-heading']);
  for (const mode of [0, 1, 2, 3]) {
    controls[1].children[mode].listeners.click();
    const tooltip = groups[0].layers[0].tooltip;
    assert.deepEqual(tooltip.children.map(row => row.children.map(n => n.textContent)), [['ZIP', '00002'], ['线路', 'Mock-A'], ['DSP', '<Mock DSP>'], ['首票价格', '—']]);
  }
  groups[0].layers[0].listeners.click({});
  assert.equal(e['map-clear'].parentNode, e['map-zip-heading']);
  const nodes = e['map-selection'].children;
  assert.equal(nodes[0].children[0].textContent, '00002');
  assert.deepEqual(nodes[1].children.map(row => row.children.map(n => n.textContent)), [['熟手 PPH', '0.00'], ['领件量（日均）', '1,234'], ['DSP', '<Mock DSP>'], ['ZIP 难度', 'A级 难'], ['首票价格', '—']]);
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
  assert.equal(MAP_RENDER.svgPadding, 1);
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

test('MAP-PERF basemaps hand off US coverage to regional layers and retain buffered tiles', async () => {
  const { baselayers } = await fixture();
  assert.equal(baselayers.length, basemaps.length);
  for (const [index, layer] of baselayers.entries()) {
    const { name, ...options } = basemaps[index];
    assert.equal(layer.options.updateWhenZooming, false);
    assert.equal(layer.options.keepBuffer, 4);
    assert.equal(layer.options.backgroundColor, BASEMAP_FLAVOR.background); assert.equal(layer.options.noWrap, true);
    for (const [key, value] of Object.entries(options)) assert.deepEqual(layer.options[key], value);
    assert.equal(layer.options.url.url, '/basemap/' + name + '.pmtiles');
  }
  assert.equal(Object.hasOwn(baselayers[0].options, 'minZoom'), false);
  assert.equal(basemaps[0].maxZoom, 6);
  assert.equal(baselayers[0].options.maxZoom, 6);
  assert.equal(basemaps[6].minZoom, 7);
  assert.equal(baselayers[6].options.minZoom, 7);
  assert.deepEqual(baselayers.slice(1).map(layer => layer.options.minZoom), [7, 7, 7, 7, 7, 7, 10, 11]);
});

test('R1 focus outline suppression is scoped to interactive map SVG paths', async () => {
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#route-map path\.leaflet-interactive:focus\s*\{\s*outline:\s*none;\s*\}/);
});

test('R1b scale overrides stay scoped to the map with bounded responsive sizes and readable fonts', async () => {
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  const marker = '/* MAP-R1b: map page scale (PO 2026-10-09) */';
  assert.equal(css.split(marker).length, 2, 'one appended scale block');
  const block = css.split(marker)[1].split('/* RM13:')[0].replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => !selector.trim().startsWith('@media'));
  assert.ok(rules.length > 10);
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
  assert.match(block, /\.map-page \{ max-width: none; font-size: var\(--fs-16\);/);
  assert.match(block, /\.map-page #route-map \{ height: 78vh; min-height: 480px;/);
  assert.match(block, /\.map-page \.map-routes \{ max-height: 360px;/);
  assert.match(block, /@media \(max-width: 750px\)\s*\{\s*\.map-page #route-map \{ height: 60vh; min-height: 360px;/);
  assert.match(block, /@media \(min-width: 751px\)\s*\{\s*\.map-page > \.snapshot \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
  assert.match(block, /\.map-page > \.snapshot:hover, \.map-page > \.snapshot:focus-within \{ white-space: normal;/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 280px/);
  for (const [selector, size] of [
    ['.map-sidebar .map-route-name', 15], ['.map-sidebar .map-summary-metrics dd', 19],
    ['.map-sidebar .map-zip-info dd', 14], ['.map-sidebar .map-summary-updated', 13],
    ['.map-page .leaflet-tooltip dd', 15], ['.map-page .leaflet-tooltip dt', 13],
    ['.map-page .warehouse-popup dt', 13],
  ]) {
    const declarations = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) => selectors.trim() === selector).map(([, , body]) => body).join(' ');
    const fixedMapText = /leaflet|warehouse-popup/.test(selector);
    assert.ok(declarations.includes(fixedMapText ? 'font-size: ' + size + 'px;' : 'font-size: var(--fs-' + size + ');'), selector);
  }
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
    const check = (dimmed, selected = [false, false], outside = [false, false]) => {
      routeMarkers.slice(-2).forEach((marker, index) => {
        assert.equal(labelVisible(marker), !outside[index]);
        assert.equal(marker.node.classList.contains('route-label--dimmed'), dimmed[index]);
        assert.equal(marker.node.classList.contains('route-label--selected'), selected[index]);
        assert.equal(layers[index].styles.at(-1).fillOpacity,
          outside[index] ? POLYGON_STYLE.outside.fillOpacity : dimmed[index] ? POLYGON_STYLE.dimmed.fillOpacity
            : selected[index] ? POLYGON_STYLE.selectedRoute.fillOpacity : POLYGON_STYLE.focused.fillOpacity);
      });
    };
    check([false, false], [false, false], [false, true]);
    // Beta reverses the match, then removing station focus isolates the DSP filter.
    view.setDsp('Beta'); check([true, false], [false, false], [false, true]);
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
  assert.match(css, /\.route-label > span \{[^}]*background: rgba\(10,16,30,.62\);[^}]*padding: 0 6px;[^}]*border-radius: 999px;[^}]*box-shadow: none;/);
  assert.match(css, /\.route-label--selected > span \{[^}]*padding: 1px 6px;[^}]*border-radius: 999px;[^}]*box-shadow: 0 0 0 1.5px #fff;/);
  assert.doesNotMatch(labelRules, /\.route-label[^{}]*> span\s*\{[^}]*opacity:/);
  assert.match(css, /\.route-label--selected > span \{[^}]*font-size: 18px;[^}]*line-height: 22px;[^}]*font-weight: 700;[^}]*color: #ffffff;[^}]*background: rgba\(10,16,30,.9\);/);
  assert.match(css, /\.route-label\.route-label--dimmed \{ opacity: \.35; \}/);
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
  map.latLngToContainerPoint = ([lat, lng]) => ({ x: edge ? 11 : 200 + (lng > 5 ? 32 : 0), y: 200 });
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
  assert.match(css, /\.route-label \{[^}]*font-weight: 600;[^}]*color: #ffffff;[^}]*opacity: 1;/);
  assert.match(css, /\.route-label > span \{[^}]*line-height: 22px;/);
  assert.equal(ROUTE_LABEL.widthPadding, 12);
  assert.equal(ROUTE_LABEL.selectedWidthPadding, 15);
  assert.deepEqual(ROUTE_LABEL.tiers.map(t => [t.name, t.characterWidth, t.height, t.padding, t.selectedCharacterWidth, t.selectedHeight]), [
    ['far', 8.5, 18, 16, 10.5, 26], ['mid', 9, 20, 5, 10.5, 26], ['near', 9.5, 22, 2, 11, 26],
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
  assert.match(source, /panel.render\(data, \{ focusStation: station, routeColors, groupColors \}\)/);
  assert.match(source, /view.render\(data, \{ fitToStation: true, focusStation: station, routeColors, groupColors \}\)/);
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  // Focused and dimmed labels inherit the normal capsule colors.
  assert.doesNotMatch(css, /\.route-label(?:--focused|\.route-label--dimmed)\s*(?:> span)?\s*\{[^}]*(?:color|background):/);
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

test('RM12 All Stations gives every route label focused priority', async () => {
  const { view, data, routeMarkers } = await labelFixture();
  view.render(data, { focusStation: null });
  assert.ok(routeMarkers.length > 0);
  for (const marker of routeMarkers)
    assert.ok(marker.node.classList.contains('route-label--focused'));
});


test('MVR filter is scoped to the basemap tile pane, with an unfiltered ocean background', async () => {
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  const block = css.split('/* MVR */')[1];
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.deepEqual(rules.filter(([, , body]) => /(?:^|;)\s*filter:/.test(body)).map(([, selector]) => selector.trim()),
    ['.map-page .leaflet-tile-pane']);
  assert.match(block, /filter: none/);
  assert.match(block, /\.map-page #route-map \{ background: #93dde5;/);
  const grid = await fs.readFile(new URL('../../node_modules/leaflet/src/layer/tile/GridLayer.js', import.meta.url), 'utf8');
  assert.match(grid, /pane: 'tilePane'/);
  const view = await fs.readFile(new URL('../../web/map-view.js', import.meta.url), 'utf8');
  const options = view.match(/protomaps.leafletLayer\(\{([^}]+)\}/)[1];
  assert.ok(!options.includes('pane:')); // Protomaps inherits GridLayer's tilePane.
  const { map, groups, view: instance, data, routeMarkers } = await labelFixture();
  instance.render(data, { fitToStation: false });
  assert.equal(groups.at(-1).options.pane, undefined); // GeoJSON uses overlayPane.
  assert.ok(routeMarkers.every(marker => marker.options.pane === 'route-labels'));
  assert.equal(map.panes['selection-outline'].style.zIndex, '450');
});


test('MVR outside labels hide during route selection and return in overview; mixed membership stays visible', async () => {
  const { view, map, data, routeMarkers } = await labelFixture();
  map.latLngToContainerPoint = ([lat, lng]) => ({ x: 200 + lng * 30, y: 200 });
  view.render(data, { fitToStation: false, focusStation: 'A' });
  view.applySelection(selectRoute({ route_id: 1, station: 'A' }));
  assert.equal(labelVisible(routeMarkers[0]), true);
  assert.equal(labelVisible(routeMarkers[1]), false);
  view.applySelection(selectRoute({ route_id: 2, station: 'B' }));
  assert.equal(labelVisible(routeMarkers[1]), true); // Explicit selection wins over outside.
  view.render(data, { fitToStation: false });
  assert.ok(routeMarkers.slice(-2).every(labelVisible));
  const mixed = structuredClone(data.features.features[1]);
  mixed.properties.station = 'A';
  data.features.features.push(mixed);
  view.render(data, { fitToStation: false, focusStation: 'A' });
  assert.ok(routeMarkers.slice(-2).every(labelVisible)); // Only all-outside members hide a route label.
});


test('MVR-T3 route legend counts mapped routes by station and DSP, deduplicates and hides without features', async () => {
  const { mapText: t } = await import('../../web/map-text.js');
  assert.equal(t.legendRouteCount(2), '2 条线路 · 颜色对应右侧列表');
  assert.deepEqual(t.legendRouteStates, ['选中', '当前范围', '其他']);
  const { view, data, controls } = await labelFixture();
  const legend = controls.at(-1);
  assert.equal(legend.hidden, true);
  view.setColorMode('difficulty'); assert.equal(legend.hidden, true);
  view.setColorMode('route');
  data.features.features.push(structuredClone(data.features.features[0]));
  const check = count => {
    assert.equal(legend.hidden, false);
    assert.equal(legend.children[0].textContent, t.byRoute);
    assert.equal(legend.children[1].textContent, t.legendRouteCount(count));
    assert.deepEqual(legend.children.slice(2).map(row => row.children[1].textContent), t.legendRouteStates);
    const states = ['selectedRoute', 'focused', count === 2 ? 'dimmed' : 'outside'];
    legend.children.slice(2).forEach((row, index) => {
      assert.equal(row.children[0].children[0].style.backgroundColor, `rgba(${palette[0].slice(1).match(/../g).map(value => parseInt(value, 16)).join(', ')}, ${POLYGON_STYLE[states[index]].fillOpacity})`);
      assert.equal(row.children[0].className, 'map-legend-sample');
      assert.equal(row.children[0].children[0].style.border, `${POLYGON_STYLE[states[index]].weight}px solid rgba(10, 16, 30, ${POLYGON_STYLE[states[index]].opacity})`);
    });
  };
  view.render(data, { focusStation: null }); check(2);
  assert.equal(legend.children[4].children[0].children[0].style.backgroundColor, `rgba(${palette[0].slice(1).match(/../g).map(value => parseInt(value, 16)).join(', ')}, ${POLYGON_STYLE.dimmed.fillOpacity})`);
  view.render(data, { focusStation: 'A' }); check(1);
  assert.equal(legend.children[4].children[0].children[0].style.backgroundColor, `rgba(${palette[0].slice(1).match(/../g).map(value => parseInt(value, 16)).join(', ')}, ${POLYGON_STYLE.outside.fillOpacity})`);
  view.setDsp('Beta'); check(0);
  view.render(data, { focusStation: 'B' }); check(1);
  view.setDsp(null); check(1);
  view.applySelection(selectRoute(1)); check(1);
  view.setColorMode('difficulty');
  assert.equal(legend.hidden, false);
  assert.equal(legend.children[0].textContent, t.legendZip(undefined));
  assert.deepEqual(legend.children.slice(1).map(row => row.children[1].textContent), t.legendItems);
  view.clear(); assert.equal(legend.hidden, true);
  view.setColorMode('route'); assert.equal(legend.hidden, true);
  view.render({ routes: [], features: { type: 'FeatureCollection', features: [] } });
  assert.equal(legend.hidden, true);
});

test('MVR-T3 sidebar search does not change route legend count', async () => {
  const { page, controls, elements: e, replies, reply } = await fixture();
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, payload()));
  await page.start();
  const legend = controls[2], count = legend.children[1].textContent;
  e['map-search'].value = 'no matching route'; await e['map-search'].listeners.input();
  assert.equal(e['map-no-match'].hidden, false);
  assert.equal(legend.children[1].textContent, count);
});


test('MVR-T3 legend CSS scopes the translucent panel and compacts states on narrow screens', async () => {
  const css = (await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8')).split('/* MVR */')[1];
  assert.match(css, /background: rgba\(10,16,30,\.86\)/);
  assert.match(css, /border: 1px solid rgba\(255,255,255,\.12\)/);
  assert.match(css, /backdrop-filter: blur\(4px\)/);
  assert.match(css, /max-width: calc\(100vw - 64px\)/);
  assert.match(css, /width: 18px; height: 12px;[^}]*background: #e9e4d8; border-radius: 3px/);
  assert.match(css, /width: 10px; height: 10px; border-radius: 50%/);
  assert.match(css, /@media \(max-width: 450px\)[\s\S]*margin-bottom: 32px/);
  assert.match(css, /\.map-page \.map-legend \.map-legend-state \{ display: none;/);
});


test('MVR-T5 group modes share map, tooltip, list and legend colors and hide labels', async () => {
  const { assignGroupColors, dspColorKey, modeColor } = await import('../../web/map-state.js');
  const { view, data, groups, controls, routeMarkers } = await labelFixture();
  const features = data.features.features;
  const groupColors = { dsp: assignGroupColors(features, p => dspColorKey(p.dsp_name)),
    station: assignGroupColors(features, p => p.station) };
  const { createMapPanel } = await import('../../web/map-panel.js');
  const { doc, elements: e } = await fixture();
  const panel = createMapPanel({ document: doc, onRoute() {}, onClear() {}, onSearch() {} });
  const routes = [...new Map(features.map(f => [f.properties.route_id, { ...f.properties, zip_count: 1 }])).values()];
  const panelData = { ...payload(), routes };
  panel.render(panelData, { groupColors });
  view.render(data, { groupColors });
  const legend = controls.at(-1);
  for (const mode of ['dsp', 'station']) {
    view.setColorMode(mode); panel.setColorMode(mode);
    assert.ok(routeMarkers.every(marker => !labelVisible(marker)));
    for (const layer of groups.at(-1).layers) {
      const p = layer.feature.properties, color = modeColor(p, mode, undefined, groupColors);
      assert.equal(layer.styles.at(-1).fillColor, color);
      assert.equal(layer.tooltip.children[0].children[0].children[0].style.backgroundColor, color);
      const row = e['map-routes'].children.find(row => row.className === 'map-route'
        && row.children[1].textContent === p.route_name);
      assert.equal(row.children[0].style.backgroundColor, color);
      assert.ok(legend.children[1].children.some(row => row.children[0].style.backgroundColor === color));
    }
    assert.ok(legend.children[1].children.every(row => Boolean(row.listeners.click) === (mode === 'dsp')));
    const p = features[0].properties;
    view.setDsp(p.dsp_name);
    assert.equal(legend.children[1].children.length, mode === 'dsp' ? 2 : 1);
    view.setDsp(null);
    view.render(data, { focusStation: p.station, groupColors });
    assert.ok(legend.children[1].children.length > 0);
    view.render(data, { groupColors });
  }
});

test('MVR-T6 legend shares DSP dropdown changes, toggles, retains alternatives and rejects ambiguous names', async () => {
  const { elements: e, page, replies, reply, controls, groups } = await fixture();
  const data = payload();
  data.routes.forEach((route, i) => route.dsp_name = i ? 'MOCK-BBB' : 'MOCK-AAA');
  data.features.features.forEach(feature => feature.properties.dsp_name = data.routes.find(route => route.route_id === feature.properties.route_id).dsp_name);
  data.features.features.push({ ...data.features.features[0], properties: { ...data.features.features[0].properties, ...data.routes[1], postal_code: '99999' } });
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, data));
  await page.start(); controls[1].children[1].listeners.click();
  const rows = () => controls[2].children[1].children;
  const row = key => rows().find(row => row.children[1].textContent.startsWith(key));
  const count = rows().length;
  assert.equal(row('AAA').tagName, 'button');
  groups[0].layers.find(layer => layer.feature.properties.dsp_name === 'MOCK-BBB').listeners.click({});
  row('AAA').listeners.click();
  assert.equal(e['map-dsp'].value, 'MOCK-AAA');
  assert.equal(e['map-summary-panel'].hidden, true); // RM7-5 clears incompatible selection.
  assert.equal(rows().length, count);
  assert.equal(row('AAA').attributes['aria-pressed'], 'true');
  assert.ok(e['map-routes'].children.filter(node => node.className === 'map-route').every(node => node.children[1].textContent === data.routes[0].route_name));
  row('AAA').listeners.click(); assert.equal(e['map-dsp'].value, '');
  row('BBB').listeners.click(); assert.equal(e['map-dsp'].value, 'MOCK-BBB');
  e['map-dsp'].value = 'MOCK-AAA'; e['map-dsp'].listeners.change();
  assert.equal(row('AAA').attributes['aria-pressed'], 'true');

  const f = await labelFixture();
  f.data.features.features.forEach((feature, i) => feature.properties.dsp_name = i ? 'B-AAA' : 'A-AAA');
  const changes = [];
  const view = createMapView({ leaflet: f.leaflet, document: f.doc, onDsp: value => changes.push(value) });
  view.render(f.data); view.setColorMode('dsp');
  const ambiguous = f.controls.at(-1).children[1].children[0];
  assert.equal(ambiguous.attributes['aria-disabled'], 'true');
  assert.equal(ambiguous.title, '该公司在多个站点，请先选择站点');
  ambiguous.listeners.click(); assert.deepEqual(changes, []);
  view.render(f.data, { focusStation: 'A' });
  const unique = f.controls.at(-1).children[1].children[0];
  assert.equal(unique.attributes['aria-disabled'], 'false'); unique.listeners.click();
  assert.deepEqual(changes, ['A-AAA']);
});

test('MVR-T6 DSP list groups sort ZIP totals, code ties and route names; search and selection survive mode changes', async () => {
  const { createMapPanel } = await import('../../web/map-panel.js');
  const { doc, elements: e } = await fixture(); const selected = [];
  const panel = createMapPanel({ document: doc, onRoute: id => selected.push(id), onClear() {}, onSearch() {} });
  const data = payload();
  data.routes = [
    { route_id: 1, route_name: 'Z', dsp_name: 'S-BBB', zip_count: 2 },
    { route_id: 2, route_name: 'A', dsp_name: 'S-BBB', zip_count: 3 },
    { route_id: 3, route_name: 'C', dsp_name: 'S-AAA', zip_count: 5 },
    { route_id: 4, route_name: 'D', dsp_name: null, zip_count: 1 },
  ];
  panel.render(data, { focusStation: null }); panel.setColorMode('dsp');
  const nodes = () => e['map-routes'].children;
  assert.deepEqual(nodes().filter(n => n.tagName === 'h3').map(n => allText(n).trim()), ['AAA · 1 条线路', 'BBB · 2 条线路', '未分配 · 1 条线路']);
  assert.deepEqual(nodes().filter(n => n.className === 'map-route').map(n => n.children[1].textContent), ['C', 'A', 'Z', 'D']);
  assert.ok(nodes().filter(n => n.tagName === 'h3').every(n => !n.listeners.click));
  panel.applySelection(selectRoute(data.routes[0]));
  const current = nodes().find(n => n.attributes['aria-pressed'] === 'true');
  assert.deepEqual(current.scrolled, { block: 'nearest' }); current.listeners.click(); assert.deepEqual(selected, [1]);
  e['map-search'].value = 'A'; e['map-search'].listeners.input();
  assert.equal(nodes().filter(n => n.className === 'map-route').length, 1);
  e['map-search'].value = 'missing'; e['map-search'].listeners.input(); assert.equal(e['map-no-match'].hidden, false);
  e['map-search'].value = ''; e['map-search'].listeners.input();
  for (const mode of ['route', 'station', 'difficulty']) { panel.setColorMode(mode); assert.ok(nodes().every(n => n.className === 'map-route')); }
});

test('MVR-T6 transitions opt in on mode change, stop immediately on hover and respect reduced motion', async () => {
  const { view, data, groups } = await labelFixture(); view.render(data);
  const layer = groups.at(-1).layers[0]; const classes = new Set();
  layer.getElement = () => ({ classList: { add: value => classes.add(value), remove: value => classes.delete(value) } });
  view.setColorMode('dsp'); assert.ok(classes.has('mvr-mode-transition'));
  layer.listeners.mouseover(); assert.equal(classes.size, 0);
  view.setColorMode('station'); assert.equal(classes.size, 0);
  layer.listeners.mouseout(); assert.equal(classes.size, 0);
  view.setColorMode('route'); assert.ok(classes.has('mvr-mode-transition'));
  await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(classes.size, 0);
  const css = await fs.readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.map-page \.leaflet-overlay-pane path\.mvr-mode-transition \{ transition: fill \.2s, fill-opacity \.2s; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.map-page \.leaflet-overlay-pane path\.mvr-mode-transition \{ transition: none; \}/);
});


test('MAP-FIX clears hover and tooltips, suppresses drag/zoom and deferred opens, then restores entry', async () => {
  for (const [start, end] of [['dragstart', 'dragend'], ['zoomstart', 'zoomend']]) {
    const { view, map, data, groups } = await labelFixture();
    view.render(data, { fitToStation: false });
    const [a, b] = groups.at(-1).layers;
    const base = polygonStyle(b.feature.properties, undefined, 'route', null, null);
    b.listeners.mouseover(); b.openTooltip();
    assert.deepEqual(b.styles.at(-1), hoverStyle(base));
    map.listeners[start]();
    assert.equal(b.tooltipOpen, false); assert.ok(a.tooltipCloses);
    assert.deepEqual(b.styles.at(-1), base);
    const classes = new Set();
    b.getElement = () => ({ classList: { add: c => classes.add(c), remove: c => classes.delete(c) } });
    view.setColorMode('station');
    assert.ok(classes.has('mvr-mode-transition'), 'cleared hoveredLayers allows mode transition');
    const count = b.styles.length;
    b.listeners.mouseover(); b.openTooltip();
    assert.equal(b.styles.length, count); assert.equal(b.tooltipOpen, false);
    map.listeners[end]();
    b.openTooltip(); assert.equal(b.tooltipOpen, false, 'deferred Leaflet open stays blocked after end');
    b.listeners.mouseover();
    assert.equal(b.tooltipOpen, true);
    assert.deepEqual(b.styles.at(-1), hoverStyle(polygonStyle(b.feature.properties, undefined, 'station', null, null)));
    b.listeners.mouseout();
    assert.deepEqual(b.styles.at(-1), polygonStyle(b.feature.properties, undefined, 'station', null, null));
    view.applySelection(selectRoute(data.features.features[0].properties));
    // Select a ZIP to create the interactive highlight, which has its own tooltip.
    view.applySelection({ route: data.features.features[0].properties, zip: { ...data.features.features[0].properties, geometry: data.features.features[0].geometry } });
    const highlight = groups.filter(g => !g.options.pane).at(-1).layers[0];
    highlight.openTooltip(); map.listeners[start]();
    assert.equal(highlight.tooltipOpen, false);
    highlight.listeners.mouseover(); highlight.openTooltip(); assert.equal(highlight.tooltipOpen, false);
    map.listeners[end](); highlight.openTooltip(); assert.equal(highlight.tooltipOpen, false);
    highlight.listeners.mouseover(); assert.equal(highlight.tooltipOpen, true);
  }
});


function tileAt(lon, lat, z) {
  const n = 2 ** z, rad = lat * Math.PI / 180;
  return { z, x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * n) };
}

test('MVR P3 generated service bounds and light flavor keys match local sources', async () => {
  const config = JSON.parse(await fs.readFile(new URL('../../config/basemap-service-region.json', import.meta.url), 'utf8'));
  assert.equal(config.stations.length, 52);
  assert.deepEqual(SERVICE_BOUNDS, config.stations.map(station => station.bbox));
  const keys = object => Object.keys(object).sort();
  assert.deepEqual(keys(BASEMAP_FLAVOR), keys(namedFlavor('light')));
  assert.deepEqual(keys(BASEMAP_FLAVOR.landcover), keys(namedFlavor('light').landcover));
  assert.equal(BASEMAP_FLAVOR.water, '#93dde5');
  assert.equal(BASEMAP_FLAVOR.roads_label_minor_halo, '#ffffff');
  const service = basemaps.find(layer => layer.name === 'service');
  assert.equal(service.minZoom, 11); assert.equal(service.maxDataZoom, 14); assert.equal(service.levelDiff, 0);
  const boxes = SERVICE_BOUNDS;
  assert.deepEqual(service.bounds, [[Math.min(...boxes.map(b => b[1])), Math.min(...boxes.map(b => b[0]))],
    [Math.max(...boxes.map(b => b[3])), Math.max(...boxes.map(b => b[2]))]]);
});

test('MVR P3 service and regional tile ownership is exclusive, including overzoom and gaps', async () => {
  const calls = [], preflights = [];
  const { baselayers } = await fixture('', url => { preflights.push(url); return 206; }, null, {}, async (...args) => { calls.push(args); return { data: new ArrayBuffer(0) }; });
  const service = baselayers.at(-1), regional = baselayers[1];
  for (const z of [11, 12, 14, 15, 16]) {
    for (const [w,s,e,n] of SERVICE_BOUNDS) {
      const tile = tileAt((w+e)/2, (s+n)/2, z);
      assert.ok(service._isValidTile(tile));
      assert.equal(regional._isValidTile(tile), false);
    }
    for (const [lon,lat] of [[-140,35],[-110,39],[-124,40]]) {
      const tile = tileAt(lon,lat,z);
      assert.equal(service._isValidTile(tile), false);
      assert.ok(regional._isValidTile(tile));
    }
  }
  const outside = tileAt(-140,35,12);
  assert.equal(await service.options.url.getZxy(outside.z,outside.x,outside.y), undefined);
  assert.equal(calls.length,0);
  assert.ok(!preflights.includes('/basemap/service.pmtiles'));
  assert.equal(serviceTile(tileAt(-122,37,10)),null);
});

test('MVR P3 absent tiles are quiet and return ownership to regional fallback', async () => {
  const { elements: e, baselayers } = await fixture('',206,null,{},async () => undefined);
  const tile = tileAt(-122,37,14), service = baselayers.at(-1);
  assert.ok(service._isValidTile(tile));
  assert.equal(await service.options.url.getZxy(tile.z,tile.x,tile.y),undefined);
  assert.equal(service._isValidTile(tile),false);
  assert.ok(baselayers[1]._isValidTile(tile));
  assert.notEqual(e['map-basemap-message'].hidden,false);
  assert.equal(e['map-basemap-message'].textContent,'');
});

test('MVR P3 missing service archive preserves regional layers and route interactions', async () => {
  const { elements:e, baselayers, page, groups, replies, reply } = await fixture('',url => url.includes('/service.') ? 404 : 206);
  replies.push(reply(200,{stations:['MOCKA']}),reply(200,payload())); await page.start();
  assert.equal(baselayers.length,9);
  const tile = tileAt(-122,37,14);
  await baselayers.at(-1).options.url.getZxy(tile.z,tile.x,tile.y);
  assert.ok(baselayers[1]._isValidTile(tile));
  assert.equal(groups[0].layers.length,2);
  groups[0].layers[0].listeners.click({});
  assert.equal(e['map-zip-panel'].hidden,false);
});


test('MVR P3 service Range errors restore fallback while zoom cancellation remains abortable', async () => {
  let abort = true;
  const { baselayers, elements:e } = await fixture('',206,null,{},async () => {
    const error = new Error('synthetic failure'); error.name = abort ? 'AbortError' : 'Error'; throw error;
  });
  const tile = tileAt(-122,37,14), service = baselayers.at(-1);
  await assert.rejects(service.options.url.getZxy(tile.z,tile.x,tile.y), {name:'AbortError'});
  assert.ok(service._isValidTile(tile));
  assert.notEqual(e['map-basemap-message'].hidden,false);
  abort = false;
  assert.equal(await service.options.url.getZxy(tile.z,tile.x,tile.y),undefined);
  assert.equal(service._isValidTile(tile),false);
  assert.ok(baselayers[1]._isValidTile(tile));
  assert.equal(e['map-basemap-message'].hidden,false);
});
