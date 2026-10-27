import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultDistrictsPath, readDistrictConfig, readDistricts, validateDistricts } from '../src/store/districts-file.js';
import { parseRefreshScope, planRefresh } from '../src/batch/refresh-plan.js';
import { startWorkerServer } from '../src/worker/worker.js';
import { startApiServer } from '../src/api/server.js';
import { createJsonDataSource } from '../src/store/data-source.js';
import { buildDistrictMap, buildRouteMap, lookupZip } from '../src/route-map/route-map.js';
import { centralFixture } from './central-db-fixtures.js';
import { snapshot, route, boundaries } from './route-map-fixtures.js';
import { fixture as mapFixture, Element } from './route-map-web.test.js';

const south = ['CNO01', 'LAX01', 'LAX02', 'LAX03', 'SFV01', 'SFV02', 'VTC01', 'SMX01', 'BKD01', 'FAT01', 'PLM01', 'SAN01', 'YUM02', 'YUM01', 'HNL01'];
const phoenix = ['PHX01', 'TUC01', 'CGZ01', 'PRC01', 'LAS01', 'STG01', 'IFP01', 'FLG01'];
const north = { id: 'north-cal', name_zh: '北加州片区', name_en: 'North Cal District', stations: ['SFO01', 'OAR01', 'SMF01', 'SCK01', 'RNO01', 'RDG01', 'RDG02', 'MOD01', 'MFR01', 'SFO02'] };
const denver = { id: 'denver', name_zh: '丹佛片区', name_en: 'Denver District', stations: ['DEN01', 'CYS01', 'GJT01', 'ABQ01', 'FMN01', 'SAF01', 'SLC01', 'PIH01', 'TWF01', 'IDA01', 'LGU01', 'BIL01', 'BZN01'], scrape_disabled: { GJT01: 'not_in_dms_menu', BZN01: 'not_in_dms_menu' } };
const config = await readDistrictConfig();
const syntheticProfiles = () => ({ schema_version: 1, stations: Object.fromEntries([
  ['LAX01', 101, ['00002', '00004']], ['SAN01', 102, ['00009']],
  ['SFO01', 103, ['00123']], ['DEN01', 104, ['00123']],
].map(([station, id, zips]) => [station, snapshot([{ ...route(id, `Mock-${station}`, zips), station }])])) });

test('SC1-1 real configuration validates and preserves District order', () => {
  assert.equal(validateDistricts(config), config);
  assert.equal(config.schema_version, 1);
  assert.deepEqual(config.districts.map(d => d.id), ['north-cal', 'denver', 'south-cal', 'seattle', 'phoenix']);
});
test('SC1-2 Southern California names and exact Station order', () => {
  assert.deepEqual(config.districts[2], { id: 'south-cal', name_zh: '南加州片区', name_en: 'Southern California District', stations: south });
});
test('SC1-3 Station ownership is unique and codes are valid', () => {
  const codes = config.districts.flatMap(d => d.stations);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.match(code, /^[A-Z]{3}\d{2}$/);
});
test('SC1-4 existing District contents remain unchanged', () => {
  assert.deepEqual(config.districts.slice(0, 2), [north, denver]);
});
test('SC1-5 refresh scope expansion preserves exact order and disabled Stations', () => {
  const plan = scope => planRefresh({ config, scope: parseRefreshScope(scope) });
  const expected = d => ({ stations: d.stations.filter(code => !d.scrape_disabled?.[code]).map(code => ({ code, district: d.id })),
    skipped: Object.entries(d.scrape_disabled ?? {}).map(([code, reason]) => ({ code, district: d.id, reason })) });
  assert.deepEqual(parseRefreshScope('district:south-cal'), { type: 'district', district: 'south-cal' });
  for (const d of config.districts) {
    const result = plan('district:' + d.id);
    assert.deepEqual(result.stations, expected(d).stations); assert.deepEqual(result.skipped, expected(d).skipped);
  }
  assert.deepEqual(plan('all').stations, config.districts.flatMap(d => expected(d).stations));
  assert.deepEqual(plan('all').skipped, config.districts.flatMap(d => expected(d).skipped));
});

