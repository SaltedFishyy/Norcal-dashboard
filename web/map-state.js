import { palette, routeColor } from './route-colors.js';
import { difficultyColor, difficultyLevel } from './difficulty.js';

export const clearSelection = (station = null) => ({ station, route: null, zip: null });
export const selectRoute = (route, station = route?.station ?? null) => ({ station,
  route: typeof route === 'object' && route !== null ? route : { route_id: route }, zip: null });
export const selectZip = (zip, station = zip.station ?? null) => ({ station,
  route: ['covered', 'covered_no_boundary'].includes(zip.status) || (!zip.status && Object.hasOwn(zip, 'route_id'))
    ? zip.route || { route_id: zip.route_id, route_name: zip.route_name, station: zip.station } : null,
  zip: { ...zip, status: zip.status || 'covered' } });
export const switchStation = station => clearSelection(station);

export function classifyQuery(input) {
  const query = input.trim();
  if (!query) return { kind: 'empty' };
  if (/^\d{5}$/.test(query)) return { kind: 'zip' };
  return /^\d{1,4}$/.test(query) ? { kind: 'route', zipHint: true } : { kind: 'route' };
}

export const uncoveredZipStyle = () => ({ fillColor: '#db2777', fillOpacity: 0.15,
  color: '#334155', weight: 5, opacity: 1, dashArray: SELECTION_OUTLINE.uncoveredDashArray });

export const SELECTION_OUTLINE = Object.freeze({ outerColor: '#0b1220', innerColor: '#ffffff',
  zipOuterWeight: 5, zipInnerWeight: 3, routeOuterWeight: 3.5, routeInnerWeight: 1.5,
  uncoveredDashArray: '8 6' });

export function selectionOutlineStyles({ zip = false, uncovered = false } = {}) {
  const c = SELECTION_OUTLINE;
  const common = { fill: false, interactive: false, bubblingMouseEvents: false, opacity: 1 };
  return [
    { ...common, color: c.outerColor, weight: zip ? c.zipOuterWeight : c.routeOuterWeight, dashArray: null },
    { ...common, color: c.innerColor, weight: zip ? c.zipInnerWeight : c.routeInnerWeight,
      dashArray: uncovered ? c.uncoveredDashArray : null },
  ];
}

export const POLYGON_STYLE = Object.freeze({
  normal: Object.freeze({ fillOpacity: 0.34, difficultyFillOpacity: 0.55, color: '#0A101E', opacity: 0.55, weight: 0.8 }),
  focused: Object.freeze({ fillOpacity: 0.6, color: '#0A101E', opacity: 0.6, weight: 0.8 }),
  hover: Object.freeze({ fillOpacityIncrease: 0.2, color: '#ffffff', opacity: 1, weight: 2 }),
  selectedRoute: Object.freeze({ fillOpacity: 0.85, color: '#0A101E', opacity: 0.9, weight: 1.2 }),
  selectedZip: Object.freeze({ fillOpacity: 0.9, color: '#334155', opacity: 1, weight: 3 }),
  dimmed: Object.freeze({ fillOpacity: 0.15, color: '#0A101E', opacity: 0.25, weight: 0.6 }),
  outside: Object.freeze({ fillOpacity: 0.05, color: '#0A101E', opacity: 0.12, weight: 0.5 }),
});

export function hoverStyle(baseStyle) {
  const c = POLYGON_STYLE;
  return { ...baseStyle, color: c.hover.color, opacity: c.hover.opacity,
    weight: c.hover.weight,
    fillOpacity: Math.min(baseStyle.fillOpacity + c.hover.fillOpacityIncrease, c.selectedZip.fillOpacity) };
}

