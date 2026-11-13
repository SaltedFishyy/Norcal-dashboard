import test from 'node:test';
import assert from 'node:assert/strict';
import { assignRouteColors, ROUTE_COLOR_ASSIGN, POLYGON_STYLE, hoverStyle, polygonStyle, searchRoutes, selectRoute, selectZip, clearSelection, classifyQuery, switchStation, uncoveredZipStyle, vividRouteColor, ROUTE_FILL, routeLabelText, routeLabelAnchors } from '../../web/map-state.js';
import { palette, routeColor } from '../../web/route-colors.js';
import { BASEMAP_FLAVOR } from '../../web/map-view.js';

test('RM2 selection styles preserve route color and distinguish route, ZIP and dimmed polygons', () => {
  assert.equal(BASEMAP_FLAVOR.water, '#aadaff');
  assert.equal(BASEMAP_FLAVOR.roads_label_minor_halo, '#ffffff');
  const properties = { route_id: 1, postal_code: '00001' };
  const normal = polygonStyle(properties), route = polygonStyle(properties, selectRoute(1));
  assert.equal(normal.fillColor, '#cd7ec6'); assert.equal(normal.fillOpacity, POLYGON_STYLE.focused.fillOpacity);
  assert.equal(route.fillColor, '#cd7ec6'); assert.equal(route.fillOpacity, POLYGON_STYLE.selectedRoute.fillOpacity);
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
    assert.equal(polygonStyle({ route_id: 1 }, state).fillOpacity, POLYGON_STYLE.focused.fillOpacity);
  }
  assert.deepEqual(switchStation('MOCKB'), { station: 'MOCKB', route: null, zip: null });
  assert.equal(uncoveredZipStyle().dashArray, '8 6'); assert.equal(uncoveredZipStyle().weight, 5);
  assert.equal(uncoveredZipStyle().fillOpacity, 0.15);
  assert.equal(polygonStyle({ route_id: 1, postal_code: '00002' }, selectZip({ route_id: 1, postal_code: '00002' })).color, POLYGON_STYLE.selectedZip.color);
  assert.deepEqual([palette[8], palette[14], palette[16], palette[17]], ['#00b9a0', '#a98ae7', '#35b886', '#cd7ec6']);
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
    const border = selection.route ? route : POLYGON_STYLE.normal;
    assert.deepEqual(difficult, { ...route, color: border.color, weight: border.weight, opacity: border.opacity, fillColor: difficultyColor(level),
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
    assert.equal(faded.fillColor === normal.fillColor, mode === 'difficulty'); assert.equal(faded.fillOpacity, POLYGON_STYLE.outside.fillOpacity); assert.equal(faded.opacity, POLYGON_STYLE.outside.opacity);
    assert.deepEqual(polygonStyle(properties, clearSelection(), mode, 'SFO01'), { ...normal, ...POLYGON_STYLE.focused, fillColor: mode === 'difficulty' ? normal.fillColor : polygonStyle(properties, selectRoute(properties.route_id)).fillColor });
    const selected = selectRoute({ route_id: 7, station: 'SFO01' });
    assert.deepEqual(polygonStyle(properties, selected, mode, 'SMF01'), polygonStyle(properties, selected, mode));
    assert.equal(polygonStyle({ ...properties, station: 'SMF01', route_id: 8 }, selected, mode, 'SMF01').fillOpacity, POLYGON_STYLE.dimmed.fillOpacity);
  }
});

