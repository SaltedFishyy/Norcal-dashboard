import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
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
    const current = e['map-current'].children[0];
    assert.deepEqual(current.children.map(row => row.children[0].textContent), ['站点', '线路', '邮编']);
    assert.equal(current.children[2].children[1].textContent, postalCode);
    assert.equal(current.children[2].children[1].children[0].textContent, badge);
    assert.equal(e['map-zip-panel'].hidden, false);
    assert.equal(e['map-summary-panel'].hidden, !status.startsWith('covered'));
    assert.equal(map.fits.length, beforeFits + (result.geometry ? 1 : 0));
    if (result.geometry) {
      const highlighted = groups.at(-2); // Last group is the geometry used solely to compute fit bounds.
      assert.equal(highlighted.front, true);
      assert.equal(highlighted.layers[0].styles[0].weight, 5);
      assert.equal(highlighted.layers[0].styles[0].color, '#db2777');
      if (status === 'uncovered') {
        assert.equal(highlighted.layers[0].styles[0].dashArray, '8 6');
        assert.equal(groups[0].layers[0].styles.at(-1).fillOpacity, 0.5);
      }
    }
    if (status === 'no_boundary') assert.match(e['map-selection'].children[1].textContent, /PO Box \/ 机构 ZIP/);
    if (status === 'covered_no_boundary') assert.match(e['map-selection'].children[1].textContent, /有线路覆盖 · 该 ZIP 暂无可用边界数据/);
  }
  e['map-search'].value = '023'; await e['map-search'].listeners.input();
  assert.equal(e['map-search-hint'].hidden, false);
  e['map-search'].value = '00009';
  replies.push(reply(200, lookupZip({ profiles: data, boundaries: boundary, postalCode: '00009' })),
    reply(200, buildRouteMap({ profiles: data, station: 'MOCKB', boundaries: boundary })));
  await e['map-search'].listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(e['map-station'].value, 'MOCKB'); assert.equal(e['map-search'].value, '00009');
  assert.equal(e['map-current'].children[0].children[1].children[1].textContent, 'Mock-C');
  // Switching Station for an owned ZIP without geometry must leave the viewport unchanged.
  data.stations.MOCKA.rows[0].postal_codes.push('00024');
  const beforeFits = map.fits.length;
  replies.push(reply(200, lookupZip({ profiles: data, boundaries: boundary, postalCode: '00024' })),
    reply(200, buildRouteMap({ profiles: data, station: 'MOCKA', boundaries: boundary })));
  await page.searchQuery('00024', true);
  assert.equal(e['map-station'].value, 'MOCKA');
  assert.equal(map.fits.length, beforeFits);
  assert.match(e['map-selection'].children[1].textContent, /该 ZIP 暂无可用边界数据/);
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
    const current = e['map-current'].children[0].children[2].children[1].textContent;
    assert.equal(current, action === 'new-search' ? '10001' : '—');
  }
});

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.textContent = ''; this.listeners = {}; this.attributes = {}; this.style = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}

async function fixture(search = '', basemapStatus = 206) {
  const { createMapPage } = await import('../../web/map.js');
  const ids = ['route-map', ...['station', 'message', 'retry', 'content', 'selection', 'coverage',
    'missing', 'missing-empty', 'regenerate', 'source', 'updated', 'search', 'routes', 'no-match', 'clear', 'summary', 'zip-panel', 'coverage-count', 'missing-details', 'missing-title', 'snapshot-source', 'basemap-message', 'current', 'search-hint', 'search-message', 'summary-panel'].map(id => `map-${id}`)];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const doc = { querySelectorAll: () => [], listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, getElementById: id => elements[id], createElement: tag => new Element(tag) };
  const map = { listeners: {}, fits: [], removed: [], attributionControl: {
    setPrefix(value) { this.prefix = value; }, addAttribution(value) { this.text = value; },
  }, setView() {}, on(name, fn) { this.listeners[name] = fn; }, removeLayer(layer) { this.removed.push(layer); },
  fitBounds(bounds, options) { this.fits.push({ bounds, options }); } };
  const groups = [];
  const controls = [], baselayers = [];
  const leaflet = { control: () => ({ addTo() { controls.push(this.onAdd()); } }),
    featureGroup: layers => ({ getBounds: () => ({ isValid: () => layers.length > 0 }) }),
    map: (element, options) => { map.options = options; return map; }, DomEvent: { disableClickPropagation() {}, stopPropagation(event) { event.stopped = true; } },
    geoJSON(features, options = {}) {
      if (features.type === 'Feature') features = { type: 'FeatureCollection', features: [features] };
      const group = { layers: [], addTo() { return this; },
        bringToFront() { this.front = true; }, getBounds: () => ({ isValid: () => features.features.length > 0 }) };
      for (const feature of features.features) {
        const layer = { feature, options: {}, styles: [options.style?.(feature)],
          setStyle(value) { this.styles.push(value); },
          bindTooltip(value, options) { this.tooltip = value; this.tooltipOptions = options; },
          on(listeners) { this.listeners = listeners; } };
        options.onEachFeature?.(feature, layer); group.layers.push(layer);
      }
      groups.push(group); return group;
    } };
  leaflet.control.zoom = options => ({ addTo() { map.zoomTitles = options; } });
  const requests = [], replies = [];
  const page = createMapPage({ document: doc, leaflet, search, protomaps: {
    PmtilesSource: class { constructor(url) { this.p = { url, getZxy: async () => { throw new Error('mock archive unavailable'); } }; } },
    leafletLayer(options) {
    const layer = { options, on(name, fn) { this.error = fn; }, addTo() { baselayers.push(this); return this; } }; return layer;
  } }, fetch: async (url, options) => {
    if (url.startsWith('/basemap/')) return { status: basemapStatus, arrayBuffer: async () => Uint8Array.from([80,77,84,105,108,101,115,3]).buffer };
    requests.push({ url, options });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  } });
  const reply = (status, data) => ({ status, json: async () => data });
  await page.basemapReady;
  return { doc, controls, baselayers, elements, map, groups, page, requests, replies, reply };
}
const payload = () => buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() });