export function polygonStyle(properties, selection = clearSelection(), colorMode = 'route', focusStation = null, dsp = null, routeColors, groupColors) {
  const active = selection.route !== null;
  const selected = active && selection.route.route_id === properties.route_id;
  const faded = active ? !selected : (focusStation !== null && properties.station !== focusStation)
    || (dsp !== null && properties.dsp_name !== dsp);
  const zip = selected && selection.zip?.postal_code === properties.postal_code;
  const level = selected ? properties.zip_detail_status === 'available' ? difficultyLevel(properties.zip_difficulty) : null
    : difficultyLevel(properties.route_difficulty);
  const outside = focusStation !== null && properties.station !== focusStation && !selected;
  const style = outside ? POLYGON_STYLE.outside : faded ? POLYGON_STYLE.dimmed : zip ? POLYGON_STYLE.selectedZip
    : selected ? POLYGON_STYLE.selectedRoute
      : (focusStation !== null || dsp !== null || colorMode !== 'difficulty') ? POLYGON_STYLE.focused : POLYGON_STYLE.normal;
  const vivid = vividRouteColor(modeColor(properties, colorMode, routeColors, groupColors, selection));
  const transform = style === POLYGON_STYLE.normal ? null : (style === POLYGON_STYLE.dimmed || style === POLYGON_STYLE.outside) ? ROUTE_FILL.dimmed : ROUTE_FILL.target;
  return { fillColor: colorMode === 'difficulty' ? difficultyColor(level) : transform ? transformRouteColor(vivid, transform) : vivid,
    fillOpacity: style === POLYGON_STYLE.normal && colorMode === 'difficulty' ? style.difficultyFillOpacity : style.fillOpacity,
    color: style.color, weight: style.weight, opacity: style.opacity };
}

export function searchRoutes(routes, query) {
  const term = query.trim().toLowerCase();
  const matches = routes.filter(route => (route.station + ' · ' + route.route_name).toLowerCase().includes(term))
    .sort((a, b) => a.route_name.localeCompare(b.route_name));
  return { exact: term ? matches.find(route => route.route_name.toLowerCase() === term) : undefined, matches };
}

export function filteredRoutes(routes, query, focusStation = null, dsp = null) {
  const classified = classifyQuery(query);
  return searchRoutes(routes.filter(route => ((query && classified.kind !== 'zip') || !focusStation || route.station === focusStation)
    && (dsp === null || route.dsp_name === dsp)), classified.kind === 'zip' ? '' : query);
}

export const ROUTE_FILL = Object.freeze({ saturation: 1, lightness: 0,
  target: Object.freeze({ saturation: 1, lightness: 0 }),
  dimmed: Object.freeze({ saturation: 0.45, lightness: 0.06 }) });

export const vividRouteColor = hex => transformRouteColor(hex, ROUTE_FILL);

function transformRouteColor(hex, transform) {
  const [r, g, b] = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const hue = delta === 0 ? 0 : max === r ? ((g - b) / delta + 6) % 6
    : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  const l = Math.max(0, Math.min(1, lightness + transform.lightness));
  const c = (1 - Math.abs(2 * l - 1)) * Math.min(1, saturation * transform.saturation);
  const x = c * (1 - Math.abs(hue % 2 - 1)), m = l - c / 2;
  const rgb = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x]
    : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return '#' + rgb.map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('');
}

export function routeLabelText(routeName) {
  if (typeof routeName !== 'string' || !routeName.trim()) return null;
  const suffix = routeName.slice(routeName.lastIndexOf('-') + 1);
  return /^\d+$/.test(suffix) ? suffix.replace(/^0+(?=\d)/, '') : suffix || null;
}

const geometryParts = geometry => geometry?.type === 'Polygon' ? [geometry.coordinates]
  : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];

// Translate before shoelace calculations to avoid cancellation at real-world coordinates.
function ringMoments(ring) {
  const [ox, oy] = ring[0];
  let crossSum = 0, xSum = 0, ySum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ax = a[0] - ox, ay = a[1] - oy, bx = b[0] - ox, by = b[1] - oy;
    const cross = ax * by - bx * ay;
    crossSum += cross; xSum += (ax + bx) * cross; ySum += (ay + by) * cross;
  }
  return { area: Math.abs(crossSum) / 2,
    point: crossSum ? [ox + xSum / (3 * crossSum), oy + ySum / (3 * crossSum)] : [ox, oy] };
}

