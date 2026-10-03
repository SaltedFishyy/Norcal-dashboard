import { SchemaError } from './route-profile.js';

const label = (record) => `Route ${record.roadAreaId ?? record.route_id} (${record.roadAreaName ?? record.route_name})`;

export function validatePostalCodes(codes, record) {
  const fail = (reason) => { throw new SchemaError(`${label(record)}: ${reason}`); };
  if (!Array.isArray(codes)) fail('postal_codes 必须为 string[]');
  const seen = new Set();
  for (const zip of codes) {
    if (typeof zip !== 'string' || !/^\d{5}$/.test(zip)) fail(`ZIP 格式无效: ${JSON.stringify(zip)}`);
    if (seen.has(zip)) fail(`Route 内 ZIP 重复: ${zip}`);
    seen.add(zip);
  }
  return codes;
}

export function parseRoutePostalCodes(record) {
  const fail = (reason) => { throw new SchemaError(`${label(record)}: ${reason}`); };
  if (!Object.hasOwn(record, 'postalCodeList')) fail('缺少 postalCodeList');
  const rawCount = record.postalCodeNum;
  const count = typeof rawCount === 'string' && /^\d+$/.test(rawCount) ? Number(rawCount) : rawCount;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) fail('postalCodeNum 必须为非负整数');
  const value = record.postalCodeList;
  if (value !== null && typeof value !== 'string') fail('postalCodeList 必须为字符串或 null');
  const codes = value === null || value === '' ? [] : value.split(',').map((zip) => zip.trim());
  validatePostalCodes(codes, record);
  if (count !== codes.length) fail(`postalCodeNum ${count} 与 ZIP 数量 ${codes.length} 不符`);
  return codes;
}

export function findPostalCodeConflicts(rows) {
  const owners = new Map();
  for (const row of rows) for (const zip of row.postal_codes) {
    if (!owners.has(zip)) owners.set(zip, []);
    owners.get(zip).push({ route_id: row.route_id, route_name: row.route_name });
  }
  return [...owners].filter(([, routes]) => routes.length > 1)
    .map(([postal_code, routes]) => ({ postal_code, routes }));
}

export function findCrossStationConflicts(stationsData) {
  const owners = new Map();
  for (const [station, snapshot] of Object.entries(stationsData)) {
    for (const row of snapshot.rows) for (const zip of row.postal_codes) {
      if (!owners.has(zip)) owners.set(zip, []);
      owners.get(zip).push({ station, route_id: row.route_id, route_name: row.route_name });
    }
  }
  return [...owners].filter(([, entries]) => new Set(entries.map(entry => entry.station)).size > 1)
    .map(([postal_code, routes]) => ({ postal_code, routes }));
}