test('RM7 DSP options normalize, deduplicate, sort and scope without accepting missing names', async () => {
  const { filteredRoutes } = await import('../../web/map-state.js');
  const { dspOptions } = await import('../../web/format.js');
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
      assert.deepEqual(filtered, selection.route ? normal : { ...normal, ...POLYGON_STYLE.dimmed, fillColor: polygonStyle(p, selectRoute(2), mode).fillColor });
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
    assert.equal(normal.fillOpacity, mode === 'route' ? POLYGON_STYLE.focused.fillOpacity : POLYGON_STYLE.normal.difficultyFillOpacity);
    assert.equal(route.fillOpacity, POLYGON_STYLE.selectedRoute.fillOpacity);
    assert.equal(zip.fillOpacity, POLYGON_STYLE.selectedZip.fillOpacity);
    assert.equal(dimmed.fillOpacity, POLYGON_STYLE.dimmed.fillOpacity);
    assert.ok(zip.fillOpacity > route.fillOpacity && route.fillOpacity > hover.fillOpacity
      && hover.fillOpacity > normal.fillOpacity && normal.fillOpacity > dimmed.fillOpacity);
    assert.ok(zip.weight >= route.weight && route.weight > normal.weight);
    assert.ok(dimmed.opacity < normal.opacity);
    assert.equal(hover.color, POLYGON_STYLE.hover.color); assert.equal(hover.color, '#ffffff');
    assert.equal(hover.fillColor, normal.fillColor);
    assert.equal(hover.fillOpacity, normal.fillOpacity + POLYGON_STYLE.hover.fillOpacityIncrease);
    assert.equal(hover.weight, POLYGON_STYLE.hover.weight);
    assert.ok(hoverStyle(dimmed).fillOpacity < route.fillOpacity);
    assert.equal(hoverStyle(zip).fillOpacity, POLYGON_STYLE.selectedZip.fillOpacity);
    assert.equal(hoverStyle(zip).weight, POLYGON_STYLE.hover.weight);
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
    assert.equal(vivid, hex);
    assert.ok(Math.abs(after[1] - Math.min(1, before[1] * ROUTE_FILL.saturation)) < 0.012);
    assert.ok(Math.abs(after[2] - Math.max(0, Math.min(1, before[2] + ROUTE_FILL.lightness))) <= 1 / 255);
  }
  assert.equal(vividRouteColor('#ffffff'), '#ffffff');
  assert.equal(vividRouteColor('#000000'), '#000000');
});

test('R2a focused hierarchy intersects Station and DSP filters without overriding explicit selection', () => {
  const p = { station: 'A', dsp_name: 'Alpha', route_id: 1, postal_code: '00001', route_difficulty: 'A级 难' };
  for (const mode of ['route', 'difficulty']) {
    const normal = polygonStyle(p, clearSelection(), mode);
    for (const [station, dsp] of [['A', null], [null, 'Alpha'], ['A', 'Alpha']]) {
      const focused = polygonStyle(p, clearSelection(), mode, station, dsp);
      assert.deepEqual(focused, { ...normal, ...POLYGON_STYLE.focused, fillColor: mode === 'difficulty' ? normal.fillColor : polygonStyle(p, selectRoute(1), mode).fillColor });
      assert.ok(mode === 'route' ? focused.fillOpacity === normal.fillOpacity : focused.fillOpacity > normal.fillOpacity);
      assert.ok(mode === 'route' ? focused.opacity === normal.opacity : focused.opacity > normal.opacity);
    }
    for (const [station, dsp] of [['B', 'Alpha'], ['A', 'Beta'], ['B', 'Beta']]) {
      const dim = polygonStyle(p, clearSelection(), mode, station, dsp);
      assert.deepEqual(dim, { ...normal, ...(station === 'B' ? POLYGON_STYLE.outside : POLYGON_STYLE.dimmed), fillColor: polygonStyle(p, selectRoute(2), mode).fillColor });
      assert.ok(dim.fillOpacity < normal.fillOpacity && dim.opacity < normal.opacity);
    }
    assert.deepEqual(polygonStyle(p, selectRoute(1), mode, 'B', 'Beta'), polygonStyle(p, selectRoute(1), mode));
  }
});