function polygonMoments(rings) {
  let area = 0, x = 0, y = 0;
  rings.forEach((ring, index) => {
    const moment = ringMoments(ring), weight = moment.area * (index ? -1 : 1);
    area += weight; x += weight * moment.point[0]; y += weight * moment.point[1];
  });
  return { area, point: area > 0 ? [x / area, y / area] : null };
}

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
const inPolygon = (point, rings) => inRing(point, rings[0]) && !rings.slice(1).some(ring => inRing(point, ring));

function segmentDistanceSquared(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return (point[0] - a[0] - t * dx) ** 2 + (point[1] - a[1] - t * dy) ** 2;
}
function boundaryDistanceSquared(point, rings) {
  return Math.min(...rings.map(ring => {
    let distance = Infinity;
    for (let i = 0; i < ring.length; i++) distance = Math.min(distance, segmentDistanceSquared(point, ring[i], ring[(i + 1) % ring.length]));
    return distance;
  }));
}

function interiorPoint(parts) {
  const rings = parts.toSorted((a, b) => ringMoments(b[0]).area - ringMoments(a[0]).area)[0];
  if (!rings) return null;
  const centroid = ringMoments(rings[0]).point;
  if (inPolygon(centroid, rings) && boundaryDistanceSquared(centroid, rings) > 0) return centroid;
  const xs = rings[0].map(p => p[0]), ys = rings[0].map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  let best = null, clearance = 0;
  for (let row = 1; row <= 9; row++) for (let col = 1; col <= 9; col++) {
    const point = [minX + (maxX - minX) * col / 10, minY + (maxY - minY) * row / 10];
    if (!inPolygon(point, rings)) continue;
    const distance = boundaryDistanceSquared(point, rings);
    if (distance > clearance) { best = point; clearance = distance; }
  }
  return best;
}

export const ROUTE_LABEL_REGIONS = Object.freeze({ boundsTolerance: 0.01, secondaryAreaRatio: 0.25, maxLabels: 3 });

function labelRegions(parts) {
  const bounds = parts.map(rings => {
    const xs = rings[0].map(p => p[0]), ys = rings[0].map(p => p[1]);
    return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
  });
  const parents = parts.map((_, i) => i);
  const root = i => {
    while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; }
    return i;
  };
  const tolerance = ROUTE_LABEL_REGIONS.boundsTolerance;
  for (let i = 0; i < parts.length; i++) for (let j = 0; j < i; j++) {
    const a = bounds[i], b = bounds[j];
    if (a.left <= b.right + tolerance && b.left <= a.right + tolerance
      && a.bottom <= b.top + tolerance && b.bottom <= a.top + tolerance) parents[root(i)] = root(j);
  }
  const groups = new Map();
  parts.forEach((rings, i) => {
    const id = root(i);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push([rings]);
  });
  return [...groups.values()].map(members => ({ members,
    area: members.flat().reduce((sum, rings) => sum + Math.max(0, polygonMoments(rings).area), 0) }))
    .filter(region => region.area > 0).sort((a, b) => b.area - a.area);
}

