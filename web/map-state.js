import { routeColor } from './route-colors.js';
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
  normal: Object.freeze({ fillOpacity: 0.34, difficultyFillOpacity: 0.4, color: '#334155', opacity: 0.5, weight: 0.8 }),
  focused: Object.freeze({ fillOpacity: 0.42, color: '#1e293b', opacity: 0.65, weight: 1 }),
  hover: Object.freeze({ fillOpacityIncrease: 0.15, color: '#0f172a', opacity: 0.9, weight: 1.6 }),
  selectedRoute: Object.freeze({ fillOpacity: 0.62, color: '#1e293b', opacity: 0.9, weight: 1.2 }),
  selectedZip: Object.freeze({ fillOpacity: 0.8, color: '#334155', opacity: 1, weight: 3 }),
  dimmed: Object.freeze({ fillOpacity: 0.14, color: '#334155', opacity: 0.3, weight: 0.8 }),
});

export function hoverStyle(baseStyle) {
  const c = POLYGON_STYLE;
  return { ...baseStyle, color: c.hover.color, opacity: c.hover.opacity,
    weight: Math.max(baseStyle.weight, c.hover.weight),
    fillOpacity: Math.min(baseStyle.fillOpacity + c.hover.fillOpacityIncrease, c.selectedZip.fillOpacity) };
}

export function polygonStyle(properties, selection = clearSelection(), colorMode = 'route', focusStation = null, dsp = null) {
  const active = selection.route !== null;
  const selected = active && selection.route.route_id === properties.route_id;
  const faded = active ? !selected : (focusStation !== null && properties.station !== focusStation)
    || (dsp !== null && properties.dsp_name !== dsp);
  const zip = selected && selection.zip?.postal_code === properties.postal_code;
  const level = selected ? properties.zip_detail_status === 'available' ? difficultyLevel(properties.zip_difficulty) : null
    : difficultyLevel(properties.route_difficulty);
  const style = faded ? POLYGON_STYLE.dimmed : zip ? POLYGON_STYLE.selectedZip
    : selected ? POLYGON_STYLE.selectedRoute
      : (focusStation !== null || dsp !== null) ? POLYGON_STYLE.focused : POLYGON_STYLE.normal;
  return { fillColor: colorMode === 'difficulty' ? difficultyColor(level) : vividRouteColor(routeColor(properties.route_id)),
    fillOpacity: style === POLYGON_STYLE.normal && colorMode === 'difficulty' ? style.difficultyFillOpacity : style.fillOpacity,
    color: style.color, weight: style.weight, opacity: style.opacity };
}

export function searchRoutes(routes, query) {
  const term = query.trim().toLowerCase();
  const matches = routes.filter(route => (route.station + ' · ' + route.route_name).toLowerCase().includes(term))
    .sort((a, b) => a.route_name.localeCompare(b.route_name));
  return { exact: term ? matches.find(route => route.route_name.toLowerCase() === term) : undefined, matches };
}

export function dspOptions(routes, focusStation = null) {
  return [...new Set(routes.filter(route => !focusStation || route.station === focusStation)
    .map(route => typeof route.dsp_name === 'string' ? route.dsp_name.trim() : '')
    .filter(Boolean))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export function filteredRoutes(routes, query, focusStation = null, dsp = null) {
  const classified = classifyQuery(query);
  return searchRoutes(routes.filter(route => ((query && classified.kind !== 'zip') || !focusStation || route.station === focusStation)
    && (dsp === null || route.dsp_name === dsp)), classified.kind === 'zip' ? '' : query);
}

export const ROUTE_FILL = Object.freeze({ saturation: 1.4, lightness: -0.06 });

export function vividRouteColor(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const hue = delta === 0 ? 0 : max === r ? ((g - b) / delta + 6) % 6
    : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  const l = Math.max(0, Math.min(1, lightness + ROUTE_FILL.lightness));
  const c = (1 - Math.abs(2 * l - 1)) * Math.min(1, saturation * ROUTE_FILL.saturation);
  const x = c * (1 - Math.abs(hue % 2 - 1)), m = l - c / 2;
  const rgb = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x]
    : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return '#' + rgb.map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('');
}

export function routeLabelText(routeName) {
  if (typeof routeName !== 'string' || !routeName.trim()) return null;
  return routeName.slice(routeName.lastIndexOf('-') + 1) || null;
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

export function routeLabelAnchors(features) {
  const routes = new Map();
  for (const feature of features) {
    const p = feature.properties, parts = geometryParts(feature.geometry);
    if (p.route_id == null || !routeLabelText(p.route_name) || !parts.length) continue;
    if (!routes.has(p.route_id)) routes.set(p.route_id, { properties: p, members: [] });
    routes.get(p.route_id).members.push(parts);
  }
  const anchors = [];
  for (const { properties: p, members } of routes.values()) {
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
      text: routeLabelText(p.route_name), latlng: [point[1], point[0]], weight });
  }
  return anchors;
}