test('R2a route label suffixes remove leading zeros and treat empty names as absent', () => {
  for (const [name, text] of [['SFO01-021', '21'], ['RNO01-003', '3'], ['X-000', '0'], ['A12', 'A12'], ['X-A12', 'A12'], ['SMF01-009', '9'], ['A-B-007', '7'], ['Route', 'Route'],
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
  assert.equal(anchors[0].weight, 8); assert.equal(anchors[0].text, '1');
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
  assert.equal(multi.weight, 4);
  assert.equal(parts.some(([ring]) => contains(multi.latlng.toReversed(), ring)), true);
  const [withHole] = routeLabelAnchors([labelFeature(3, [[outer, hole], [box(10, 0, 1, 1)]], 'MultiPolygon')]);
  assert.equal(withHole.weight, 12);
  assert.ok(contains(withHole.latlng.toReversed(), outer) && !contains(withHole.latlng.toReversed(), hole));
});

test('R2a concave C-shaped ZIP uses the interior grid when its outer-ring centroid lies outside', () => {
  const c = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [4, 3], [4, 4], [0, 4], [0, 0]];
  const [anchor] = routeLabelAnchors([labelFeature(1, [c])]);
  assert.equal(contains(anchor.latlng.toReversed(), c), true);
  assert.equal(anchor.weight, 10);
});


test('RM10 regions retain significant islands, cap at three and preserve regional interior points', () => {
  const rings = [box(0, 0, 2, 2), box(10, 0, 1, 1), box(20, 0, 0.9, 1)];
  const features = rings.map(ring => labelFeature(1, [ring]));
  const original = structuredClone(features);
  const anchors = routeLabelAnchors(features);
  assert.deepEqual(features, original);
  assert.equal(anchors.length, 2);
  assert.deepEqual(anchors.map(a => a.primary), [true, false]);
  anchors.forEach((anchor, i) => assert.ok(contains(anchor.latlng.toReversed(), rings[i])));
  assert.deepEqual(anchors.map(a => a.weight), [4, 1]);
  const many = [0, 10, 20, 30, 40].map(x => labelFeature(1, [box(x, 0, 1, 1)]));
  assert.equal(routeLabelAnchors(many).length, 3);
  assert.equal(routeLabelAnchors([labelFeature(1, rings.map(r => [r]), 'MultiPolygon')]).length, 2);
});

test('RM10 bounding boxes merge transitively within tolerance and separate beyond it', () => {
  const joined = [0, 1.009, 2.018].map(x => labelFeature(1, [box(x, 0, 1, 1)]));
  const anchors = routeLabelAnchors(joined);
  assert.equal(anchors.length, 1); assert.equal(anchors[0].weight, 3);
  assert.equal(routeLabelAnchors([labelFeature(1, [box(0, 0, 1, 1)]),
    labelFeature(1, [box(1.011, 0, 1, 1)])]).length, 2);
});


test('RM11 assignment deduplicates closing vertices, ignores corners, preserves hash, is deterministic and pure', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `route-${i}`);
  const a = ids[0], b = ids.find(id => id !== a && routeColor(id) === routeColor(a));
  const feature = (id, x, y) => ({ properties: { route_id: id }, geometry: { type: 'Polygon', coordinates: [box(x, y, 1, 1)] } });
  const adjacent = [feature(a, 0, 0), feature(b, 1, 0)];
  const before = structuredClone(adjacent), colors = assignRouteColors(adjacent);
  assert.notEqual(colors.get(a), colors.get(b));
  assert.deepEqual(assignRouteColors(adjacent.toReversed()), colors);
  assert.deepEqual(adjacent, before);
  for (const features of [[feature(a, 0, 0), feature(b, 1, 1)], [feature(a, 0, 0), feature(b, 4, 4)]]) {
    const result = assignRouteColors(features);
    assert.equal(result.get(a), routeColor(a)); assert.equal(result.get(b), routeColor(b));
  }
  assert.deepEqual(assignRouteColors([]), new Map());
  assert.ok(Object.isFrozen(ROUTE_COLOR_ASSIGN));
  assert.equal(ROUTE_COLOR_ASSIGN.minDeltaE, 30);
});

