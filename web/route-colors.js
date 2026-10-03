// Frozen since RM2: changing the palette length changes every Route's color.
// RM3 light-map adjustments (same hue families, same slots):
// #ffffb3 -> #c4a62a, #fccde5 -> #d875a8, #ccebc5 -> #71ad68, #ffed6f -> #d9b52c.
export const palette = Object.freeze([
  '#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494',
  '#8dd3c7', '#c4a62a', '#bebada', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#d875a8',
  '#bc80bd', '#71ad68', '#d9b52c', '#6ed0ed',
]);

export function routeColor(routeId) {
  let hash = 0x811c9dc5;
  const text = String(routeId);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return palette[hash % palette.length];
}
