import { StationNotFoundError, SnapshotInvalidError } from '../store/route-profiles-file.js';
import { validatePostalCodes, findPostalCodeConflicts, findCrossStationConflicts } from '../transform/postal-codes.js';

export class PostalCodesMissingError extends Error {
  constructor() { super('Snapshot lacks postal_codes.'); this.name = 'PostalCodesMissingError'; }
}
export class RouteZipConflictError extends Error {
  constructor(conflicts) { super('Route ZIP ownership conflicts.'); this.name = 'RouteZipConflictError'; this.conflicts = conflicts; }
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function validateProfiles(profiles) {
  const conflicts = [];
  for (const [key, snapshot] of Object.entries(profiles.stations)) {
    for (const row of snapshot.rows) {
      if (!row || !Object.hasOwn(row, 'postal_codes')) throw new PostalCodesMissingError();
      if (!(row.route_id === null || Number.isSafeInteger(row.route_id)) || typeof row.route_name !== 'string') {
        throw new SnapshotInvalidError();
      }
      try { validatePostalCodes(row.postal_codes, row); }
      catch { throw new SnapshotInvalidError(); }
    }
    conflicts.push(...findPostalCodeConflicts(snapshot.rows).map(conflict => ({ station: key, ...conflict })));
  }
  conflicts.push(...findCrossStationConflicts(profiles.stations));
  if (conflicts.length) throw new RouteZipConflictError(conflicts);
}

const detailFor = (details, row, station) => {
  const detail = details?.status === 'ok' && Object.hasOwn(details.routes, String(row.route_id))
    ? details.routes[String(row.route_id)] : null;
  return detail?.route_id === row.route_id && detail.station === station ? detail : null;
};
const difficultyProperties = (row, detail, postalCode) => {
  const zip = detail?.zips.find(zip => zip.postal_code === postalCode);
  return { route_difficulty: row.route_difficulty ?? null, zip_difficulty: zip?.postal_code_difficulty ?? null,
    zip_detail_status: !detail ? 'missing' : zip ? 'available' : 'not_in_detail' };
};
const summary = (row, boundaries, mappedCount = row.postal_codes.filter(zip => boundaries.byZip.has(zip)).length, detail = null) => ({ route_id: row.route_id, route_name: row.route_name,
  station: row.station, dsp_name: row.dsp_name, pickup_volume: row.pickup_volume, pph: row.pph,
  zip_count: row.postal_codes.length, mapped_count: mappedCount, route_difficulty: row.route_difficulty ?? null,
  zip_detail: { status: detail ? 'available' : 'missing', fetched_at: detail?.fetched_at ?? null, zip_count: detail?.zips.length ?? null } });
const source = boundaries => ({ dataset: boundaries.meta.dataset, vintage: boundaries.meta.vintage });

export function buildRouteMap({ profiles, station, boundaries, details }) {
  if (!Object.hasOwn(profiles.stations, station)) throw new StationNotFoundError();
  validateProfiles(profiles);
  const snapshot = profiles.stations[station];
  const byZip = boundaries.byZip;
  const features = [], missing = [], routes = [];
  for (const row of snapshot.rows) {
    const detail = detailFor(details, row, station);
    let mapped_count = 0;
    for (const postal_code of row.postal_codes) {
      const properties = { postal_code, route_id: row.route_id, route_name: row.route_name, station,
        ...difficultyProperties(row, detail, postal_code) };
      if (byZip.has(postal_code)) {
        features.push({ type: 'Feature', geometry: byZip.get(postal_code), properties }); mapped_count++;
      } else {
        missing.push({ postal_code, route_id: row.route_id, route_name: row.route_name,
          reason: boundaries.inScope(postal_code) ? 'no_zcta' : 'not_checked' });
      }
    }
    routes.push(summary(row, boundaries, mapped_count, detail));
  }
  features.sort((a, b) => compare(a.properties.postal_code, b.properties.postal_code));
  missing.sort((a, b) => compare(a.postal_code, b.postal_code));
  routes.sort((a, b) => compare(a.route_name, b.route_name));
  const missing_no_zcta = missing.filter(row => row.reason === 'no_zcta').length;
  return { station, fetched_at: snapshot.fetched_at, details_status: details?.status ?? 'none',
    boundary_source: source(boundaries),
    coverage: { total: features.length + missing.length, mapped: features.length, missing: missing.length,
      missing_no_zcta, missing_not_checked: missing.length - missing_no_zcta },
    routes, missing, features: { type: 'FeatureCollection', features } };
}

export function lookupZip({ profiles, boundaries, postalCode, details }) {
  validateProfiles(profiles);
  const geometry = boundaries.byZip.get(postalCode) ?? null;
  for (const [station, snapshot] of Object.entries(profiles.stations)) {
    const row = snapshot.rows.find(row => row.postal_codes.includes(postalCode));
    const detail = row && detailFor(details, row, station);
    if (row) return { postal_code: postalCode, status: geometry ? 'covered' : 'covered_no_boundary',
      ...difficultyProperties(row, detail, postalCode),
      station, route_id: row.route_id, route_name: row.route_name, route: summary(row, boundaries, undefined, detail),
      fetched_at: snapshot.fetched_at, geometry, boundary_source: source(boundaries) };
  }
  return { postal_code: postalCode,
    status: geometry ? 'uncovered' : boundaries.inScope(postalCode) ? 'no_boundary' : 'out_of_range',
    station: null, route_id: null, route_name: null, route: null, fetched_at: null,
    geometry, boundary_source: source(boundaries) };
}