test('RM11 target, RM12 active, dimmed transforms and missing assignment fallback', () => {
  const p = { route_id: 1, postal_code: '00001' };
  const colors = new Map([[1, '#66c2a5']]);
  const normal = polygonStyle(p, clearSelection(), 'route', null, null, colors);
  assert.equal(normal.fillColor, '#66c2a5');
  const target = polygonStyle(p, selectRoute(1), 'route', null, null, colors);
  const dim = polygonStyle(p, selectRoute(2), 'route', null, null, colors);
  assert.equal(target.fillOpacity, .85); assert.equal(dim.fillOpacity, .15);
  assert.equal(normal.fillColor, '#66c2a5'); assert.equal(target.fillColor, '#66c2a5'); assert.equal(dim.fillColor, '#92b5aa');
  assert.equal(polygonStyle({ ...p, station: 'A' }, clearSelection(), 'route', 'A', null, colors).fillOpacity, .6);
  assert.equal(polygonStyle(p, clearSelection(), 'route', 'A', null, colors).fillOpacity, .05);
  assert.equal(polygonStyle(p, clearSelection(), 'route', null, 'Alpha', colors).fillOpacity, .15);
  assert.equal(polygonStyle(p, selectZip(p), 'route', null, null, colors).fillColor, target.fillColor);
  assert.deepEqual(polygonStyle(p, clearSelection(), 'route', null, null, new Map()), polygonStyle(p));
  for (const selection of [clearSelection(), selectRoute(1), selectRoute(2), selectZip(p)]) {
    assert.equal(polygonStyle(p, selection, 'difficulty', null, null, colors).fillColor, '#9ca3af');
  }
});