export function routeLabelAnchors(features) {
  const routes = new Map();
  for (const feature of features) {
    const p = feature.properties, parts = geometryParts(feature.geometry);
    if (p.route_id == null || !routeLabelText(p.route_name) || !parts.length) continue;
    if (!routes.has(p.route_id)) routes.set(p.route_id, { properties: p, members: [] });
    routes.get(p.route_id).members.push(parts);
  }
  const anchors = [];
  for (const { properties: p, members: routeMembers } of routes.values()) {
    const regions = labelRegions(routeMembers.flat());
    const eligible = regions.filter(region => region.area >= regions[0].area * ROUTE_LABEL_REGIONS.secondaryAreaRatio)
      .slice(0, ROUTE_LABEL_REGIONS.maxLabels);
    for (const [index, { members }] of eligible.entries()) {
      const moments = members.flat().map(polygonMoments).filter(moment => moment.area > 0);
      const weight = moments.reduce((sum, moment) => sum + moment.area, 0);
      if (!weight) continue;
      let point = [0, 1].map(axis => moments.reduce((sum, moment) => sum + moment.point[axis] * moment.area, 0) / weight);
      if (!members.some(parts => parts.some(rings => inPolygon(point, rings) && boundaryDistanceSquared(point, rings) > 0))) {
        // Distance is to ZIP coverage, rather than its centroid (important for long, thin ZIPs).
        const nearest = members.toSorted((a, b) => Math.min(...a.map(rings => boundaryDistanceSquared(point, rings)))
          - Math.min(...b.map(rings => boundaryDistanceSquared(point, rings))));
        point = interiorPoint(nearest[0]);
      }
      if (point) anchors.push({ route_id: p.route_id, route_name: p.route_name, station: p.station,
        text: routeLabelText(p.route_name), latlng: [point[1], point[0]], weight, primary: index === 0 });
    }
  }
  return anchors;
}


export const ROUTE_COLOR_ASSIGN = Object.freeze({ minDeltaE: 30, sharedVertices: 2, coordinatePrecision: 5 });

