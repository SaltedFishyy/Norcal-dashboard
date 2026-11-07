import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatPrice, formatPriceRange, sortRows } from '../../web/format.js';
import { openPriceDetail } from '../../web/price-detail.js';
import { zipDetails } from '../../web/map-view.js';
import { createMapPanel } from '../../web/map-panel.js';
import { isStaticPath } from '../src/api/static-files.js';

class Element {
  constructor(tag, doc) { this.tag = tag; this.ownerDocument = doc; this.children = []; this.listeners = {}; this.attributes = {}; this.style = {}; this.textContent = ''; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(...(child.fragment ? child.children : [child])); } }
  replaceChildren(...children) { this.children = []; this.textContent = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelector(tag) { return walk(this).slice(1).find(node => node.tag === tag); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 100, bottom: 100 }; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const allText = node => walk(node).map(n => n.textContent).join(' ');
function fixture(t) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const nodes = {};
  const doc = { createElement: tag => new Element(tag, doc),
    createDocumentFragment: () => Object.assign(new Element('fragment', doc), { fragment: true }),
    getElementById: id => walk(doc.body).find(node => node.id === id) || nodes[id] };
  doc.body = new Element('body', doc);
  globalThis.document = doc;
  t.after(() => { globalThis.document = previous.document; globalThis.fetch = previous.fetch; });
  return { doc, nodes, add: id => nodes[id] = new Element('div', doc) };
}
const route = { route_id: 123, route_name: 'MOCK-001', station: 'MOCKA' };
const data = () => ({ ...route,
  weight_bands: Array.from({ length: 7 }, (_, i) => ({ code: `band${i}`, label_zh: `API label ${i}` })),
  groups: [{ postal_codes: ['00123', '00987'], fleet_name: '<mock>', effective_from: '2026-11-01', end_date: null,
    quotation_date: null, remarks: null, first: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`band${i}`, i + 1])),
    additional: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`band${i}`, i + .5])) }],
  unquoted_postal_codes: ['00001'], extra_quoted_postal_codes: ['00002'],
  upcoming: [{ effective_from: '2026-12-01', postal_codes: ['00123', '00987'] }], updated_at: '2026-11-01T12:00:00Z',
});
const reply = (status, body) => ({ status, json: async () => body });

test('RQ-T3 USD formatting and stable price sort preserve missing values at the end', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '1', false]) assert.equal(formatPrice(value), '—');
  assert.equal(formatPrice(0), '$0.00'); assert.equal(formatPrice(1.75), '$1.75');
  assert.equal(formatPriceRange(null, null), '—'); assert.equal(formatPriceRange(1.75, 1.75), '$1.75');
  assert.equal(formatPriceRange(1.75, 1.95), '$1.75–$1.95');
  assert.equal(formatPriceRange(null, 2), '$2.00'); assert.equal(formatPriceRange(2, undefined), '$2.00');
  const rows = [null, 2, 1, 2, undefined].map((value, id) => ({ id, current_first_0_1lb_price_min: value }));
  assert.deepEqual(sortRows(rows, { key: 'price', dir: 'asc' }).map(r => r.id), [2, 1, 3, 0, 4]);
  assert.deepEqual(sortRows(rows, { key: 'price', dir: 'desc' }).map(r => r.id), [1, 3, 2, 0, 4]);
  assert.deepEqual(rows.map(r => r.id), [0, 1, 2, 3, 4]);
});

