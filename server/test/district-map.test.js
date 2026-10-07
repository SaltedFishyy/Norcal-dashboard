import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDistrictMap, buildRouteMap, RouteZipConflictError } from '../src/route-map/route-map.js';
import { DistrictNotFoundError } from '../src/store/districts-file.js';
import { profiles, boundaries, details } from './route-map-fixtures.js';
const districts = [{ id: 'mock', stations: [{ code: 'MOCKB' }, { code: 'MOCKA' }, { code: 'ABSENT' }] }, { id: 'empty', stations: [] }];
test('DS district map merges ordered stations, coverage, features, missing ZIPs and existing difficulty joins', () => {
  const args = { profiles: profiles(), boundaries: boundaries(), details: details() };
  const map = buildDistrictMap({ ...args, districts, district: 'mock' });
  const maps = ['MOCKB', 'MOCKA'].map(station => buildRouteMap({ ...args, station }));
  assert.deepEqual(map.stations.map(station => station.code), ['MOCKB', 'MOCKA']);
  assert.deepEqual(map.routes, maps.flatMap(map => map.routes));
  assert.deepEqual(map.features.features, maps.flatMap(map => map.features.features));
  for (const key of Object.keys(map.coverage)) assert.equal(map.coverage[key], maps.reduce((sum, map) => sum + map.coverage[key], 0));
  assert.ok(map.missing.every(row => row.station)); assert.equal(map.details_status, 'ok');
});
test('DS district cross-station conflicts are scoped, same-station conflicts still fail', () => {
  const data = profiles(); data.stations.MOCKB.rows[0].postal_codes.push('00002');
  const args = { profiles: data, boundaries: boundaries(), districts, district: 'mock' };
  assert.deepEqual(buildDistrictMap(args).cross_station_conflicts, [{ postal_code: '00002', stations: ['MOCKA', 'MOCKB'] }]);
  assert.deepEqual(buildDistrictMap({ ...args, districts: [{ id: 'one', stations: [{ code: 'MOCKA' }] }], district: 'one' }).cross_station_conflicts, []);
  data.stations.MOCKA.rows[0].postal_codes = ['00002'];
  assert.throws(() => buildDistrictMap(args), RouteZipConflictError);
});
test('DS district absent and empty results', () => {
  const args = { profiles: profiles(), boundaries: boundaries(), districts };
  assert.throws(() => buildDistrictMap({ ...args, district: 'absent' }), DistrictNotFoundError);
  const empty = buildDistrictMap({ ...args, district: 'empty' });
  assert.deepEqual(empty.routes, []); assert.deepEqual(empty.stations, []); assert.deepEqual(empty.features.features, []);
  assert.equal(empty.coverage.total, 0); assert.deepEqual(empty.missing, []);
});

test('DS default nine Stations preserve configured order and distinct route colors across scope', async () => {
  const { readDistricts } = await import('../src/store/districts-file.js');
  const { snapshot, route } = await import('./route-map-fixtures.js');
  const { routeColor } = await import('../../web/route-colors.js');
  const codes = ['SFO01', 'OAR01', 'SMF01', 'SCK01', 'RNO01', 'RDG01', 'RDG02', 'MOD01', 'MFR01'];
  const profiles = { stations: Object.fromEntries(codes.map((code, index) => [code, snapshot([{ ...route(index + 1, code + '-Mock', ['00002']), station: code }])])) };
  const districts = await readDistricts({ profiles }); assert.deepEqual(districts[0].stations.map(station => station.code), codes);
  const map = buildDistrictMap({ profiles, districts, district: 'north-cal', boundaries: boundaries() });
  assert.equal(map.routes.length, 9); assert.equal(map.features.features.length, 9); assert.equal(map.coverage.mapped, 9);
  assert.deepEqual(map.stations.map(station => station.code), codes);
  const { polygonStyle, clearSelection } = await import('../../web/map-state.js');
  for (const feature of map.features.features) assert.equal(polygonStyle(feature.properties, clearSelection(), 'route').fillColor, routeColor(feature.properties.route_id));
});

test('RM6 district features carry exact ZIP metrics and profile DSP with null fallbacks', () => {
  const source = profiles(), cache = details(); source.stations.MOCKA.rows[1].dsp_name = 'Mock DSP';
  Object.assign(cache.routes['1'].zips[0], { experienced_pph: 24.5, pickup_volume_daily: 0 });
  for (const detail of [cache, undefined]) {
    const map = buildDistrictMap({ profiles: source, details: detail, boundaries: boundaries(), districts, district: 'mock' });
    for (const { properties: p } of map.features.features) {
      const found = detail && p.station === 'MOCKA' && p.postal_code === '00002';
      assert.equal(p.dsp_name, p.station === 'MOCKA' ? 'Mock DSP' : null);
      assert.equal(p.experienced_pph, found ? 24.5 : null); assert.equal(p.pickup_volume_daily, found ? 0 : null);
    }
  }
});
