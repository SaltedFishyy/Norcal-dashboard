import test from 'node:test';
import assert from 'node:assert/strict';
import { polygonStyle, searchRoutes, selectRoute, selectZip, clearSelection, classifyQuery, switchStation, uncoveredZipStyle } from '../../web/map-state.js';
import { palette, routeColor } from '../../web/route-colors.js';
import { BASEMAP_FLAVOR } from '../../web/map-view.js';

test('RM2 selection styles preserve route color and distinguish route, ZIP and dimmed polygons', () => {
  assert.equal(BASEMAP_FLAVOR, 'light');
  const properties = { route_id: 1, postal_code: '00001' };
  const normal = polygonStyle(properties), route = polygonStyle(properties, selectRoute(1));
  assert.equal(normal.fillColor, routeColor(1)); assert.equal(normal.fillOpacity, 0.5);
  assert.equal(route.fillColor, normal.fillColor); assert.equal(route.fillOpacity, 0.65);
  assert.ok(route.weight > normal.weight);
  const zip = polygonStyle(properties, selectZip(properties)); assert.ok(zip.weight > route.weight);
  const dim = polygonStyle(properties, selectRoute(2)); assert.equal(dim.fillOpacity, 0.12);
  assert.ok(dim.opacity < normal.opacity);
  assert.deepEqual(selectRoute(1), { station: null, route: { route_id: 1 }, zip: null });
  assert.deepEqual(selectZip(properties), { station: null, route: { route_id: 1, route_name: undefined, station: undefined }, zip: { ...properties, status: 'covered' } });
  assert.deepEqual(polygonStyle(properties, clearSelection()), normal);
  assert.equal(palette.length, 19); assert.ok(!palette.includes('#b3b3b3'));
});

test('unified query classification and station/route/ZIP transitions', () => {
  for (const input of ['', '  ']) assert.deepEqual(classifyQuery(input), { kind: 'empty' });
  assert.deepEqual(classifyQuery(' 00123 '), { kind: 'zip' });
  for (const input of ['0', '023', '1234']) assert.deepEqual(classifyQuery(input), { kind: 'route', zipHint: true });
  for (const input of ['SFO01-023', '123456', '12x', '１２３４５']) assert.deepEqual(classifyQuery(input), { kind: 'route' });
  const route = { route_id: 1, station: 'MOCKA', route_name: 'Mock-A' };
  assert.deepEqual(selectRoute(route), { station: 'MOCKA', route, zip: null });
  for (const status of ['covered', 'covered_no_boundary']) {
    assert.deepEqual(selectZip({ postal_code: '00002', status, station: 'MOCKA', route }).route, route);
  }
  for (const status of ['uncovered', 'no_boundary', 'out_of_range']) {
    const state = selectZip({ postal_code: '00002', status }, 'MOCKA');
    assert.equal(state.route, null); assert.equal(state.station, 'MOCKA');
    assert.equal(polygonStyle({ route_id: 1 }, state).fillOpacity, 0.5);
  }
  assert.deepEqual(switchStation('MOCKB'), { station: 'MOCKB', route: null, zip: null });
  assert.equal(uncoveredZipStyle().dashArray, '8 6'); assert.equal(uncoveredZipStyle().weight, 5);
  assert.equal(uncoveredZipStyle().fillOpacity, 0.15);
  assert.equal(polygonStyle({ route_id: 1, postal_code: '00002' }, selectZip({ route_id: 1, postal_code: '00002' })).color, '#334155');
  assert.deepEqual([palette[8], palette[14], palette[16], palette[17]], ['#c4a62a', '#d875a8', '#71ad68', '#d9b52c']);
});

test('RM2 route search trims, ignores case, sorts matches and identifies exact match', () => {
  const routes = ['SFO01-023X', 'SFO01-023', 'SFO01-001'].map(route_name => ({ route_name }));
  const result = searchRoutes(routes, '  sfo01-023  ');
  assert.equal(result.exact, routes[1]); assert.deepEqual(result.matches, [routes[1], routes[0]]);
  assert.equal(searchRoutes(routes, '001').matches[0], routes[2]);
  assert.deepEqual(searchRoutes(routes, 'nope'), { exact: undefined, matches: [] });
  assert.deepEqual(searchRoutes(routes, ' ').matches, [routes[2], routes[1], routes[0]]);
  assert.equal(searchRoutes(routes, ' ').exact, undefined);
});


test('RM5 difficulty style table preserves every route-mode border, opacity and selection rule', async () => {
  const { difficultyColor } = await import('../../web/difficulty.js');
  const properties = { route_id: 1, postal_code: '00002', route_difficulty: 'S级 极难',
    route_difficulty_manual: 'D级 极易', zip_difficulty: 'A级 难', zip_detail_status: 'available' };
  for (const selection of [clearSelection(), selectRoute(1), selectRoute(2), selectZip(properties)]) {
    const route = polygonStyle(properties, selection);
    assert.deepEqual(polygonStyle(properties, selection, 'route'), route);
    const difficult = polygonStyle(properties, selection, 'difficulty');
    const level = selection.route?.route_id === 1 ? 'A' : 'S';
    assert.deepEqual(difficult, { ...route, fillColor: difficultyColor(level) });
  }
  for (const status of ['available', 'missing', 'not_in_detail']) {
    for (const zip_difficulty of ['B级 中', null, 'unknown']) {
      const style = polygonStyle({ ...properties, zip_difficulty, zip_detail_status: status }, selectRoute(1), 'difficulty');
      assert.equal(style.fillColor, difficultyColor(status === 'available' && zip_difficulty === 'B级 中' ? 'B' : null));
    }
  }
  for (const route_difficulty of [null, 'unknown']) assert.equal(polygonStyle({ ...properties, route_difficulty }, clearSelection(), 'difficulty').fillColor, difficultyColor(null));
  assert.equal(polygonStyle(properties, selectRoute(2), 'difficulty').fillOpacity, 0.12);
});

 test('DS focus Station changes only opacity; explicit Route selection takes precedence in both modes', () => {
  const properties = { station: 'SFO01', route_id: 7, route_difficulty: 'A级 难', zip_difficulty: 'B级 中', zip_detail_status: 'available' };
  for (const mode of ['route', 'difficulty']) {
    const normal = polygonStyle(properties, clearSelection(), mode);
    const faded = polygonStyle(properties, clearSelection(), mode, 'SMF01');
    assert.equal(faded.fillColor, normal.fillColor); assert.equal(faded.fillOpacity, 0.12); assert.equal(faded.opacity, 0.35);
    assert.deepEqual(polygonStyle(properties, clearSelection(), mode, 'SFO01'), normal);
    const selected = selectRoute({ route_id: 7, station: 'SFO01' });
    assert.deepEqual(polygonStyle(properties, selected, mode, 'SMF01'), polygonStyle(properties, selected, mode));
    assert.equal(polygonStyle({ ...properties, station: 'SMF01', route_id: 8 }, selected, mode, 'SMF01').fillOpacity, 0.12);
  }
});
