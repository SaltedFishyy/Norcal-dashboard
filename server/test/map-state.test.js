import test from 'node:test';
import assert from 'node:assert/strict';
import { POLYGON_STYLE, hoverStyle, polygonStyle, searchRoutes, selectRoute, selectZip, clearSelection, classifyQuery, switchStation, uncoveredZipStyle, vividRouteColor, ROUTE_FILL, routeLabelText, routeLabelAnchors } from '../../web/map-state.js';
import { palette, routeColor } from '../../web/route-colors.js';
import { BASEMAP_FLAVOR } from '../../web/map-view.js';

test('RM2 selection styles preserve route color and distinguish route, ZIP and dimmed polygons', () => {
  assert.equal(BASEMAP_FLAVOR, 'light');
  const properties = { route_id: 1, postal_code: '00001' };
  const normal = polygonStyle(properties), route = polygonStyle(properties, selectRoute(1));
  assert.equal(normal.fillColor, vividRouteColor(routeColor(1))); assert.equal(normal.fillOpacity, POLYGON_STYLE.normal.fillOpacity);
  assert.equal(route.fillColor, normal.fillColor); assert.equal(route.fillOpacity, POLYGON_STYLE.selectedRoute.fillOpacity);
  assert.ok(route.weight > normal.weight);
  const zip = polygonStyle(properties, selectZip(properties)); assert.ok(zip.weight > route.weight);
  const dim = polygonStyle(properties, selectRoute(2)); assert.equal(dim.fillOpacity, POLYGON_STYLE.dimmed.fillOpacity);
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
    assert.equal(polygonStyle({ route_id: 1 }, state).fillOpacity, POLYGON_STYLE.normal.fillOpacity);
  }
  assert.deepEqual(switchStation('MOCKB'), { station: 'MOCKB', route: null, zip: null });
  assert.equal(uncoveredZipStyle().dashArray, '8 6'); assert.equal(uncoveredZipStyle().weight, 5);
  assert.equal(uncoveredZipStyle().fillOpacity, 0.15);
  assert.equal(polygonStyle({ route_id: 1, postal_code: '00002' }, selectZip({ route_id: 1, postal_code: '00002' })).color, POLYGON_STYLE.selectedZip.color);
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


test('RM5 difficulty style table preserves semantic colors, borders and selection rules', async () => {
  const { difficultyColor } = await import('../../web/difficulty.js');
  const properties = { route_id: 1, postal_code: '00002', route_difficulty: 'S级 极难',
    route_difficulty_manual: 'D级 极易', zip_difficulty: 'A级 难', zip_detail_status: 'available' };
  for (const selection of [clearSelection(), selectRoute(1), selectRoute(2), selectZip(properties)]) {
    const route = polygonStyle(properties, selection);
    assert.deepEqual(polygonStyle(properties, selection, 'route'), route);
    const difficult = polygonStyle(properties, selection, 'difficulty');
    const level = selection.route?.route_id === 1 ? 'A' : 'S';
    assert.deepEqual(difficult, { ...route, fillColor: difficultyColor(level),
      fillOpacity: selection.route ? route.fillOpacity : POLYGON_STYLE.normal.difficultyFillOpacity });
  }
  for (const status of ['available', 'missing', 'not_in_detail']) {
    for (const zip_difficulty of ['B级 中', null, 'unknown']) {
      const style = polygonStyle({ ...properties, zip_difficulty, zip_detail_status: status }, selectRoute(1), 'difficulty');
      assert.equal(style.fillColor, difficultyColor(status === 'available' && zip_difficulty === 'B级 中' ? 'B' : null));
    }
  }
  for (const route_difficulty of [null, 'unknown']) assert.equal(polygonStyle({ ...properties, route_difficulty }, clearSelection(), 'difficulty').fillColor, difficultyColor(null));
  assert.equal(polygonStyle(properties, selectRoute(2), 'difficulty').fillOpacity, POLYGON_STYLE.dimmed.fillOpacity);
});

 test('DS focus Station changes only opacity; explicit Route selection takes precedence in both modes', () => {
  const properties = { station: 'SFO01', route_id: 7, route_difficulty: 'A级 难', zip_difficulty: 'B级 中', zip_detail_status: 'available' };
  for (const mode of ['route', 'difficulty']) {
    const normal = polygonStyle(properties, clearSelection(), mode);
    const faded = polygonStyle(properties, clearSelection(), mode, 'SMF01');
    assert.equal(faded.fillColor, normal.fillColor); assert.equal(faded.fillOpacity, POLYGON_STYLE.dimmed.fillOpacity); assert.equal(faded.opacity, POLYGON_STYLE.dimmed.opacity);
    assert.deepEqual(polygonStyle(properties, clearSelection(), mode, 'SFO01'), { ...normal, ...POLYGON_STYLE.focused });
    const selected = selectRoute({ route_id: 7, station: 'SFO01' });
    assert.deepEqual(polygonStyle(properties, selected, mode, 'SMF01'), polygonStyle(properties, selected, mode));
    assert.equal(polygonStyle({ ...properties, station: 'SMF01', route_id: 8 }, selected, mode, 'SMF01').fillOpacity, POLYGON_STYLE.dimmed.fillOpacity);
  }
});

test('RM7 DSP options normalize, deduplicate, sort and scope without accepting missing names', async () => {
  const { dspOptions, filteredRoutes } = await import('../../web/map-state.js');
  const routes = [' Z ', 'A', 'A', null, undefined, '', '  ', 7].map(dsp_name => ({ station: 'A', dsp_name, route_name: 'Alpha' }));
  routes.push({ station: 'B', dsp_name: 'B', route_name: 'Beta' });
  assert.deepEqual(dspOptions(routes, 'A'), ['A', 'Z']);
  assert.deepEqual(dspOptions(routes), ['A', 'B', 'Z']);
  assert.deepEqual(dspOptions(routes, 'missing'), []);
  assert.equal(filteredRoutes(routes, 'Beta', 'A', 'B').exact, routes.at(-1));
  assert.deepEqual(filteredRoutes(routes, '', 'A', 'B').matches, []);
});

test('RM7 DSP fading preserves colors, selection precedence and null behavior', () => {
  const p = { station: 'A', dsp_name: 'Alpha', route_id: 1, route_difficulty: 'A级 难', postal_code: '00001' };
  for (const mode of ['route', 'difficulty']) {
    for (const selection of [clearSelection(), selectRoute(1), selectRoute(2), selectZip(p)]) {
      const normal = polygonStyle(p, selection, mode, 'A');
      assert.deepEqual(polygonStyle(p, selection, mode, 'A', null), normal);
      const filtered = polygonStyle(p, selection, mode, 'A', 'Beta');
      assert.deepEqual(filtered, selection.route ? normal : { ...normal, ...POLYGON_STYLE.dimmed });
      assert.deepEqual(polygonStyle(p, selection, mode, 'A', 'Alpha'), normal);
    }
    assert.deepEqual(polygonStyle(p, clearSelection(), mode, 'B', 'Alpha'), polygonStyle(p, clearSelection(), mode, 'B'));
  }
});

test('R1 visual hierarchy and hover cap hold in both color modes', () => {
  const p = { route_id: 1, postal_code: '00001', route_difficulty: 'S级 极难',
    zip_difficulty: 'A级 难', zip_detail_status: 'available' };
  for (const mode of ['route', 'difficulty']) {
    const normal = polygonStyle(p, clearSelection(), mode);
    const route = polygonStyle(p, selectRoute(1), mode);
    const zip = polygonStyle(p, selectZip(p), mode);
    const dimmed = polygonStyle(p, selectRoute(2), mode);
    const hover = hoverStyle(normal);
    assert.equal(normal.fillOpacity, mode === 'route' ? POLYGON_STYLE.normal.fillOpacity : POLYGON_STYLE.normal.difficultyFillOpacity);
    assert.equal(route.fillOpacity, POLYGON_STYLE.selectedRoute.fillOpacity);
    assert.equal(zip.fillOpacity, POLYGON_STYLE.selectedZip.fillOpacity);
    assert.equal(dimmed.fillOpacity, POLYGON_STYLE.dimmed.fillOpacity);
    assert.ok(zip.fillOpacity > route.fillOpacity && route.fillOpacity > hover.fillOpacity
      && hover.fillOpacity > normal.fillOpacity && normal.fillOpacity > dimmed.fillOpacity);
    assert.ok(zip.weight >= route.weight && route.weight > normal.weight);
    assert.ok(dimmed.opacity < normal.opacity);
    assert.equal(hover.color, POLYGON_STYLE.hover.color); assert.notEqual(hover.color, '#ffffff');
    assert.equal(hover.fillColor, normal.fillColor);
    assert.equal(hover.fillOpacity, normal.fillOpacity + POLYGON_STYLE.hover.fillOpacityIncrease);
    assert.equal(hover.weight, Math.max(normal.weight, POLYGON_STYLE.hover.weight));
    assert.ok(hoverStyle(dimmed).fillOpacity < route.fillOpacity);
    assert.equal(hoverStyle(zip).fillOpacity, POLYGON_STYLE.selectedZip.fillOpacity);
    assert.equal(hoverStyle(zip).weight, zip.weight);
    assert.deepEqual(hoverStyle(normal), hover); // The base style is not mutated.
  }
});

function hsl(hex) {
  const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255);
  const [r, g, b] = rgb, max = Math.max(...rgb), min = Math.min(...rgb), d = max - min, l = (max + min) / 2;
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, d ? d / (1 - Math.abs(2 * l - 1)) : 0, l];
}

