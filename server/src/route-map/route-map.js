import { zipFirstPrice, routePriceSummary } from '../quotations/quotations.js';
import { StationNotFoundError, SnapshotInvalidError } from '../store/route-profiles-file.js';
import { validatePostalCodes, findPostalCodeConflicts, findCrossStationConflicts } from '../transform/postal-codes.js';
import { DistrictNotFoundError } from '../store/districts-file.js';

export class PostalCodesMissingError extends Error {
  constructor() { super('Snapshot lacks postal_codes.'); this.name = 'PostalCodesMissingError'; }
}
export class RouteZipConflictError extends Error {
  constructor(conflicts) { super('Route ZIP ownership conflicts.'); this.name = 'RouteZipConflictError'; this.conflicts = conflicts; }
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function validateProfiles(profiles, station = null, { allowMissingPostalCodes = false } = {}) {
  const conflicts = [];
  for (const [key, snapshot] of Object.entries(profiles.stations)) {
    for (const row of snapshot.rows) {
      if (!row || (!Object.hasOwn(row, 'postal_codes') && !allowMissingPostalCodes)) throw new PostalCodesMissingError();
      if (!(row.route_id === null || Number.isSafeInteger(row.route_id)) || typeof row.route_name !== 'string') {
        throw new SnapshotInvalidError();
      }
      try { if (Object.hasOwn(row, 'postal_codes')) validatePostalCodes(row.postal_codes, row); }
      catch { throw new SnapshotInvalidError(); }
    }
    if (station === null || station === key) conflicts.push(...findPostalCodeConflicts(snapshot.rows.filter(row => Object.hasOwn(row, 'postal_codes'))).map(conflict => ({ station: key, ...conflict })));
  }

  if (conflicts.length) throw new RouteZipConflictError(conflicts);
}

const detailFor = (details, row, station) => {
  const detail = details?.status === 'ok' && Object.hasOwn(details.routes, String(row.route_id))
    ? details.routes[String(row.route_id)] : null;
  return detail?.route_id === row.route_id && detail.station === station ? detail : null;
};
const difficultyProperties = (row, detail, postalCode) => {
  const zip = detail?.zips.find(zip => zip.postal_code === postalCode);
  return { dsp_name: row.dsp_name ?? null, experienced_pph: zip?.experienced_pph ?? null,
    pickup_volume_daily: zip?.pickup_volume_daily ?? null,
    route_difficulty: row.route_difficulty ?? null, zip_difficulty: zip?.postal_code_difficulty ?? null,
    zip_detail_status: !detail ? 'missing' : zip ? 'available' : 'not_in_detail' };
};
const summary = (row, boundaries, mappedCount = row.postal_codes.filter(zip => boundaries.byZip.has(zip)).length, detail = null, priceIndex = null) => ({ ...routePriceSummary(priceIndex, row), route_id: row.route_id, route_name: row.route_name,
  station: row.station, dsp_name: row.dsp_name, pickup_volume: row.pickup_volume, pph: row.pph,
  zip_count: row.postal_codes.length, mapped_count: mappedCount, route_difficulty: row.route_difficulty ?? null,
  zip_detail: { status: detail ? 'available' : 'missing', fetched_at: detail?.fetched_at ?? null, zip_count: detail?.zips.length ?? null } });
const source = boundaries => ({ dataset: boundaries.meta.dataset, vintage: boundaries.meta.vintage });

export function buildRouteMap({ profiles, station, boundaries, details, priceIndex = null }) {
  if (!Object.hasOwn(profiles.stations, station)) throw new StationNotFoundError();
  validateProfiles(profiles, station);
  const snapshot = profiles.stations[station];
  const byZip = boundaries.byZip;
  const features = [], missing = [], routes = [];
  for (const row of snapshot.rows) {
    const detail = detailFor(details, row, station);
    let mapped_count = 0;
    for (const postal_code of row.postal_codes) {
      const properties = { postal_code, route_id: row.route_id, route_name: row.route_name, station,
        ...difficultyProperties(row, detail, postal_code), current_first_0_1lb_price: zipFirstPrice(priceIndex, row.route_id, postal_code) };
      if (byZip.has(postal_code)) {
        features.push({ type: 'Feature', geometry: byZip.get(postal_code), properties }); mapped_count++;
      } else {
        missing.push({ postal_code, route_id: row.route_id, route_name: row.route_name,
          reason: boundaries.inScope(postal_code) ? 'no_zcta' : 'not_checked' });
      }
    }
    routes.push(summary(row, boundaries, mapped_count, detail, priceIndex));
  }
  features.sort((a, b) => compare(a.properties.postal_code, b.properties.postal_code));
  missing.sort((a, b) => compare(a.postal_code, b.postal_code));
  routes.sort((a, b) => compare(a.route_name, b.route_name));
  const missing_no_zcta = missing.filter(row => row.reason === 'no_zcta').length;
  return { station, fetched_at: snapshot.fetched_at, details_status: details?.status ?? 'none',
    boundary_source: source(boundaries),
    coverage: { total: features.length + missing.length, mapped: features.length, missing: missing.length,
      missing_no_zcta, missing_not_checked: missing.length - missing_no_zcta },
    cross_station_conflicts: findCrossStationConflicts(profiles.stations)
      .filter(conflict => conflict.routes.some(owner => owner.station === station))
      .map(({ postal_code, routes }) => ({ postal_code, stations: [...new Set(routes.map(owner => owner.station))].sort(compare) }))
      .sort((a, b) => compare(a.postal_code, b.postal_code)),
    routes, missing, features: { type: 'FeatureCollection', features } };
}

export function buildDistrictMap({ profiles, districts, district, boundaries, details, priceIndex = null }) {
  const configured = districts.find(item => item.id === district);
  if (!configured) throw new DistrictNotFoundError();
  const maps = configured.stations.filter(({ code }) => Object.hasOwn(profiles.stations, code))
    .map(({ code }) => buildRouteMap({ profiles, station: code, boundaries, details, priceIndex }));
  const coverage = { total: 0, mapped: 0, missing: 0, missing_no_zcta: 0, missing_not_checked: 0 };
  for (const map of maps) for (const key of Object.keys(coverage)) coverage[key] += map.coverage[key];
  const members = Object.fromEntries(maps.map(map => [map.station, profiles.stations[map.station]]));
  return { district, details_status: details?.status ?? 'none', boundary_source: source(boundaries), coverage,
    stations: maps.map(map => ({ code: map.station, fetched_at: map.fetched_at, route_count: map.routes.length })),
    routes: maps.flatMap(map => map.routes.map(route => ({ ...route, station: map.station }))),
    missing: maps.flatMap(map => map.missing.map(row => ({ ...row, station: map.station }))),
    features: { type: 'FeatureCollection', features: maps.flatMap(map => map.features.features) },
    cross_station_conflicts: findCrossStationConflicts(members)
      .map(({ postal_code, routes }) => ({ postal_code, stations: [...new Set(routes.map(owner => owner.station))].sort(compare) }))
      .sort((a, b) => compare(a.postal_code, b.postal_code)) };
}

export function lookupZip({ profiles, boundaries, postalCode, details, priceIndex = null }) {
  validateProfiles(profiles);
  const geometry = boundaries.byZip.get(postalCode) ?? null;
  const owners = Object.entries(profiles.stations).flatMap(([station, snapshot]) => snapshot.rows
    .filter(row => row.postal_codes.includes(postalCode))
    .map(row => ({ station, route_id: row.route_id, route_name: row.route_name,
      current_first_0_1lb_price: zipFirstPrice(priceIndex, row.route_id, postalCode) })))
    .sort((a, b) => compare(a.station, b.station));
  if (owners.length > 1) return { postal_code: postalCode, status: 'multi_station', owners,
    station: null, route_id: null, route_name: null, route: null, fetched_at: null,
    geometry, boundary_source: source(boundaries) };
  for (const [station, snapshot] of Object.entries(profiles.stations)) {
    const row = snapshot.rows.find(row => row.postal_codes.includes(postalCode));
    const detail = row && detailFor(details, row, station);
    if (row) return { postal_code: postalCode, status: geometry ? 'covered' : 'covered_no_boundary',
      ...difficultyProperties(row, detail, postalCode),
      current_first_0_1lb_price: zipFirstPrice(priceIndex, row.route_id, postalCode),
      station, route_id: row.route_id, route_name: row.route_name, route: summary(row, boundaries, undefined, detail, priceIndex),
      fetched_at: snapshot.fetched_at, geometry, boundary_source: source(boundaries) };
  }
  return { postal_code: postalCode,
    status: geometry ? 'uncovered' : boundaries.inScope(postalCode) ? 'no_boundary' : 'out_of_range',
    station: null, route_id: null, route_name: null, route: null, fetched_at: null,
    geometry, boundary_source: source(boundaries) };
}