async function open(t, worker = false, profiles = { schema_version: 1, stations: {} }, rows = []) {
  const f = await centralFixture(t);
  const options = { ...f, districtsPath: defaultDistrictsPath,
    dataSource: { ...createJsonDataSource(f), readRouteProfiles: async () => profiles, readWarehouses: async () => rows },
    port: 0, log: () => {}, spawn: () => assert.fail('Preview must never spawn a scraper') };
  const server = worker ? await startWorkerServer(options) : await startApiServer(options);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async pathname => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    assert.equal(response.status, 200); return response.json();
  };
}
test('SC1-6 Worker previews south-cal without starting refresh', async t => {
  const get = await open(t, true);
  const result = await get('/api/refresh/preview?scope=district:south-cal');
  assert.deepEqual(result.stations, south.map(code => ({ code, district: 'south-cal', district_name_zh: '南加州片区' })));
  assert.deepEqual(result.skipped, []);
});

test('Phoenix names, Station order and refresh preview use shared configuration without DMS', async t => {
  assert.deepEqual(config.districts[4], { id: 'phoenix', name_zh: '凤凰城片区', name_en: 'Phoenix District', stations: phoenix });
  const get = await open(t, true);
  const preview = await get('/api/refresh/preview?scope=district:phoenix');
  assert.deepEqual(preview.stations, phoenix.map(code => ({ code, district: 'phoenix', district_name_zh: '凤凰城片区' })));
  assert.deepEqual(preview.skipped, []);
  const districts = (await get('/api/districts')).districts;
  assert.deepEqual(districts.find(d => d.id === 'phoenix').stations, phoenix.map(code => ({ code, has_snapshot: false })));
  const map = await get('/api/route-map/district?district=phoenix');
  assert.deepEqual(map.routes, []);
});
test('SC1-7 District API includes unavailable Stations and assigns fixture snapshot', async t => {
  const profiles = { schema_version: 1, stations: {} }, get = await open(t, false, profiles);
  let result = await get('/api/districts');
  assert.deepEqual(result.districts[2].stations, south.map(code => ({ code, has_snapshot: false })));
  profiles.stations.LAX01 = syntheticProfiles().stations.LAX01;
  result = await get('/api/districts');
  assert.equal(result.districts[2].stations.find(s => s.code === 'LAX01').has_snapshot, true);
  assert.equal(result.districts.some(d => d.id === 'unassigned'), false);
});
test('SC1-8 District map scopes routes and reuses coverage and missing calculations', async () => {
  const profiles = syntheticProfiles(), districts = await readDistricts({ profiles });
  const args = { profiles, districts, boundaries: boundaries() };
  const map = buildDistrictMap({ ...args, district: 'south-cal' });
  const individual = ['LAX01', 'SAN01'].map(station => buildRouteMap({ ...args, station }));
  assert.deepEqual(map.routes, individual.flatMap(m => m.routes));
  assert.deepEqual(map.routes.map(r => r.station), ['LAX01', 'SAN01']);
  assert.deepEqual(map.features.features, individual.flatMap(m => m.features.features));
  for (const key of Object.keys(map.coverage)) assert.equal(map.coverage[key], individual.reduce((sum, m) => sum + m.coverage[key], 0));
  assert.deepEqual(map.missing, individual.flatMap(m => m.missing.map(row => ({ ...row, station: m.station }))));
  assert.equal(map.coverage.mapped, 2); assert.equal(map.missing.length, 1);
});
test('SC1-9 ZIP search returns Southern California fixture Station', () => {
  const result = lookupZip({ profiles: syntheticProfiles(), boundaries: boundaries(), postalCode: '00002' });
  assert.equal(result.station, 'LAX01');
});
test('SC1-10 warehouse API filters by the real District configuration', async t => {
  const rows = config.districts.map(({ id: district_id }, i) => ({ id: String(i), district_id, warehouse_name: 'Mock warehouse', address: 'Mock address', station_id: null, latitude: 0, longitude: 0 }));
  const get = await open(t, false, undefined, rows);
  assert.deepEqual((await get('/api/warehouses?district=south-cal')).warehouses.map(w => w.district_id), ['south-cal']);
  assert.deepEqual((await get('/api/warehouses?district=phoenix')).warehouses.map(w => w.district_id), ['phoenix']);
  assert.equal((await get('/api/warehouses')).warehouses.length, config.districts.length);
});