test('map DOM uses API coverage and missing rows, safe tooltip elements and persistent click selection', async () => {
  const { elements: e, page, map, groups, requests, replies, reply } = await fixture('?station=MOCKA');
  const data = payload(), malicious = '<img src=x onerror=alert(1)>';
  data.features.features.forEach(feature => feature.properties.route_name = malicious);
  data.missing[0].route_name = malicious;
  // Deliberately differ from the feature count: the UI must use API counts, not recompute them.
  data.coverage = { total: 269, mapped: 254, missing: 15, missing_no_zcta: 14, missing_not_checked: 1 };
  replies.push(reply(200, { stations: ['MOCKA', 'MOCKB'] }), reply(200, data));
  await page.start();
  assert.equal(e['map-station'].value, 'MOCKA'); assert.equal(e['map-station'].disabled, false);
  assert.deepEqual(requests.map(item => item.url), ['/api/route-map/stations', '/api/route-map?station=MOCKA']);
  assert.ok(requests.every(item => item.options.cache === 'no-store'));
  assert.equal(e['map-coverage'].textContent, '94.42%');
  assert.equal(e['map-regenerate'].textContent, '14 无 Census ZCTA · 1 需重新生成边界');
  assert.equal(e['map-regenerate'].hidden, false);
  assert.equal(e['map-missing'].children.length, data.missing.length);
  assert.deepEqual(e['map-missing'].children.map(row => row.children.map(cell => cell.textContent)), [
    ['00004', malicious, '无 Census ZCTA'], ['00005', 'Mock-B', '边界数据未覆盖（需重新生成）'],
  ]);
  assert.equal(map.fits.length, 1);
  assert.equal(map.attributionControl.prefix, undefined);
  assert.equal(map.attributionControl.text, 'Boundaries: US Census 2020 ZCTA');
  const [layer, sameRoute] = groups[0].layers;
  assert.ok(layer.tooltip instanceof Element);
  assert.deepEqual(layer.tooltipOptions, { direction: 'auto', sticky: true });
  assert.equal(layer.tooltip.children[1].children[1].textContent, malicious);
  assert.equal(layer.styles[0].fillColor, routeColor(layer.feature.properties.route_id));
  assert.equal(layer.options.bubblingMouseEvents, false);
  layer.listeners.mouseover(); assert.equal(layer.styles.at(-1).weight, 3);
  layer.listeners.mouseout(); assert.equal(layer.styles.at(-1).weight, 1);
  const originalEvent = {}; layer.listeners.click({ originalEvent });
  assert.equal(originalEvent.stopped, true);
  const panel = e['map-selection'].children[0];
  assert.equal(panel.children[0].children[1].textContent, '00002');
  assert.equal(e['map-selection'].children[1].textContent.includes('有线路覆盖'), true);
  assert.equal(sameRoute.styles.at(-1).weight, 3);
  map.listeners.click();
  assert.equal(e['map-zip-panel'].hidden, true);
  assert.equal(layer.styles.at(-1).weight, 1);
  replies.push(reply(200, { ...payload(), station: 'MOCKB' })); e['map-station'].value = 'MOCKB';
  await e['map-station'].listeners.change();
  assert.equal(requests.at(-1).url, '/api/route-map?station=MOCKB');
  assert.equal(map.removed.length, 2);
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
  const empty = payload(); empty.features.features = []; empty.missing = [];
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
  replies.push(reply(200, { stations: [] })); await e['map-retry'].listeners.click();
  assert.match(e['map-message'].textContent, /没有站点快照/);
  replies.push(new Error('secret')); await e['map-retry'].listeners.click();
  assert.match(e['map-message'].textContent, /本地服务器/);
  replies.push(reply(200, { stations: ['MOCKA'] }), reply(200, payload())); await e['map-retry'].listeners.click();
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
  assert.deepEqual(baselayers.map(layer => layer.options.maxDataZoom), [6, 10, 14]);
  assert.ok(baselayers.every(layer => layer.options.flavor === 'light'));
  assert.deepEqual(baselayers.map(layer => layer.options.url.url), ['/basemap/us.pmtiles', '/basemap/norcal.pmtiles', '/basemap/ops.pmtiles']);
  assert.equal(baselayers[0].options.bounds, undefined);
  assert.deepEqual(baselayers[1].options.bounds, [[35.5, -124.6], [42.5, -119.0]]);
  assert.deepEqual(baselayers[2].options.bounds, [[36.43, -123.16], [39.01, -121.06]]);
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
  assert.equal(e['map-snapshot-source'].textContent, 'Source: DMS snapshot');
  assert.match(summary[3].textContent, /^更新时间 /);
  assert.equal(e['map-zip-panel'].hidden, true);
  controls[0].children[0].listeners.click(); assert.equal(map.fits.length, 3);
  assert.equal(e['map-routes'].children[0].attributes['aria-pressed'], 'true');
  doc.listeners.keydown({ key: 'Escape' }); assert.equal(e['map-clear'].disabled, true);
  search.value = 'mock'; search.listeners.input();
  search.listeners.keydown({ key: 'Enter', preventDefault() {} }); assert.equal(map.fits.length, 3);
  e['map-routes'].children[1].listeners.click();
  assert.equal(map.fits.length, 3); // Route B has no mapped polygons.
  assert.match(e['map-summary'].children[4].textContent, /暂无已上图边界/);
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
