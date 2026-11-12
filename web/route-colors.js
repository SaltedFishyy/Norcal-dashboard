// MVR replaces all color values once with an equal-lightness OKLCH palette.
// The 19 slots and FNV-1a hash remain unchanged since RM2.
export const palette = Object.freeze([
  '#57a3ef', '#e27897', '#9da837', '#9292f0', '#e57d64', '#60b56b', '#bd83d9',
  '#d68c33', '#00b9a0', '#da7ab0', '#b49f23', '#779bf2', '#e6797e', '#81af50', '#a98ae7',
  '#e0834a', '#35b886', '#cd7ec6', '#c79521',
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