test('RQ-T3 shared dialog renders API bands, metadata, highlights, notices and closes accessibly', async t => {
  const { doc } = fixture(t), source = doc.createElement('button'), urls = [];
  globalThis.fetch = async url => { urls.push(url); return reply(200, data()); };
  await openPriceDetail(route, source, { highlightZip: '00123' });
  const dialog = doc.body.children[0], nodes = walk(dialog), group = nodes.find(n => n.className === 'price-group price-group-highlight');
  assert.deepEqual(urls, ['/api/route-quotations?route_id=123']);
  assert.equal(dialog.open, true); assert.equal(group.scrolled, true);
  assert.equal(nodes.find(n => n.attributes['aria-live']).attributes['aria-busy'], 'false');
  const body = nodes.find(n => n.tag === 'tbody'); assert.equal(body.children.length, 7);
  assert.deepEqual(body.children[0].children.map(n => n.textContent), ['API label 0', '$1.00', '$0.50']);
  assert.match(allText(dialog), /\u957f\u671f\u6709\u6548/);
  assert.doesNotMatch(allText(dialog), /Quotation Date/);
  assert.match(allText(dialog), /适用 ZIP 00123, 00987/);
  assert.ok(!nodes.some(n => n.textContent === '备注'));
  for (const value of ['<mock>', '无当前报价的 ZIP：00001', '报价中有、DMS 当前不在此线路的 ZIP：00002', '下次生效：2026-12-01（2 个 ZIP）', '报价更新于']) assert.ok(allText(dialog).includes(value));
  nodes.find(n => n.tag === 'button').listeners.click(); assert.equal(dialog.open, false); assert.equal(source.focused, true);
  await openPriceDetail(route, source); assert.equal(doc.body.children.length, 1);
  let prevented = false; dialog.listeners.cancel({ preventDefault() { prevented = true; } }); assert.ok(prevented); assert.equal(dialog.open, false);
  await openPriceDetail(route, source);
  dialog.listeners.click({ target: dialog, clientX: 50, clientY: 50 }); assert.equal(dialog.open, true);
  dialog.listeners.click({ target: dialog, clientX: 0, clientY: 0 }); assert.equal(dialog.open, false);
});

test('RQ-T3 dialog empty/error/network/retry states and stale requests', async t => {
  const { doc } = fixture(t), source = doc.createElement('button');
  const empty = data(); empty.groups = [];
  globalThis.fetch = async () => reply(200, empty); await openPriceDetail(route, source);
  assert.match(allText(doc.body), /该线路暂无报价.*无当前报价的 ZIP.*下次生效/);
  for (const [status, code, expected] of [[404, 'route_not_found', '该线路不在当前 DMS 数据中'], [503, 'data_source_unavailable', '报价数据暂不可用'], [400, 'invalid_route_id', 'invalid_route_id'], [500, '/private/secret', 'internal_error']]) {
    globalThis.fetch = async () => reply(status, { error: code }); await openPriceDetail(route, source);
    assert.ok(allText(doc.body).includes(expected)); assert.ok(!allText(doc.body).includes('/private/secret'));
    assert.ok(walk(doc.body).some(n => n.textContent === '重试'));
  }
  globalThis.fetch = async () => { throw Error('private'); }; await openPriceDetail(route, source);
  assert.match(allText(doc.body), /server_unreachable/);
  globalThis.fetch = async () => reply(200, empty);
  await walk(doc.body).find(n => n.textContent === '重试').listeners.click(); assert.match(allText(doc.body), /该线路暂无报价/);
  let release; globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const old = openPriceDetail(route, source);
  globalThis.fetch = async () => reply(200, empty); await openPriceDetail({ ...route, route_name: 'NEW' }, source);
  release(reply(200, data())); await old; assert.match(allText(doc.body), /NEW · 价格详情.*该线路暂无报价/);
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const closed = openPriceDetail(route, source); doc.body.children[0].close();
  release(reply(200, data())); await closed; assert.match(allText(doc.body), /加载中/);
});