test('R2a vivid fills preserve palette hue and apply configured saturation/lightness only to the map', () => {
  for (const hex of palette) {
    const vivid = vividRouteColor(hex), before = hsl(hex), after = hsl(vivid);
    assert.match(vivid, /^#[0-9a-f]{6}$/);
    const hueError = Math.abs(before[0] - after[0]);
    assert.ok(Math.min(hueError, 360 - hueError) <= 1);
    assert.ok(before[1] === 1 ? after[1] === 1 : after[1] > before[1]);
    assert.ok(Math.abs(after[1] - Math.min(1, before[1] * ROUTE_FILL.saturation)) < 0.012);
    assert.ok(Math.abs(after[2] - Math.max(0, Math.min(1, before[2] + ROUTE_FILL.lightness))) <= 1 / 255);
  }
  assert.equal(vividRouteColor('#ffffff'), '#f0f0f0');
  assert.equal(vividRouteColor('#000000'), '#000000');
});

test('R2a focused hierarchy intersects Station and DSP filters without overriding explicit selection', () => {
  const p = { station: 'A', dsp_name: 'Alpha', route_id: 1, postal_code: '00001', route_difficulty: 'A级 难' };
  for (const mode of ['route', 'difficulty']) {
    const normal = polygonStyle(p, clearSelection(), mode);
    for (const [station, dsp] of [['A', null], [null, 'Alpha'], ['A', 'Alpha']]) {
      const focused = polygonStyle(p, clearSelection(), mode, station, dsp);
      assert.deepEqual(focused, { ...normal, ...POLYGON_STYLE.focused });
      assert.ok(focused.fillOpacity > normal.fillOpacity);
      assert.ok(focused.opacity > normal.opacity);
    }
    for (const [station, dsp] of [['B', 'Alpha'], ['A', 'Beta'], ['B', 'Beta']]) {
      const dim = polygonStyle(p, clearSelection(), mode, station, dsp);
      assert.deepEqual(dim, { ...normal, ...POLYGON_STYLE.dimmed });
      assert.ok(dim.fillOpacity < normal.fillOpacity && dim.opacity < normal.opacity);
    }
    assert.deepEqual(polygonStyle(p, selectRoute(1), mode, 'B', 'Beta'), polygonStyle(p, selectRoute(1), mode));
  }
});

test('R2a route label suffixes retain zeros and treat empty names as absent', () => {
  for (const [name, text] of [['SFO01-021', '021'], ['SMF01-009', '009'], ['A-B-007', '007'], ['Route', 'Route'],
    [null, null], [undefined, null], ['', null], ['  ', null]]) assert.equal(routeLabelText(name), text);
});

const box = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const labelFeature = (id, coordinates, type = 'Polygon') => ({ type: 'Feature',
  properties: { route_id: id, route_name: 'MOCK-' + String(id).padStart(3, '0'), station: 'MOCK' },
  geometry: { type, coordinates } });
function contains(point, ring) {
  let count = 0;
  for (let i = 1; i < ring.length; i++) {
    const [a, b] = [ring[i - 1], ring[i]];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) count++;
  }
  return count % 2 === 1;
}

