import test from 'node:test';
import assert from 'node:assert/strict';
import { openRouteDetail, clearRouteDetail, summarizeMetric } from '../../web/route-detail.js';

const points = values => values.map((v, i) => ({ day: `2026-11-${String(i + 1).padStart(2, '0')}`, pph: v }));
test('RH-T2 metric summary skips null, uses latest known day, boundaries and zero', () => {
  assert.deepEqual(summarizeMetric(points([null]), 'pph'), { current: null, current_day: null, avg: null, max: null, min: null, trend: null });
  assert.equal(summarizeMetric(points([1, 2, null]), 'pph').current, 2);
  assert.equal(summarizeMetric(points([1, 2, null]), 'pph').current_day, '2026-11-02');
  for (const values of [[100, 95, 105], [100, 105, 95]]) assert.equal(summarizeMetric(points(values), 'pph').trend, 'flat');
  assert.equal(summarizeMetric(points([1, 2]), 'pph').trend, 'insufficient');
  assert.equal(summarizeMetric(points([0, 0, 0]), 'pph').trend, 'flat');
  assert.equal(summarizeMetric(points([-1, 0, 1]), 'pph').trend, 'insufficient');
  assert.deepEqual(summarizeMetric(points([1, 2, 3]), 'pph'), { current: 3, current_day: '2026-11-03', avg: 2, max: 3, min: 1, trend: { direction: 'up', pct: .5 } });
  assert.equal(summarizeMetric(points([3, 2, 1]), 'pph').trend.direction, 'down');
});
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.style = {}; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
  getBoundingClientRect() { return { left: 100, top: 0, width: 300, height: 88 }; }
  get offsetWidth() { return 100; }
  get offsetHeight() { return 50; }
  contains(node) { return all(this).includes(node); }
}
const all = node => [node, ...node.children.flatMap(all)];
const text = node => all(node).map(n => n.textContent).join(' ');
const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = data => ({ status: 200, json: async () => data });
function harness(t) {
  const oldDocument = globalThis.document, oldFetch = globalThis.fetch;
  const nodes = Object.fromEntries(['route-detail', 'detail-content', 'detail-title', 'detail-swatch', 'detail-difficulty', 'detail-summary', 'detail-close'].map(id => [id, new Element()]));
  const listeners = new Map();
  globalThis.document = { getElementById: id => nodes[id], createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn) };
  const calls = []; let history = () => reply({ available: false });
  globalThis.fetch = async url => { calls.push(url); return url.includes('route-details?') ? reply({ zips: [] }) : history(url); };
  t.after(() => { clearRouteDetail(); globalThis.document = oldDocument; globalThis.fetch = oldFetch; });
  return { nodes, calls, listeners, setHistory: fn => { history = fn; }, tabs: () => all(nodes['route-detail']).filter(n => n.attributes.role === 'tab'),
    history: () => all(nodes['route-detail']).find(n => n.id === 'detail-history') };
}
const route = { route_id: 900101, route_name: 'MOCK' };
test('DV selected overview date leaves the shared overview history window unchanged', async t => {
  const h = harness(t);
  await openRouteDetail(route, undefined, undefined, { date: '2026-11-08' });
  assert.ok(h.calls.includes('/api/route-details?route_id=900101&date=2026-11-08'));
  assert.match(text(h.nodes['detail-summary']), /11\/08 的数据/);
  await h.tabs()[1].onclick();
  assert.equal(h.calls.at(-1), '/api/route-history?route_id=900101&days=7');
});
function fixture() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const day = n => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  return { available: true, points: [4, 2, 1].map((n, i) => ({ day: day(n), pickup_volume: i * 100, pph: 20, first_mile_distance: i ? null : 3, zip_count: 2 })),
    changes: [{ day: day(2), field: 'route_difficulty', from: '3', to: '4' }, { day: day(1), field: 'dsp_name', from: '<A>', to: 'B' }, { day: day(1), field: 'zip_set', added: 1, removed: 0 }],
    first_seen: day(4), last_seen: day(1), latest_day: today, former_names: ['OLD-A', 'OLD-B'] };
}
test('RH-T2 lazy history, tabs and keyboard aria, periods, cards, SVG gaps and statuses', async t => {
  const h = harness(t), data = fixture(); h.setHistory(() => reply(data));
  await openRouteDetail(route);
  const tabs = h.tabs(); assert.equal(tabs[0].attributes['aria-selected'], 'true'); assert.equal(h.calls.length, 2);
  await tabs[0].onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(tabs[1].focused, true); assert.equal(tabs[1].attributes['aria-selected'], 'true');
  assert.equal(h.nodes['detail-content'].hidden, true);
  assert.match(h.calls[2], /days=7$/); assert.equal(h.calls.length, 3);
  const panel = h.history();
  for (const word of ['最近 7 天中有 3 天数据', '已有 3 天数据', '最近一次出现：', '曾用名：OLD-A、OLD-B', '领件量', '首公里距离 (mile)', 'ZIP 数量', '难度 3 → 4', 'DSP <A> → B', 'ZIP +1 / −0']) assert.ok(text(panel).includes(word), word);
  assert.equal(all(panel).filter(n => n.className === 'rh-card').length, 4);
  const charts = all(panel).filter(n => n.tag === 'svg'); assert.equal(charts.length, 4);
  assert.equal(all(charts[0]).filter(n => n.tag === 'polyline').length, 1); // day -4 isolated; -2/-1 connected
  assert.equal(all(charts[2]).filter(n => n.tag === 'circle').length, 1);
  assert.ok(all(charts[0]).some(n => n.attributes.class === 'rh-change-marker'));
  const periods = panel.children[0].children;
  await periods[1].listeners.click(); assert.equal(h.calls.filter(url => url.endsWith('days=30')).length, 1); assert.equal(periods[1].attributes['aria-pressed'], 'true');
  assert.equal(h.calls.length, 3); assert.match(text(panel), /最近 30 天中有 3 天数据/);
  h.setHistory(() => reply({ ...data, points: [...data.points, data.points[0]] }));
  await periods[0].listeners.click(); assert.match(h.calls.at(-1), /days=7$/);
  assert.equal(h.calls.length, 4); assert.match(text(panel), /最近 7 天中有 3 天数据/);
  const calls = h.calls.length; await tabs[0].onclick(); assert.equal(h.calls.length, calls);
  await tabs[1].onclick(); assert.equal(h.calls.length, calls);
  h.setHistory(() => reply({ ...data, points: [], changes: [] })); await periods[0].listeners.click(); assert.match(text(panel), /暂无历史数据/); assert.doesNotMatch(text(panel), /变化记录/);
  h.setHistory(() => reply({ available: false })); await periods[0].listeners.click(); assert.match(text(panel), /当前数据源不支持历史/);
  h.setHistory(() => { throw new Error('private'); }); await periods[0].listeners.click(); assert.match(text(panel), /无法加载线路历史/); assert.doesNotMatch(text(panel), /private/);
  await openRouteDetail(route); assert.equal(tabs[0].attributes['aria-selected'], 'true'); assert.equal(h.nodes['detail-content'].hidden, false);
});
test('RH-T2 stale period and clear/reselect responses cannot overwrite new view', async t => {
  const h = harness(t); await openRouteDetail(route);
  let release; h.setHistory(() => new Promise(resolve => { release = resolve; }));
  const pending = h.tabs()[1].onclick(); await tick(); assert.match(text(h.history()), /加载中/);
  h.setHistory(() => reply({ available: false })); await h.history().children[0].children[1].listeners.click();
  release(reply(fixture())); await pending; assert.match(text(h.history()), /当前数据源不支持历史/);
  h.setHistory(() => new Promise(resolve => { release = resolve; }));
  const next = h.history().children[0].children[0].listeners.click(); await tick();
  clearRouteDetail(); h.setHistory(() => reply({ available: false })); await openRouteDetail({ ...route, route_id: 900102 });
  h.setHistory(() => reply({ available: false })); await h.tabs()[1].onclick();
  release(reply(fixture())); await next; assert.match(text(h.history()), /当前数据源不支持历史/);
});

