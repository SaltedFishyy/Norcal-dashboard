export const FAR_FROM_DISTRICT_KM = 50;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateWarehouse(body, { patch = false } = {}) {
  const allowed = ['warehouse_name', 'address', 'district_id', 'station_id', 'manual_coordinates', 'confirm',
    ...(patch ? ['expected_updated_at'] : [])];
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)))
    return { error: 'invalid_body', fields: Object.keys(body ?? {}).filter(key => !allowed.includes(key)) };
  const values = { ...body }, fields = [];
  for (const [key, max] of [['warehouse_name', 120], ['address', 300]]) {
    if (typeof values[key] === 'string') values[key] = values[key].trim();
    if (typeof values[key] !== 'string' || !values[key] || [...values[key]].length > max) fields.push(key);
  }
  if (typeof values.district_id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(values.district_id)) fields.push('district_id');
  values.station_id = values.station_id === '' || values.station_id === undefined ? null : values.station_id;
  if (values.station_id !== null && (typeof values.station_id !== 'string' || !/^[A-Z]{3}\d{2}$/.test(values.station_id))) fields.push('station_id');
  if (Object.hasOwn(body, 'manual_coordinates')) {
    const p = body.manual_coordinates;
    if (!object(p) || Object.keys(p).length !== 2 || !validPoint(p)) fields.push('manual_coordinates');
  }
  if (Object.hasOwn(body, 'confirm') && (!Array.isArray(body.confirm)
    || body.confirm.some(reason => !['duplicate_address', 'far_from_district'].includes(reason)))) fields.push('confirm');
  if (patch && (typeof values.expected_updated_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(values.expected_updated_at)
    || !Number.isFinite(Date.parse(values.expected_updated_at)))) fields.push('expected_updated_at');
  return fields.length ? { error: 'invalid_warehouse', fields } : { values };
}
export function validPoint(p) {
  return Number.isFinite(p?.latitude) && Number.isFinite(p?.longitude)
    && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
}
export function validateAssignment(values, config) {
  const district = config.districts.find(d => d.id === values.district_id);
  if (!district) return 'district_not_found';
  if (values.station_id !== null && !district.stations.includes(values.station_id)) return 'station_not_in_district';
  return null;
}
const abbreviations = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd', highway: 'hwy',
  lane: 'ln', court: 'ct', parkway: 'pkwy', suite: 'ste', north: 'n', south: 's', east: 'e', west: 'w' };
export function addressKey(address) {
  return address.toLowerCase().normalize('NFKC').replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map(word => abbreviations[word] ?? word).join(' ');
}
export function greatCircleKm(a, b) {
  const rad = n => n * Math.PI / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function distanceToExtentKm(point, [[south, west], [north, east]]) {
  return greatCircleKm(point, { latitude: Math.max(south, Math.min(north, point.latitude)),
    longitude: Math.max(west, Math.min(east, point.longitude)) });
}
export function projectWarehouse(row, config) {
  const keys = ['id', 'warehouse_name', 'address', 'district_id', 'station_id', 'latitude', 'longitude', 'created_at', 'updated_at'];
  const district = config.districts.find(d => d.id === row.district_id);
  return { ...Object.fromEntries(keys.map(key => [key, row[key]])), district_known: Boolean(district),
    district_name_zh: district?.name_zh ?? null, district_name_en: district?.name_en ?? null,
    station_known: row.station_id === null || Boolean(district?.stations.includes(row.station_id)) };
}
