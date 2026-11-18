// Group prices in five-cent steps and interpolate colors across the district range (MPC-D8/D9).
export const PRICE_RAMP = Object.freeze(['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026']);
export const PRICE_COLORS = Object.freeze({
  none: '#9ca3af',
});

function rampColor(position) {
  const offset = position * (PRICE_RAMP.length - 1);
  const lower = Math.floor(offset), upper = Math.min(lower + 1, PRICE_RAMP.length - 1);
  const fraction = offset - lower;
  const channels = [1, 3, 5].map(start => {
    const a = parseInt(PRICE_RAMP[lower].slice(start, start + 2), 16);
    const b = parseInt(PRICE_RAMP[upper].slice(start, start + 2), 16);
    return Math.round(a + (b - a) * fraction).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

export const priceCents = value => typeof value === 'number' && Number.isFinite(value)
  ? Math.round(value * 100) : null;

export function priceBin(value, scale) {
  const cents = priceCents(value);
  if (cents === null || !scale || scale.empty) return null;
  return Math.max(0, Math.min(scale.bins.length - 1, Math.floor(cents / 5) - scale.minStep));
}

export function priceScale(features) {
  const prices = features.map(f => priceCents(f?.properties?.current_first_0_1lb_price))
    .filter(value => value !== null);
  if (!prices.length) return Object.freeze({ empty: true, minCents: null, maxCents: null, bins: Object.freeze([]) });
  const scale = { empty: false, minCents: Math.min(...prices), maxCents: Math.max(...prices) };
  scale.minStep = Math.floor(scale.minCents / 5);
  const count = Math.floor(scale.maxCents / 5) - scale.minStep + 1;
  const bins = Array.from({ length: count }, (_, index) => ({ index, color: rampColor(count === 1 ? 0.5 : index / (count - 1)), minCents: null, maxCents: null, count: 0 }));
  scale.bins = bins;
  for (const cents of prices) {
    const bin = bins[priceBin(cents / 100, scale)];
    bin.minCents = bin.minCents === null ? cents : Math.min(bin.minCents, cents);
    bin.maxCents = bin.maxCents === null ? cents : Math.max(bin.maxCents, cents);
    bin.count++;
  }
  scale.bins = Object.freeze(bins.map(Object.freeze));
  return Object.freeze(scale);
}

export function priceColor(value, scale) {
  const index = priceBin(value, scale);
  return index === null ? PRICE_COLORS.none : scale.bins[index].color;
}

export function priceLegend(scale) {
  if (!scale) return [];
  const format = cents => `$${(cents / 100).toFixed(2)}`;
  return scale.bins.filter(bin => bin.count > 0).map(bin => ({
    index: bin.index, color: bin.color,
    label: bin.minCents === bin.maxCents ? format(bin.minCents) : `${format(bin.minCents)}–${format(bin.maxCents)}`,
    count: bin.count,
  }));
}