// sRGB D65 to CIE Lab; distances are measured after the ordinary vivid transform.
function routeLab(hex) {
  const [r, g, b] = vividRouteColor(hex).slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const f = value => value > (6 / 29) ** 3 ? Math.cbrt(value) : value / (3 * (6 / 29) ** 2) + 4 / 29;
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
  const z = f((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function groupNeighbors(features, keyOf, vertexIndex) {
  const vertices = new Map(), neighbors = new Map();
  for (const feature of features) {
    const id = keyOf(feature.properties);
    if (id == null) continue;
    if (!neighbors.has(id)) neighbors.set(id, new Set());
    if (vertexIndex) continue;
    for (const rings of geometryParts(feature.geometry)) for (const ring of rings) for (const point of ring) {
      const key = point.slice(0, 2).map(value => value.toFixed(ROUTE_COLOR_ASSIGN.coordinatePrecision)).join(',');
      if (!vertices.has(key)) vertices.set(key, new Set());
      vertices.get(key).add(id);
    }
  }
  if (vertexIndex) for (const [vertex, members] of vertexIndex) {
    const ids = new Set(members.map(index => keyOf(features[index].properties)).filter(id => id != null));
    vertices.set(vertex, ids);
  }
  const shared = new Map();
  for (const ids of vertices.values()) {
    const list = [...ids];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (!shared.has(a)) shared.set(a, new Map());
      if (!shared.has(b)) shared.set(b, new Map());
      const count = (shared.get(a).get(b) || 0) + 1;
      shared.get(a).set(b, count); shared.get(b).set(a, count);
      if (count >= ROUTE_COLOR_ASSIGN.sharedVertices) { neighbors.get(a).add(b); neighbors.get(b).add(a); }
    }
  }
  return neighbors;
}

const labs = new Map(palette.map(color => [color, routeLab(color)]));
const colorDistance = (a, b) => Math.hypot(...labs.get(a).map((value, i) => value - labs.get(b)[i]));

export function assignRouteColors(features, vertexIndex) {
  const neighbors = groupNeighbors(features, p => p.route_id, vertexIndex);
  const ordered = [...neighbors.keys()].sort((a, b) => neighbors.get(b).size - neighbors.get(a).size
    || (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  const assigned = new Map();
  for (const id of ordered) {
    const adjacent = [...neighbors.get(id)].filter(other => assigned.has(other)).map(other => assigned.get(other));
    const start = palette.indexOf(routeColor(id));
    let best, bestDistance = -Infinity;
    for (let offset = 0; offset < palette.length; offset++) {
      const color = palette[(start + offset) % palette.length];
      const minimum = Math.min(...adjacent.map(other => colorDistance(color, other)));
      if (minimum > bestDistance) { best = color; bestDistance = minimum; }
      if (minimum >= ROUTE_COLOR_ASSIGN.minDeltaE) { best = color; break; }
    }
    assigned.set(id, best);
  }
  return assigned;
}


// Empty DSPs have no allocation key and always use the neutral swatch.
export const dspColorKey = name => name ? String(name).slice(String(name).lastIndexOf('-') + 1) || null : null;
export const UNASSIGNED_COLOR = '#94a3b8';

export const GROUP_COLOR_ASSIGN = Object.freeze({ minGlobalDeltaE: 20 });

export function assignGroupColors(features, keyOf, vertexIndex) {
  const neighbors = groupNeighbors(features, keyOf, vertexIndex), counts = new Map();
  for (const { properties } of features) {
    const key = keyOf(properties);
    if (key != null) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const assigned = new Map(), used = new Set(), pending = new Set(counts.keys());
  const saturation = key => [...neighbors.get(key)].filter(id => assigned.has(id)).length;
  while (pending.size) {
    // DSatur counts assigned neighboring groups, with stable district-wide tie breaks.
    const key = [...pending].sort((a, b) => saturation(b) - saturation(a)
      || neighbors.get(b).size - neighbors.get(a).size || counts.get(b) - counts.get(a)
      || (a < b ? -1 : a > b ? 1 : 0))[0];
    pending.delete(key);
    const preferred = routeColor(key), start = palette.indexOf(preferred);
    const candidates = palette.map((_, i) => palette[(start + i) % palette.length]);
    const adjacent = [...neighbors.get(key)].filter(id => assigned.has(id)).map(id => assigned.get(id));
    const minimum = color => Math.min(...adjacent.map(other => colorDistance(color, other)));
    const available = candidates.filter(color => !used.has(color));
    const maximin = colors => colors.reduce((best, color) => minimum(color) > minimum(best) ? color : best);
    const color = available.length
      ? available.find(color => minimum(color) >= ROUTE_COLOR_ASSIGN.minDeltaE
        && [...used].every(other => colorDistance(color, other) >= GROUP_COLOR_ASSIGN.minGlobalDeltaE))
        || available.find(color => minimum(color) >= ROUTE_COLOR_ASSIGN.minDeltaE)
        || maximin(available)
      : maximin(candidates);
    assigned.set(key, color); used.add(color);
  }
  return assigned;
}

export function modeColor(p, mode = 'route', routeColors, groupColors, selection = clearSelection()) {
  if (mode === 'difficulty') {
    const selected = selection.route?.route_id === p.route_id;
    return difficultyColor(difficultyLevel(selected
      ? p.zip_detail_status === 'available' ? p.zip_difficulty : null : p.route_difficulty));
  }
  if (mode === 'dsp' || mode === 'station') {
    const key = mode === 'dsp' ? dspColorKey(p.dsp_name) : p.station;
    return key == null ? UNASSIGNED_COLOR : groupColors?.[mode]?.get(key) ?? routeColor(key);
  }
  return routeColors?.get(p.route_id) ?? routeColor(p.route_id);
}

// Retain vertex membership rather than thresholded ZIP pairs: group thresholds
// count each distinct vertex once even when several ZIPs belong to one group.
export function assignAllColors(features) {
  const vertices = new Map();
  features.forEach((feature, index) => {
    for (const rings of geometryParts(feature.geometry)) for (const ring of rings) for (const point of ring) {
      const key = point.slice(0, 2).map(value => value.toFixed(ROUTE_COLOR_ASSIGN.coordinatePrecision)).join(',');
      if (!vertices.has(key)) vertices.set(key, new Set());
      vertices.get(key).add(index);
    }
  });
  const index = new Map([...vertices].map(([key, members]) => [key, [...members]]));
  return { routeColors: assignRouteColors(features, index), groupColors: {
    dsp: assignGroupColors(features, p => dspColorKey(p.dsp_name), index),
    station: assignGroupColors(features, p => p.station, index),
  } };
}