test('RQ-T3 profile price column after PPH renders single/range/missing and requests quotations only for quoted rows', async t => {
  const { doc, add, nodes } = fixture(t);
  for (const id of ['updated', 'total', 'rows', 'table-container', 'message', 'retry', 'profiles', 'profile-station', 'profile-district']) add(id);
  const rows = [[1.75, 1.75, 1], [1.75, 1.95, 2], [null, null, 0], [null, null, null]].map(([min, max, count], i) => ({ ...route, route_id: i + 1, quoted_zip_count: count, current_first_0_1lb_price_min: min, current_first_0_1lb_price_max: max }));
  const urls = [];
  globalThis.fetch = async url => { urls.push(url); return reply(200, url === '/api/districts' ? { districts: [{ id: 'mock', stations: [{ code: 'MOCKA', has_snapshot: true }] }] } : url.includes('route-profiles') ? { rows, total: 4 } : data()); };
  await import('../../web/app.js?rq-t3'); await new Promise(resolve => setImmediate(resolve));
  for (const row of nodes.rows.children) assert.equal(row.children.length, 7);
  const cells = nodes.rows.children.map(row => row.children[4]);
  assert.equal(cells[0].children[0].textContent, '$1.75'); assert.equal(cells[1].children[0].textContent, '$1.75–$1.95');
  for (const cell of cells.slice(2)) { assert.equal(cell.textContent, '—'); assert.equal(cell.children.length, 0); }
  await cells[0].children[0].listeners.click(); assert.ok(urls.includes('/api/route-quotations?route_id=1'));
  assert.equal(doc.body.children[0].open, true);
});

test('RQ-T3 map tooltip and route/ZIP panels use their own prices and share highlighted details', async t => {
  const { doc, add, nodes } = fixture(t);
  const tooltip = zipDetails(doc, { postal_code: '00123', current_first_0_1lb_price: 1.75 });
  assert.deepEqual(tooltip.children.at(-1).children.map(n => n.textContent), ['首票价格', '$1.75']);
  for (const id of ['search', 'routes', 'no-match', 'search-hint', 'clear', 'zip-heading', 'summary-heading', 'summary', 'summary-panel', 'selection', 'zip-panel']) add('map-' + id);
  const panel = createMapPanel({ document: doc });
  panel.applySelection({ route: { ...route, current_first_0_1lb_price_min: 1.75, current_first_0_1lb_price_max: 1.95, quoted_zip_count: 2 }, zip: { postal_code: '00123', status: 'covered', current_first_0_1lb_price: 1.75 } });
  assert.match(allText(nodes['map-summary']), /首票价格 \$1.75–\$1.95/);
  assert.match(allText(nodes['map-selection']), /首票价格 \$1.75/);
  globalThis.fetch = async () => reply(200, data());
  await walk(nodes['map-summary']).find(n => n.textContent === '价格详情').listeners.click();
  assert.ok(walk(doc.body).some(n => n.className === 'price-group price-group-highlight'));
  panel.applySelection({ route: null, zip: { status: 'multi_station', owners: [{ station: 'MOCKA', route_name: 'A', current_first_0_1lb_price: 2 }, { station: 'MOCKB', route_name: 'B', current_first_0_1lb_price: null }] } });
  assert.match(allText(nodes['map-selection']), /MOCKA · A · \$2.00.*MOCKB · B · —/);
  panel.applySelection({ route: { ...route, quoted_zip_count: 0 }, zip: null });
  assert.ok(!walk(nodes['map-summary']).some(n => n.textContent === '价格详情'));
});

test('RQ-T3 assets are allowlisted and frontend contains no HTML injection or external resources', async () => {
  assert.equal(isStaticPath('/price-detail.js'), true);
  for (const file of ['price-detail.js', 'app.js', 'map-panel.js', 'map-view.js']) {
    const source = await readFile(new URL(`../../web/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source.replaceAll('http://www.w3.org/2000/svg', ''), /innerHTML|insertAdjacentHTML|https?:\/\//);
  }
  const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  const head = html.match(/<thead>([\s\S]*?)<\/thead>/)[1];
  const labels = [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(([, content]) => content.replace(/<span[\s\S]*?<\/span>|<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').trim());
  assert.deepEqual(labels, ['线路名称', 'DSP', 'Pickup Volume', 'PPH', '首票价格', '首公里距离 (mi)', '线路难度']);
  assert.doesNotMatch(head, /人工难度/);
  assert.match(html, /title="首票价格 0–1\(lb\) \/ Quotation for the First Parcel 0–1\(lb\)"/);
});