test('R2a anchors group Routes once and fall back inside the nearest member ZIP of an L-shaped route', () => {
  const left = box(0, 0, 1, 4), top = box(1, 3, 4, 1);
  const features = [labelFeature(1, [left]), labelFeature(1, [top]), labelFeature(2, [box(10, 0, 2, 2)])];
  const original = structuredClone(features), anchors = routeLabelAnchors(features);
  assert.equal(anchors.length, 2); assert.deepEqual(features, original);
  const point = anchors[0].latlng.toReversed();
  assert.equal(contains([1.75, 2.75], left) || contains([1.75, 2.75], top), false);
  assert.equal(contains(point, top), true); assert.equal(contains(point, left), false);
  assert.equal(anchors[0].weight, 8); assert.equal(anchors[0].text, '001');
  assert.deepEqual(anchors[1].latlng, [1, 11]); assert.equal(anchors[1].weight, 4);
  assert.deepEqual(routeLabelAnchors([]), []);
});

test('R2a area moments sum MultiPolygons and subtract holes independent of ring winding', () => {
  const outer = box(0, 0, 4, 4), hole = box(1, 1, 2, 2);
  const [donut] = routeLabelAnchors([labelFeature(1, [outer, hole])]);
  assert.equal(donut.weight, 12);
  assert.equal(contains(donut.latlng.toReversed(), outer), true);
  assert.equal(contains(donut.latlng.toReversed(), hole), false);
  assert.deepEqual(routeLabelAnchors([labelFeature(1, [outer.toReversed(), hole.toReversed()])]), [donut]);
  const parts = [[box(0, 0, 1, 1)], [box(3, 0, 2, 2)]];
  const [multi] = routeLabelAnchors([labelFeature(2, parts, 'MultiPolygon')]);
  assert.equal(multi.weight, 5);
  assert.equal(parts.some(([ring]) => contains(multi.latlng.toReversed(), ring)), true);
  const [withHole] = routeLabelAnchors([labelFeature(3, [[outer, hole], [box(10, 0, 1, 1)]], 'MultiPolygon')]);
  assert.equal(withHole.weight, 13);
  assert.ok(contains(withHole.latlng.toReversed(), outer) && !contains(withHole.latlng.toReversed(), hole));
});

test('R2a concave C-shaped ZIP uses the interior grid when its outer-ring centroid lies outside', () => {
  const c = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [4, 3], [4, 4], [0, 4], [0, 0]];
  const [anchor] = routeLabelAnchors([labelFeature(1, [c])]);
  assert.equal(contains(anchor.latlng.toReversed(), c), true);
  assert.equal(anchor.weight, 10);
});