// Independent matrix reference for CIE76 checks, including an overconstrained clique.
function referenceLab(hex) {
  const rgb = vividRouteColor(hex).match(/[a-f0-9]{2}/g).map(h => parseInt(h, 16) / 255)
    .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  const xyz = [[.4124564, .3575761, .1804375], [.2126729, .7151522, .072175], [.0193339, .119192, .9503041]]
    .map((row, i) => row.reduce((sum, c, j) => sum + c * rgb[j], 0) / [.95047, 1, 1.08883][i])
    .map(t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}
const deltaE = (a, b) => Math.hypot(...referenceLab(a).map((v, i) => v - referenceLab(b)[i]));

test('RM11 CIE76 threshold, cyclic first-fit and maximin fallback follow degree/string order', () => {
  const ids = Array.from({ length: 24 }, (_, i) => `mock-${String(i).padStart(2, '0')}`);
  const features = ids.toReversed().map(route_id => ({ properties: { route_id }, geometry: {
    type: 'MultiPolygon', coordinates: [[box(0, 0, 1, 1)]] } }));
  const assigned = assignRouteColors(features), prior = [];
  let changed = false, fallback = false;
  assert.deepEqual([...assigned.keys()], ids);
  for (const id of ids) {
    const preferred = palette.indexOf(routeColor(id));
    const candidates = palette.map((_, i) => palette[(preferred + i) % palette.length]);
    const scores = candidates.map(color => Math.min(...prior.map(other => deltaE(color, other))));
    const first = scores.findIndex(score => score >= 30);
    const index = first >= 0 ? first : scores.indexOf(Math.max(...scores));
    assert.equal(assigned.get(id), candidates[index]);
    if (first < 0) fallback = true;
    if (first >= 0 && candidates[index] !== routeColor(id)) {
      changed = true; assert.ok(prior.every(color => deltaE(color, assigned.get(id)) >= 30));
    }
    prior.push(assigned.get(id));
  }
  assert.ok(changed); assert.ok(fallback);
  assert.deepEqual(assignRouteColors(features.toReversed()), assigned);
  const precision = [
    { properties: { route_id: 'a' }, geometry: { type: 'Polygon', coordinates: [box(0, 0, 1, 1)] } },
    { properties: { route_id: 'b' }, geometry: { type: 'Polygon', coordinates: [box(1.000001, 0, 1, 1)] } },
  ];
  const pair = assignRouteColors(precision);
  assert.ok(deltaE(pair.get('a'), pair.get('b')) >= 30);
});

test('RM12 All Stations matches focused route style while difficulty and explicit states stay unchanged', () => {
  const p = { route_id: 1, station: 'A', dsp_name: 'Alpha', postal_code: '00001' };
  const colors = new Map([[1, '#66c2a5']]);
  const style = (selection = clearSelection(), mode = 'route', station = null, dsp = null) =>
    polygonStyle(p, selection, mode, station, dsp, colors);
  const expected = (base, fillColor) => ({ fillColor, fillOpacity: base.fillOpacity,
    color: base.color, weight: base.weight, opacity: base.opacity });
  assert.deepEqual(style(), expected(POLYGON_STYLE.focused, '#66c2a5'));
  assert.deepEqual(style(), style(clearSelection(), 'route', 'A'));
  assert.deepEqual(style(clearSelection(), 'difficulty'), {
    ...expected(POLYGON_STYLE.normal, '#9ca3af'), fillOpacity: POLYGON_STYLE.normal.difficultyFillOpacity });
  for (const mode of ['route', 'difficulty']) {
    const target = mode === 'route' ? '#66c2a5' : '#9ca3af';
    const dimmed = mode === 'route' ? '#92b5aa' : '#9ca3af';
    for (const [station, dsp] of [['A', null], [null, 'Alpha'], ['A', 'Alpha']])
      assert.deepEqual(style(clearSelection(), mode, station, dsp), expected(POLYGON_STYLE.focused, target));
    for (const [station, dsp] of [['B', null], [null, 'Beta'], ['A', 'Beta']])
      assert.deepEqual(style(clearSelection(), mode, station, dsp), expected(station === 'B' ? POLYGON_STYLE.outside : POLYGON_STYLE.dimmed, dimmed));
    for (const [selection, base, fill] of [[selectRoute(1), POLYGON_STYLE.selectedRoute, target],
      [selectZip(p), POLYGON_STYLE.selectedZip, target], [selectRoute(2), POLYGON_STYLE.outside, dimmed]])
      assert.deepEqual(style(selection, mode, 'B', 'Beta'), expected(base, fill));
  }
  assert.deepEqual(hoverStyle(style()), { ...style(), color: POLYGON_STYLE.hover.color,
    opacity: POLYGON_STYLE.hover.opacity, weight: POLYGON_STYLE.hover.weight,
    fillOpacity: POLYGON_STYLE.focused.fillOpacity + POLYGON_STYLE.hover.fillOpacityIncrease });
});


test('MVR palette preserves all 19 FNV slots and uses identity target transforms', () => {
  assert.deepEqual(palette, '#57a3ef #e27897 #9da837 #9292f0 #e57d64 #60b56b #bd83d9 #d68c33 #00b9a0 #da7ab0 #b49f23 #779bf2 #e6797e #81af50 #a98ae7 #e0834a #35b886 #cd7ec6 #c79521'.split(' '));
  for (const [id, slot] of [[1, 17], [2, 12], ['a', 17], ['', 12]]) assert.equal(routeColor(id), palette[slot]);
  assert.equal(ROUTE_FILL.saturation, 1); assert.equal(ROUTE_FILL.lightness, 0);
  assert.deepEqual(ROUTE_FILL.target, { saturation: 1, lightness: 0 });
  assert.deepEqual(ROUTE_FILL.dimmed, { saturation: .45, lightness: .06 });
  for (const hex of palette) {
    assert.equal(vividRouteColor(hex), hex);
    assert.equal(polygonStyle({ route_id: 1 }, selectRoute(1), 'route', null, null, new Map([[1, hex]])).fillColor, hex);
  }
});

test('MVR outside stays behind selection and ahead of fading in both modes', () => {
  const p = { route_id: 1, station: 'A', dsp_name: 'Alpha', postal_code: '00001' };
  for (const mode of ['route', 'difficulty']) {
    for (const selection of [clearSelection(), selectRoute(2)]) {
      const style = polygonStyle(p, selection, mode, 'B', 'Beta');
      const { fillColor, ...border } = style;
      assert.deepEqual(border, POLYGON_STYLE.outside);
      assert.deepEqual(hoverStyle(style), { ...style, color: '#ffffff', opacity: 1, weight: 2, fillOpacity: .25 });
      assert.equal(polygonStyle(p, selection, mode, null, 'Beta').fillOpacity, .15);
    }
    assert.equal(polygonStyle(p, selectRoute(1), mode, 'B', 'Beta').fillOpacity, .85);
    assert.equal(polygonStyle(p, selectZip(p), mode, 'B', 'Beta').fillOpacity, .9);
    assert.equal(hoverStyle(polygonStyle(p, selectZip(p), mode)).fillOpacity, .9);
  }
});


test('MVR-T5 DSP keys and deterministic unique group allocations preserve preferred slots', async () => {
  const { dspColorKey, assignGroupColors, modeColor, UNASSIGNED_COLOR } = await import('../../web/map-state.js');
  for (const name of ['SFO-AAS', 'SFO02-AAS', 'DEN-AAS', 'AAS']) assert.equal(dspColorKey(name), 'AAS');
  for (const name of [null, undefined, '']) assert.equal(dspColorKey(name), null);
  const features = Array.from({ length: 24 }, (_, i) => ({ properties: { station: `G${i}`, postal_code: String(i) } }));
  const before = structuredClone(features), key = p => p.station;
  const colors = assignGroupColors(features, key);
  assert.deepEqual(features, before);
  assert.deepEqual(colors, assignGroupColors(features.toReversed(), key));
  assert.equal(new Set(assignGroupColors(features.slice(0, 19), key).values()).size, 19);
  assert.equal(colors.size, 24);
  assert.ok([...colors.values()].every(color => palette.includes(color)));
  assert.equal(assignGroupColors([features[0]], key).get('G0'), routeColor('G0'));
  assert.equal(modeColor({ station: 'G0' }, 'station'), routeColor('G0'));
  assert.equal(modeColor({}, 'dsp'), UNASSIGNED_COLOR);
  assert.deepEqual(assignGroupColors([], key), new Map());
});


test('MVR-T5 groups use a/b/c/d cyclic choices including global spacing and reuse', async () => {
  const { assignGroupColors, GROUP_COLOR_ASSIGN } = await import('../../web/map-state.js');
  assert.deepEqual(GROUP_COLOR_ASSIGN, { minGlobalDeltaE: 20 });
  assert.ok(Object.isFrozen(GROUP_COLOR_ASSIGN));
  const keys = Array.from({ length: 28 }, (_, i) => `group-${String(i).padStart(2, '0')}`);
  const branches = new Set();
  // Clique forces c/d; isolated groups force b once global spacing is exhausted.
  for (const connected of [true, false]) {
    const features = keys.map(station => ({ properties: { station },
      ...(connected ? { geometry: { type: 'Polygon', coordinates: [box(0, 0, 1, 1)] } } : {}) }));
    const assigned = assignGroupColors(features, p => p.station), used = [];
    for (const key of keys) {
      const start = palette.indexOf(routeColor(key));
      const candidates = palette.map((_, i) => palette[(start + i) % palette.length]);
      const available = candidates.filter(color => !used.includes(color));
      const score = color => Math.min(...(connected ? used : []).map(other => deltaE(color, other)));
      const global = available.find(color => score(color) >= 30 && used.every(other => deltaE(color, other) >= 20));
      const adjacent = available.find(color => score(color) >= 30);
      const pool = available.length ? available : candidates;
      const bestScore = Math.max(...pool.map(score));
      const expected = global || adjacent || pool.find(color => score(color) === bestScore);
      branches.add(global ? 'a' : adjacent ? 'b' : available.length ? 'c' : 'd');
      assert.equal(assigned.get(key), expected);
      used.push(expected);
    }
    assert.deepEqual(assignGroupColors(features.toReversed(), p => p.station), assigned);
  }
  assert.deepEqual([...branches].sort(), ['a', 'b', 'c', 'd']);
});

test('MVR-T5 adjacent near preferred colors change even when the slot is unused', async () => {
  const { assignGroupColors } = await import('../../web/map-state.js');
  const keys = Array.from({ length: 100 }, (_, i) => `near-${i}`).sort();
  const a = keys[0], b = keys.find(key => key > a && routeColor(key) !== routeColor(a)
    && deltaE(routeColor(a), routeColor(key)) < 30);
  assert.ok(b);
  const features = [a, b].map((station, i) => ({ properties: { station },
    geometry: { type: 'Polygon', coordinates: [box(i, 0, 1, 1)] } }));
  const colors = assignGroupColors(features, p => p.station);
  assert.equal(colors.get(a), routeColor(a));
  assert.notEqual(colors.get(b), routeColor(b));
  assert.ok(deltaE(colors.get(a), colors.get(b)) >= 30);
});

test('MVR-T5 DSatur prioritizes assigned neighbors then degree, ZIP count and key', async () => {
  const { assignGroupColors } = await import('../../web/map-state.js');
  const edges = [['A', 'B'], ['B', 'C'], ['A', 'C'], ['A', 'D'], ['D', 'E']];
  const features = edges.flatMap(([a, b], i) => [a, b].map(station => ({ properties: { station },
    geometry: { type: 'Polygon', coordinates: [box(i * 3, 0, 1, 1)] } })));
  const colors = assignGroupColors(features, p => p.station);
  assert.deepEqual([...colors.keys()], ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(assignGroupColors(features.toReversed(), p => p.station), colors);
  const popular = [...features, { properties: { station: 'D' } }];
  assert.deepEqual([...assignGroupColors(popular, p => p.station).keys()], ['A', 'D', 'B', 'C', 'E']);
});

test('MVR-T5 group modes preserve route state hierarchy, outlines and hover', () => {
  const p = { route_id: 1, postal_code: '00001', station: 'A', dsp_name: 'X-AAS' };
  for (const mode of ['dsp', 'station']) {
    for (const selection of [clearSelection(), selectRoute(1), selectRoute(2), selectZip(p)]) {
      for (const [station, dsp] of [[null, null], ['A', null], ['B', 'Other'], [null, 'Other']]) {
        const { fillColor: routeColor, ...expected } = polygonStyle(p, selection, 'route', station, dsp);
        const { fillColor, ...actual } = polygonStyle(p, selection, mode, station, dsp);
        assert.deepEqual(actual, expected);
        assert.equal(hoverStyle({ fillColor, ...actual }).fillOpacity,
          hoverStyle({ fillColor: routeColor, ...expected }).fillOpacity);
      }
    }
  }
});

test('MVR-P4 polygon constants match the daytime basemap specification', () => {
  assert.deepEqual(POLYGON_STYLE, {
    normal: { fillOpacity: .34, difficultyFillOpacity: .55, color: '#0A101E', opacity: .55, weight: .8 },
    focused: { fillOpacity: .6, color: '#0A101E', opacity: .6, weight: .8 },
    hover: { fillOpacityIncrease: .2, color: '#ffffff', opacity: 1, weight: 2 },
    selectedRoute: { fillOpacity: .85, color: '#0A101E', opacity: .9, weight: 1.2 },
    selectedZip: { fillOpacity: .9, color: '#334155', opacity: 1, weight: 3 },
    dimmed: { fillOpacity: .15, color: '#0A101E', opacity: .25, weight: .6 },
    outside: { fillOpacity: .05, color: '#0A101E', opacity: .12, weight: .5 },
  });
});


test('MVR-T9 shared vertex index exactly preserves all legacy allocations', async () => {
  const { assignAllColors, assignGroupColors, dspColorKey } = await import('../../web/map-state.js');
  const features = Array.from({ length: 80 }, (_, i) => {
    const x = i % 10, y = Math.floor(i / 10);
    return { properties: { route_id: i % 17, station: `S${i % 4}`, dsp_name: i % 9 ? `S-D${i % 7}` : null },
      geometry: { type: 'Polygon', coordinates: [[[x,y],[x+1,y],[x+1,y+1],[x,y+1],[x,y]]] } };
  });
  for (const input of [features, features.toReversed(), []]) {
    const result = assignAllColors(input);
    assert.deepEqual(result.routeColors, assignRouteColors(input));
    assert.deepEqual(result.groupColors.dsp, assignGroupColors(input, p => dspColorKey(p.dsp_name)));
    assert.deepEqual(result.groupColors.station, assignGroupColors(input, p => p.station));
  }
});
