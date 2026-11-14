import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLabelRules, buildPaintRules, peakLabel } from '../../web/basemap-rules.js';
import { createStaticReader, isStaticPath } from '../src/api/static-files.js';
const waterPaint = { dataLayer: 'water' }, waterLinePaint = { dataLayer: 'water', minzoom: 14 };
const basePaint = { dataLayer: 'roads' }, baseLabel = { dataLayer: 'places' };
class Symbolizer {
  constructor(options) { this.options = options; }
  place(layout, geom, feature) { return { layout, geom, feature, options: this.options }; }
}
const protomaps = { LineSymbolizer: Symbolizer, CenteredTextSymbolizer: Symbolizer, LineLabelSymbolizer: Symbolizer,
  paintRules: () => [waterPaint, waterLinePaint, basePaint], labelRules: () => [baseLabel, { dataLayer: 'water', old: true }] };
const flavor = { water: '#aadaff' };
const labels = buildLabelRules(protomaps, flavor, 'en');
const feature = (kind, props = {}, geomType = 1) => ({ geomType, props: { kind, name: 'Local', ...props } });
const matches = (layer, zoom, f) => labels.filter(r => r.dataLayer === layer && r.filter?.(zoom, f));

test('MVR-P7 natural POI whitelist, geometry and source zoom thresholds', () => {
  for (const kind of ['peak', 'volcano']) {
    assert.equal(matches('pois', 10, feature(kind)).length, 0);
    assert.equal(matches('pois', 11, feature(kind)).length, 1);
    assert.equal(matches('pois', 11, feature(kind, { min_zoom: 12 })).length, 0);
  }
  for (const kind of ['forest', 'nature_reserve', 'national_park', 'protected_area', 'park']) {
    assert.equal(matches('pois', 7, feature(kind, { min_zoom: 8 })).length, 0);
    assert.equal(matches('pois', 8, feature(kind, { min_zoom: 8 })).length, 1);
    assert.equal(matches('pois', 8, feature(kind, { min_zoom: 9 })).length, 0);
  }
  assert.equal(matches('pois', 15, feature('park', { min_zoom: 10 })).length, 1);
  for (const min_zoom of [11, undefined]) assert.equal(matches('pois', 15, feature('park', { min_zoom })).length, 0);
  for (const kind of ['restaurant', 'school', 'hospital', 'shop']) assert.equal(matches('pois', 20, feature(kind)).length, 0);
  assert.equal(matches('pois', 15, feature('forest', {}, 3)).length, 0);
});

test('MVR-P7 water rules replace built-ins without duplicates and respect zoom', () => {
  assert.ok(labels.includes(baseLabel));
  assert.ok(!labels.some(r => r.old));
  for (const kind of ['ocean', 'bay', 'strait', 'fjord', 'sea', 'lake', 'water']) {
    assert.equal(matches('water', 10, feature(kind)).length, 1);
    assert.equal(matches('water', 10, feature(kind, {}, 3)).length, 0);
  }
  const oceanStyle = matches('water', 10, feature('bay'))[0].symbolizer.options;
  const lakeStyle = matches('water', 10, feature('lake'))[0].symbolizer.options;
  assert.match(oceanStyle.font, /italic 15px/);
  assert.match(lakeStyle.font, /italic 14px/);
  assert.equal(oceanStyle.stroke, '#ffffff');
  assert.equal(oceanStyle.width, 2);
  assert.equal(matches('water', 8, feature('lake')).length, 0);
  assert.equal(matches('water', 9, feature('lake')).length, 1);
  assert.equal(matches('water', 9, feature('lake', { min_zoom: 10 })).length, 1);
  assert.equal(matches('water', 8, feature('lake', { min_zoom: 10 })).length, 0);
  assert.equal(matches('water', 9, feature('bay', { min_zoom: 10 })).length, 1);
  assert.equal(matches('water', 10, feature('river', {}, 2)).length, 0);
  const [river] = matches('water', 11, feature('river', {}, 2));
  assert.ok(river.symbolizer instanceof protomaps.LineLabelSymbolizer);
  assert.deepEqual(river.symbolizer.options.labelProps, ['name:en', 'name']);
  assert.equal(matches('water', 15, feature('stream', {}, 2)).length, 0);
  const paint = buildPaintRules(protomaps, flavor);
  assert.deepEqual([paint[0], paint[1], paint[3]], [waterPaint, waterLinePaint, basePaint]);
  const rule = paint[2];
  for (const z of [8, 14, 15]) assert.equal(rule.filter(z, feature('river', {}, 2)), false);
  for (const z of [9, 10, 13, 13.9]) assert.equal(rule.filter(z, feature('river', {}, 2)), true);
  assert.equal(rule.filter(12, feature('stream', {}, 2)), false);
  assert.equal(rule.filter(12, feature('river')), false);
  assert.equal(rule.symbolizer.options.color, '#8cc8f5');
  assert.equal(rule.symbolizer.options.width(9), 1);
  assert.equal(rule.symbolizer.options.width(11), 1.75);
  assert.equal(rule.symbolizer.options.width(13), 2.5);
  assert.ok(rule.symbolizer.options.width(13) > rule.symbolizer.options.width(9));
});

test('MVR-P7 peak text uses English fallback and rounded metres without mutating source', () => {
  const f = feature('peak', { 'name:en': 'Mount Diablo', elevation: 1173.6 });
  assert.equal(peakLabel(f), '▲ Mount Diablo · 1174 m');
  for (const elevation of [undefined, null, '', 'unknown']) assert.equal(peakLabel(feature('peak', { elevation })), '▲ Local');
  assert.equal(peakLabel(feature('peak', { elevation: 0 })), '▲ Local · 0 m');
  const [rule] = matches('pois', 12, f);
  const placed = rule.symbolizer.place({}, [], f);
  assert.equal(placed.feature.props.natural_peak_label, peakLabel(f));
  assert.equal(f.props.natural_peak_label, undefined);
  assert.deepEqual(placed.options.labelProps, ['natural_peak_label']);
});

test('MVR-P7 natural-rule ES module is served through the static allowlist', async () => {
  assert.ok(isStaticPath('/basemap-rules.js'));
  const asset = await createStaticReader(fileURLToPath(new URL('../../web/', import.meta.url)))('/basemap-rules.js');
  assert.match(asset.contentType, /text\/javascript/);
  assert.match(asset.body.toString(), /export function buildLabelRules/);
});

test('MVR-P7 river labels reserve collision priority and use supported text parameters', () => {
  const [river] = matches('water', 11, feature('river', { name: 'Sacramento River', min_zoom: 10 }, 2));
  assert.ok(labels.indexOf(river) < labels.indexOf(baseLabel));
  assert.deepEqual(river.symbolizer.options, {
    labelProps: ['name:en', 'name'], fill: '#286b9b', font: 'italic 12px sans-serif', stroke: '#ffffff', width: 2,
  });
});

test('MVR-P7 POI water labels use lake styling at z12 and retain source zoom', () => {
  assert.equal(matches('pois', 11, feature('water', { min_zoom: 10 })).length, 0);
  assert.equal(matches('pois', 12, feature('water', { min_zoom: 13 })).length, 0);
  const [lake] = matches('pois', 12, feature('water', { min_zoom: 12 }));
  assert.deepEqual(lake.symbolizer.options, matches('water', 12, feature('lake'))[0].symbolizer.options);
  assert.equal(matches('pois', 12, feature('water', {}, 3)).length, 0);
  assert.equal(matches('pois', 12, feature('lake')).length, 0);
});