test('SC1-11 map selectors extend from real config and restore Northern California', async () => {
  const profiles = { schema_version: 1, stations: { SFO01: syntheticProfiles().stations.SFO01 } };
  const districts = await readDistricts({ profiles }), f = await mapFixture('?district=north-cal');
  const data = district => buildDistrictMap({ profiles, districts, district, boundaries: boundaries() });
  f.replies.push(f.reply(200, { districts }), f.reply(200, data('north-cal'))); await f.page.start();
  const e = f.elements;
  assert.equal(e['map-district'].children[2].textContent, '南加州片区');
  e['map-district'].value = 'south-cal'; f.replies.push(f.reply(200, data('south-cal')));
  await e['map-district'].listeners.change();
  assert.deepEqual(e['map-station'].children.slice(1).map(o => o.value), south);
  for (const option of e['map-station'].children.slice(1)) { assert.equal(option.disabled, true); assert.match(option.textContent, /暂无数据/); }
  assert.ok(e['map-dsp'].disabled || e['map-dsp'].children.every(o => !o.value));
  assert.equal(e['map-district'].children[4].textContent, '凤凰城片区');
  e['map-district'].value = 'phoenix'; f.replies.push(f.reply(200, data('phoenix')));
  await e['map-district'].listeners.change();
  assert.deepEqual(e['map-station'].children.slice(1).map(o => o.value), phoenix);
  for (const option of e['map-station'].children.slice(1)) assert.equal(option.disabled, true);
  e['map-district'].value = 'north-cal'; f.replies.push(f.reply(200, data('north-cal')));
  await e['map-district'].listeners.change();
  assert.deepEqual(e['map-station'].children.slice(1).map(o => o.value), north.stations);
});
test('SC1-11 Route Profile selectors extend from real config and handle empty snapshots', async t => {
  const previous = Object.fromEntries(['document', 'fetch', 'localStorage'].map(key => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const ids = ['updated', 'total', 'rows', 'table-container', 'message', 'retry', 'profiles', 'profile-station', 'profile-district', 'route-detail', 'detail-content', 'detail-close', 'detail-title'];
  const e = Object.fromEntries(ids.map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => e[id], createElement: tag => new Element(tag), createDocumentFragment: () => new Element() };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const districts = await readDistricts({ profiles: { stations: { SFO01: {} } } });
  const requests = [];
  globalThis.fetch = async url => { requests.push(url); return { status: 200, json: async () => url === '/api/districts' ? { districts } : { rows: [], total: 0 } }; };
  await import('../../web/app.js?sc1'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(e['profile-district'].children[2].textContent, '南加州片区');
  e['profile-district'].value = 'south-cal'; await e['profile-district'].listeners.change();
  assert.deepEqual(e['profile-station'].children.map(o => o.value), south);
  for (const option of e['profile-station'].children) { assert.equal(option.disabled, true); assert.match(option.textContent, /暂无数据/); }
  assert.match(e.message.textContent, /暂无数据/);
  assert.equal(requests.some(url => url.includes('station=LAX')), false);
  assert.equal(e['profile-district'].children[4].textContent, '凤凰城片区');
  e['profile-district'].value = 'phoenix'; await e['profile-district'].listeners.change();
  assert.deepEqual(e['profile-station'].children.map(o => o.value), phoenix);
  for (const option of e['profile-station'].children) assert.equal(option.disabled, true);
  assert.equal(requests.some(url => /station=(PHX|TUC|CGZ|PRC|LAS|STG|IFP|FLG)/.test(url)), false);
  const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<select[^>]*id="[^"]*dsp/);
  e['profile-district'].value = 'north-cal'; await e['profile-district'].listeners.change();
  assert.deepEqual(e['profile-station'].children.map(o => o.value), north.stations);
});
