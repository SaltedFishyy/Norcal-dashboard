import test from 'node:test';
import assert from 'node:assert/strict';
import { openRouteDetail, summarizeMetric } from '../../web/route-detail.js';

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
}
const all = node => [node, ...node.children.flatMap(all)];
const text = node => all(node).map(n => n.textContent).join(' ');
const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = data => ({ status: 200, json: async () => data });
function harness(t) {
  const oldDocument = globalThis.document, oldFetch = globalThis.fetch;
  const nodes = Object.fromEntries(['route-detail', 'detail-content', 'detail-title', 'detail-close'].map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => nodes[id], createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  const calls = []; let history = () => reply({ available: false });
  globalThis.fetch = async url => { calls.push(url); return url.includes('route-details?') ? reply({ zips: [] }) : history(url); };
  t.after(() => { globalThis.document = oldDocument; globalThis.fetch = oldFetch; });
  return { nodes, calls, setHistory: fn => { history = fn; }, tabs: () => all(nodes['route-detail']).filter(n => n.attributes.role === 'tab'),
    history: () => all(nodes['route-detail']).find(n => n.id === 'detail-history') };
}
const route = { route_id: 900101, route_name: 'MOCK' };
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
  const tabs = h.tabs(); assert.equal(tabs[0].attributes['aria-selected'], 'true'); assert.equal(h.calls.length, 1);
  await tabs[0].onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(tabs[1].focused, true); assert.equal(tabs[1].attributes['aria-selected'], 'true');
  assert.equal(h.nodes['detail-content'].hidden, true);
  assert.match(h.calls[1], /days=7$/); assert.equal(h.calls.length, 2);
  const panel = h.history();
  for (const word of ['最近 7 天中有 3 天数据', '已有 3 天数据', '最近一次出现：', '曾用名：OLD-A、OLD-B', '领件量', '首公里距离 (mile)', 'ZIP 数量', '难度 3 → 4', 'DSP <A> → B', 'ZIP +1 / −0']) assert.ok(text(panel).includes(word), word);
  assert.equal(all(panel).filter(n => n.className === 'rh-card').length, 4);
  const charts = all(panel).filter(n => n.tag === 'svg'); assert.equal(charts.length, 4);
  assert.equal(all(charts[0]).filter(n => n.tag === 'polyline').length, 1); // day -4 isolated; -2/-1 connected
  assert.equal(all(charts[2]).filter(n => n.tag === 'circle').length, 1);
  assert.ok(all(charts[0]).some(n => n.attributes.class === 'rh-change-marker'));
  const periods = panel.children[0].children;
  await periods[1].listeners.click(); assert.match(h.calls.at(-1), /days=30$/); assert.equal(periods[1].attributes['aria-pressed'], 'true');
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
test('RH-T2 stale period and close/reopen responses cannot overwrite new view', async t => {
  const h = harness(t); await openRouteDetail(route);
  let release; h.setHistory(() => new Promise(resolve => { release = resolve; }));
  const pending = h.tabs()[1].onclick(); await tick(); assert.match(text(h.history()), /加载中/);
  h.setHistory(() => reply({ available: false })); await h.history().children[0].children[1].listeners.click();
  release(reply(fixture())); await pending; assert.match(text(h.history()), /当前数据源不支持历史/);
  h.setHistory(() => new Promise(resolve => { release = resolve; }));
  const next = h.history().children[0].children[0].listeners.click(); await tick();
  h.nodes['route-detail'].close(); await openRouteDetail({ ...route, route_id: 900102 });
  h.setHistory(() => reply({ available: false })); await h.tabs()[1].onclick();
  release(reply(fixture())); await next; assert.match(text(h.history()), /当前数据源不支持历史/);
});
