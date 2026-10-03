import { routeColor } from './route-colors.js';

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
  color: '#db2777', weight: 5, opacity: 1, dashArray: '8 6' });

export function polygonStyle(properties, selection = clearSelection()) {
  const active = selection.route !== null;
  const selected = active && selection.route.route_id === properties.route_id;
  const zip = selected && selection.zip?.postal_code === properties.postal_code;
  return { fillColor: routeColor(properties.route_id), fillOpacity: active && !selected ? 0.12 : selected ? 0.65 : 0.5,
    color: zip ? '#db2777' : selected ? '#0f172a' : '#334155', weight: zip ? 5 : selected ? 3 : 1,
    opacity: active && !selected ? 0.35 : 1 };
}

export function searchRoutes(routes, query) {
  const term = query.trim().toLowerCase();
  const matches = routes.filter(route => route.route_name.toLowerCase().includes(term))
    .sort((a, b) => a.route_name.localeCompare(b.route_name));
  return { exact: term ? matches.find(route => route.route_name.toLowerCase() === term) : undefined, matches };
}