test('PL overview trends share summary rules and a single 30-day request with history', async t => {
  const h = harness(t);
  for (const [values, expected] of [[[100, 100, 100], '持平'], [[1, 2], '数据不足'], [[1, 2, 3], '↑ 50%'], [[3, 2, 1], '↓ 50%'], [[], '数据不足']]) {
    const data = { available: true, points: points(values).map(p => ({ ...p, pickup_volume: p.pph })), changes: [] };
    h.setHistory(() => reply(data)); await openRouteDetail(route); await tick();
    const overview = all(h.nodes['detail-content']);
    assert.deepEqual(overview.filter(n => n.className === 'rh-trend').map(n => [n.textContent, n.hidden]), [[expected, false], [expected, false]]);
    assert.equal(overview.filter(n => n.tag === 'svg').length, 2);
    const before = h.calls.length;
    await h.tabs()[1].onclick();
    await h.history().children[0].children[1].listeners.click();
    assert.equal(h.calls.length, before + 1, 'only 7-day history adds a request');
    if (values.length) assert.deepEqual(all(h.history()).filter(n => n.className === 'rh-trend').slice(0, 2).map(n => n.textContent), [expected, expected]);
    else assert.match(text(h.history()), /暂无历史数据/);
  }
});

test('PL pending 30-day request is shared, and stale routes or isCurrent cannot publish trends', async t => {
  const h = harness(t); let release;
  h.setHistory(url => url.endsWith('days=30') ? new Promise(resolve => { release = resolve; }) : reply({ available: false }));
  await openRouteDetail(route);
  assert.ok(all(h.nodes['detail-content']).filter(n => n.className === 'rh-trend').every(n => n.hidden));
  await h.tabs()[1].onclick();
  const pending = h.history().children[0].children[1].listeners.click();
  assert.equal(h.calls.filter(url => url.endsWith('days=30')).length, 1);
  const finishOld = release;
  h.setHistory(() => reply({ available: false }));
  await openRouteDetail({ ...route, route_id: 900102, route_name: 'NEW' });
  finishOld(reply(fixture())); await pending; await tick();
  assert.equal(h.nodes['detail-title'].textContent, 'NEW');
  assert.equal(h.tabs()[0].attributes['aria-selected'], 'true');
  assert.match(text(h.nodes['detail-content']), /当前数据源不支持历史/);
  assert.equal(all(h.nodes['detail-content']).filter(n => n.tag === 'svg').length, 0);
  let current = true;
  h.setHistory(() => new Promise(resolve => { release = resolve; }));
  await openRouteDetail(route, undefined, undefined, { isCurrent: () => current }); current = false;
  release(reply(fixture())); await tick();
  assert.ok(all(h.nodes['detail-content']).filter(n => n.className === 'rh-trend').every(n => n.hidden));
});

