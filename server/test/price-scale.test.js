import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_RAMP, PRICE_COLORS, priceCents, priceScale, priceBin, priceColor, priceLegend } from '../../web/price-scale.js';

const features = values => values.map(value => ({ properties: { current_first_0_1lb_price: value } }));

test('price colors use the approved palette', () => {
  assert.deepEqual(PRICE_RAMP, ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026']);
  assert.deepEqual(PRICE_COLORS, { none: '#9ca3af' });
});

test('price cents accept only finite numbers', () => {
  for (const [value, cents] of [[1.55, 155], [2.2, 220], [1.15, 115], [0.1 + 0.2, 30], [0, 0], [-1.5, -150]]) {
    assert.equal(priceCents(value), cents);
  }
  for (const value of [null, undefined, '1.55', NaN, Infinity, -Infinity]) assert.equal(priceCents(value), null);
});

test('north-cal boundaries use integer cents and clamp outside prices', () => {
  const scale = priceScale(features([1.55, 1.68, 1.69, 1.81, 1.82, 2.2]));
  assert.equal(scale.minCents, 155); assert.equal(scale.maxCents, 220);
  for (const [value, bin] of [[1, 0], [1.55, 0], [1.67, 2], [1.68, 2], [1.69, 2], [1.81, 5], [1.82, 5], [2.2, 13], [3, 13]]) {
    assert.equal(priceBin(value, scale), bin);
  }
  assert.equal(priceColor('1.55', scale), PRICE_COLORS.none);
  assert.equal(priceColor(2.2, scale), PRICE_RAMP.at(-1));
});

test('phoenix prices populate bins and legends use actual ranges', () => {
  const values = [1.75, 1.8, 1.85, 1.9, 1.95, 2, 2.05];
  const scale = priceScale(features(values));
  assert.deepEqual(values.map(value => priceBin(value, scale)), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(priceLegend(scale).map(({ label, count }) => [label, count]), values.map(value => [`$${value.toFixed(2)}`, 1]));
  const sparse = priceScale(features([1.75, 2.05]));
  assert.deepEqual(sparse.bins.map(bin => bin.count), [1, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(priceLegend(sparse).map(bin => bin.index), [0, 6]);
});

test('single price uses middle bin and freezes the complete scale', () => {
  const scale = priceScale(features([1.85, 1.85]));
  assert.equal(priceBin(1.85, scale), 0);
  assert.deepEqual(priceLegend(scale), [{ index: 0, color: PRICE_RAMP[4], label: '$1.85', count: 2 }]);
  assert.ok(Object.isFrozen(PRICE_COLORS) && Object.isFrozen(PRICE_RAMP));
  assert.ok(Object.isFrozen(scale) && Object.isFrozen(scale.bins) && scale.bins.every(Object.isFrozen));
});

test('no prices produce a frozen empty scale and neutral color', () => {
  const scale = priceScale([...features([null, null, '2', NaN]), {}, null]);
  assert.deepEqual(scale, { empty: true, minCents: null, maxCents: null, bins: [] });
  assert.ok(Object.isFrozen(scale) && Object.isFrozen(scale.bins));
  assert.equal(priceBin(1.85, scale), null);
  assert.equal(priceColor(1.85, scale), PRICE_COLORS.none);
  assert.deepEqual(priceLegend(scale), []);
});
test('missing scale is treated as no price', async () => {
  const { priceBin, priceColor, priceLegend, PRICE_COLORS } = await import('../../web/price-scale.js');
  for (const scale of [null, undefined]) {
    assert.equal(priceBin(1.5, scale), null);
    assert.equal(priceColor(1.5, scale), PRICE_COLORS.none);
    assert.deepEqual(priceLegend(scale), []);
  }
});

test('five-cent bins interpolate the full ramp and group intermediate prices', () => {
  const scale = priceScale(features([1.55, 1.60, 1.62, 1.65, 1.68, 2.20]));
  assert.equal(scale.bins.length, 14);
  assert.equal(priceBin(1.60, scale), priceBin(1.62, scale));
  assert.equal(priceBin(1.65, scale), priceBin(1.68, scale));
  assert.equal(scale.bins[0].color, PRICE_RAMP[0]);
  assert.equal(scale.bins.at(-1).color, PRICE_RAMP.at(-1));
  assert.deepEqual(priceLegend(scale).slice(1, 3).map(bin => bin.label), ['$1.60–$1.62', '$1.65–$1.68']);
  const luminance = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  assert.ok(scale.bins.every((bin, i) => i === 0 || luminance(bin.color) < luminance(scale.bins[i - 1].color)));
});
