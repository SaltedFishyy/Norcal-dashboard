import { SchemaError } from './route-profile.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = {
  postal_code: 'postalCode', postal_code_tag: 'postalCodeTag', postal_code_difficulty: 'postalCodeDifficulty',
  first_mile_distance: 'assignedRouteAreaFirstOrderMileage', experienced_pph: 'experiencedPph',
  delivery_fail_rate: 'deliveryFailRate', dnr_rate: 'dnrRate', safety_level: 'safetyLevel',
};
const numeric = new Set(['first_mile_distance', 'experienced_pph', 'delivery_fail_rate', 'dnr_rate']);

export function transformRouteDetail({ contentBody, headerBody, capacityBody }, { station, routeId, fetchedAt }) {
  if (!Array.isArray(contentBody?.data) || !object(headerBody?.data)) throw new SchemaError('详情响应结构无效');
  if (typeof station !== 'string' || !station || !Number.isSafeInteger(routeId) || routeId < 1
    || typeof fetchedAt !== 'string' || !Number.isFinite(Date.parse(fetchedAt))) throw new SchemaError('详情元数据无效');
  const header = headerBody.data;
  if (typeof header.roadAreaName !== 'string' || !header.roadAreaName.trim()) throw new SchemaError('缺少 Route 名称');
  const parse_errors = [];
  const typed = (value, field, type, errors) => {
    if (value === null || value === undefined) return null;
    if (typeof value === type && (type !== 'number' || Number.isFinite(value))) return value;
    errors.push({ field });
    return null;
  };
  const seen = new Set();
  const capacity = new Map();
  if (capacityBody !== undefined) {
    if (!Array.isArray(capacityBody?.data)) throw new SchemaError('产能响应结构无效');
    for (const row of capacityBody.data) {
      if (!object(row) || typeof row.postalCode !== 'string' || !row.postalCode.trim() || capacity.has(row.postalCode)) throw new SchemaError('产能 ZIP 结构无效或重复');
      capacity.set(row.postalCode, row);
    }
  }
  const zips = contentBody.data.map((raw) => {
    if (!object(raw)) throw new SchemaError('ZIP 记录结构无效');
    const errors = [];
    const zip = {};
    for (const [field, source] of Object.entries(fields)) zip[field] = typed(raw[source], field, numeric.has(field) ? 'number' : 'string', errors);
    if (zip.postal_code === null || !zip.postal_code.trim()) {
      if (!errors.some(({ field }) => field === 'postal_code')) errors.push({ field: 'postal_code' });
    } else {
      if (seen.has(zip.postal_code)) throw new SchemaError('Route 内 ZIP 重复');
      seen.add(zip.postal_code);
    }
    if (capacityBody !== undefined) {
      const row = capacity.get(zip.postal_code);
      zip.pickup_volume_daily = typed(row?.receiptQty, 'pickup_volume_daily', 'number', errors);
      if (!row) errors.push({ field: 'pickup_volume_daily' });
    }
    return { ...zip, raw, parse_errors: errors };
  });
  const zip_count = typed(header.postalCodeNum, 'zip_count', 'number', parse_errors);
  if (zip_count !== zips.length && !parse_errors.some(({ field }) => field === 'zip_count')) parse_errors.push({ field: 'zip_count' });
  const route = {
    route_id: routeId, station, route_name: header.roadAreaName,
    route_difficulty: typed(header.roadAreaDifficulty, 'route_difficulty', 'string', parse_errors),
    route_difficulty_code: typed(header.roadAreaDifficultyCode, 'route_difficulty_code', 'string', parse_errors),
    fetched_at: fetchedAt, source: 'dms-playwright', zip_count, zips, parse_errors,
  };
  if (capacityBody !== undefined) {
    route.capacity_raw = capacityBody.data;
    for (const postalCode of capacity.keys()) {
      if (!seen.has(postalCode)) parse_errors.push({ field: 'capacity_postal_code_extra', value: postalCode });
    }
  }
  return { route, warnings: [...parse_errors, ...zips.flatMap((zip) => zip.parse_errors.map((error) => ({ postal_code: zip.postal_code, ...error })))] };
}
