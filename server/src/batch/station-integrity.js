export class IntegrityError extends Error {
  constructor() { super('Station integrity failed'); this.name = 'IntegrityError'; }
}
const zipSet = codes => JSON.stringify([...new Set(codes)].sort());
export function sameZipSet(detail, profile) {
  return Array.isArray(detail?.zips) && Array.isArray(profile?.postal_codes)
    && zipSet(detail.zips.map(zip => zip.postal_code)) === zipSet(profile.postal_codes);
}
export function completeRouteDetail(detail, profile, { allowZipMismatch = false } = {}) {
  return !!detail && detail.route_id === profile.route_id && detail.station === profile.station
    && detail.route_name === profile.route_name && Array.isArray(detail.zips)
    && detail.zips.every(zip => typeof zip.postal_code === 'string' && /^\d{5}$/.test(zip.postal_code)
      && Object.hasOwn(zip, 'pickup_volume_daily') && (zip.pickup_volume_daily === null
        || typeof zip.pickup_volume_daily === 'number' && Number.isFinite(zip.pickup_volume_daily)))
    && new Set(detail.zips.map(zip => zip.postal_code)).size === detail.zips.length
    && (allowZipMismatch || sameZipSet(detail, profile));
}
export function checkStationIntegrity({ station, snapshot, details, successCount, skippedCount,
  failedCount, processedIds, limited = false, freshlyFetchedIds = new Set(), snapshots = {}, boundaries = null }) {
  const rows = snapshot.rows, warnings = [], checks = {};
  checks.route_total = snapshot.total === rows.length;
  checks.station_identity = rows.every(row => row.station === station);
  checks.unique_routes = new Set(rows.map(row => row.route_id)).size === rows.length;
  const checked = limited ? rows.filter(row => processedIds.has(row.route_id)) : rows;
  checks.counts = checked.length === successCount + skippedCount && failedCount === 0;
  checks.details = checked.every(row => completeRouteDetail(details[String(row.route_id)], row,
    { allowZipMismatch: freshlyFetchedIds.has(row.route_id) }));
  for (const row of checked) {
    if (freshlyFetchedIds.has(row.route_id) && !sameZipSet(details[String(row.route_id)], row)) {
      warnings.push({ type: 'zip_set_mismatch', route_id: row.route_id });
    }
  }
  const zips = [...new Set(rows.flatMap(row => row.postal_codes))].sort();
  const coverage = { with_polygon: 0, no_zcta: 0, not_checked: 0 };
  for (const zip of zips) {
    if (boundaries === null) coverage.not_checked++;
    else if (boundaries.byZip ? boundaries.byZip.has(zip) : boundaries.has(zip)) coverage.with_polygon++;
    else if (boundaries.inScope && !boundaries.inScope(zip)) coverage.not_checked++;
    else coverage.no_zcta++;
    const others = Object.entries(snapshots).filter(([code, value]) => code !== station
      && value.rows.some(row => row.postal_codes?.includes(zip))).map(([code]) => code);
    if (others.length) warnings.push({ type: 'cross_station_overlap', postal_code: zip, stations: [station, ...others].sort() });
  }
  if (coverage.no_zcta || coverage.not_checked) warnings.push({ type: 'boundary_coverage', ...coverage });
  return { passed: Object.values(checks).every(Boolean), checks, warnings, boundary_coverage: coverage };
}