test('PL overview unavailable and network failure hide metric trends and use existing RH messages', async t => {
  const h = harness(t);
  for (const [read, message] of [[() => reply({ available: false }), '当前数据源不支持历史'], [() => { throw Error('private'); }, '无法加载线路历史 (server_unreachable)。']]) {
    h.setHistory(read); await openRouteDetail(route); await tick();
    assert.ok(text(h.nodes['detail-content']).includes(message));
    assert.ok(all(h.nodes['detail-content']).filter(n => n.className === 'rh-trend').every(n => n.hidden));
    assert.doesNotMatch(text(h.nodes['detail-content']), /private/);
    await h.tabs()[1].onclick(); const before = h.calls.length;
    await h.history().children[0].children[1].listeners.click();
    assert.equal(h.calls.length, before); assert.ok(text(h.history()).includes(message));
  }
});

test('PL-T4 pointer snaps to calendar days, gaps hide, units and change text match history', async t => {
  const h = harness(t), data = fixture();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const day = n => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  data.points = [6, 3, 0].map(n => ({ day: day(n), pickup_volume: 1478, pph: 23.41, first_mile_distance: 19.98, zip_count: 8 }));
  data.changes = [{ day: day(3), field: 'dsp_name', from: '<A>', to: 'B' }, { day: day(3), field: 'zip_set', added: 1, removed: 0 }];
  h.setHistory(() => reply(data)); await openRouteDetail(route); await h.tabs()[1].onclick();
  const charts = all(h.history()).filter(n => n.className === 'pl-chart-container');
  for (const [i, expected] of ['1,478 件', 'PPH 23.41', '19.98 mi', '8 个 ZIP'].entries()) {
    const [svg, tip] = charts[i].children;
    assert.equal(svg.attributes.tabindex, '0'); assert.match(svg.attributes['aria-label'], /缺失日期断开/);
    assert.equal(tip.attributes['aria-live'], 'polite');
    for (const px of [-100, 8, 150, 292, 500]) {
      svg.listeners.pointermove({ clientX: 100 + px });
      assert.equal(tip.hidden, false); assert.equal(tip.children[1].textContent, expected);
      assert.equal(tip.children[0].textContent, `${Number(day(px < 100 ? 6 : px < 292 ? 3 : 0).slice(5, 7))}/${Number(day(px < 100 ? 6 : px < 292 ? 3 : 0).slice(8))}`);
      assert.ok(Number.parseFloat(tip.style.left) >= 0 && Number.parseFloat(tip.style.left) <= 200);
    }
    svg.listeners.pointermove({ clientX: 250 });
    assert.equal(tip.children[2].textContent, 'DSP <A> → B；ZIP +1 / −0');
    for (const line of tip.children[2].textContent.split('；')) assert.ok(text(h.history()).includes(line));
    const circles = all(svg).filter(n => n.tag === 'circle');
    assert.equal(circles[1].attributes.r, '5');
    svg.listeners.pointermove({ clientX: 100 + 8 + 284 / 6 });
    assert.equal(tip.hidden, true); assert.equal(circles[1].attributes.r, '3');
    assert.equal(h.listeners.get('pointerdown').size, 0);
    svg.listeners.pointermove({ clientX: 250 }); svg.listeners.pointerleave({ pointerType: 'mouse' });
    assert.equal(tip.hidden, true);
  }
});

test('PL-T4 keyboard skips gaps, touch outside, blur, tab/period/route cleanup remove live tips', async t => {
  const h = harness(t); h.setHistory(() => reply(fixture()));
  await openRouteDetail(route); await h.tabs()[1].onclick();
  const chart = () => all(h.history()).find(n => n.className === 'pl-chart-container');
  let [svg, tip] = chart().children;
  const key = key => svg.listeners.keydown({ key, preventDefault() {} });
  key('ArrowRight'); const first = tip.children[0].textContent;
  key('ArrowRight'); const second = tip.children[0].textContent;
  assert.notEqual(first, second); key('ArrowLeft'); assert.equal(tip.children[0].textContent, first);
  key('ArrowLeft'); assert.equal(tip.children[0].textContent, first);
  key('Escape'); assert.equal(tip.hidden, true); assert.equal(h.listeners.get('pointerdown').size, 0);
  key('ArrowLeft'); assert.notEqual(tip.children[0].textContent, first);
  svg.listeners.blur(); assert.equal(tip.hidden, true);
  const px = 100 + 8 + 2 / 6 * 284;
  for (const pointerType of ['touch', 'pen']) {
    svg.listeners.pointerdown({ clientX: px, pointerType }); assert.equal(tip.hidden, false);
    svg.listeners.pointerleave({ pointerType }); assert.equal(tip.hidden, false);
    for (const listener of h.listeners.get('pointerdown')) listener({ target: svg });
    assert.equal(tip.hidden, false);
    for (const listener of h.listeners.get('pointerdown')) listener({ target: new Element() });
    assert.equal(tip.hidden, true); assert.equal(h.listeners.get('pointerdown').size, 0);
  }
  key('ArrowRight'); await h.history().children[0].children[1].listeners.click();
  assert.equal(tip.hidden, true); assert.equal(h.listeners.get('pointerdown').size, 0);
  assert.ok(!all(h.history()).includes(tip));
  [svg, tip] = chart().children; key('ArrowRight'); await h.tabs()[0].onclick();
  assert.equal(tip.hidden, true); assert.equal(h.listeners.get('pointerdown').size, 0);
  await h.tabs()[1].onclick(); key('ArrowRight'); await openRouteDetail({ ...route, route_id: 900102 });
  assert.equal(tip.hidden, true); assert.equal(h.listeners.get('pointerdown').size, 0);
  assert.ok(!all(h.history()).includes(tip));
});
