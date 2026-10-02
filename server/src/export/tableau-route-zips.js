import { SchemaError } from '../transform/route-profile.js';
import { validatePostalCodes, parseRoutePostalCodes, findPostalCodeConflicts } from '../transform/postal-codes.js';

export const columns = ['station', 'route_id', 'route_name', 'postal_code', 'source', 'fetched_at'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const cell = (value) => {
  const text = value == null ? '' : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function exportTableauRouteZips(data) {
  if (!data || data.schema_version !== 1 || !data.stations || typeof data.stations !== 'object' || Array.isArray(data.stations)) {
    throw new SchemaError('Snapshot 结构无效');
  }
  const rows = [], summary = [], issues = [], owners = new Map();
  for (const station of Object.keys(data.stations).sort(compare)) {
    const snapshot = data.stations[station];
    if (!snapshot || !Array.isArray(snapshot.rows) || typeof snapshot.source !== 'string'
      || typeof snapshot.fetched_at !== 'string' || !Number.isFinite(Date.parse(snapshot.fetched_at))) {
      issues.push(`Station ${station}: snapshot 结构无效`); continue;
    }
    const validRows = [];
    const zips = new Set();
    for (const row of snapshot.rows) {
      try {
        if (!row || !Object.hasOwn(row, 'postal_codes')) {
          throw new SchemaError(`Route ${row?.route_id} (${row?.route_name}) 缺少 postal_codes；请运行 npm run dms:scrape -- --station ${station}`);
        }
        if (!(row.route_id === null || Number.isSafeInteger(row.route_id)) || typeof row.route_name !== 'string') {
          throw new SchemaError(`Route ${row.route_id} (${row.route_name}) 身份字段无效`);
        }
        validatePostalCodes(row.postal_codes, row);
        // The raw source count remains authoritative when present in a normalized snapshot.
        if (row.raw && (Object.hasOwn(row.raw, 'postalCodeList') || Object.hasOwn(row.raw, 'postalCodeNum'))) {
          const sourceCodes = parseRoutePostalCodes({ ...row.raw, roadAreaId: row.route_id, roadAreaName: row.route_name });
          if (JSON.stringify(sourceCodes) !== JSON.stringify(row.postal_codes)) throw new SchemaError(`Route ${row.route_id} (${row.route_name}) postal_codes 与 raw 不一致`);
        }
        validRows.push(row);
        for (const postal_code of row.postal_codes) {
          zips.add(postal_code);
          const entry = { station, route_id: row.route_id, route_name: row.route_name, postal_code,
            source: snapshot.source, fetched_at: snapshot.fetched_at };
          rows.push(entry);
          if (!owners.has(postal_code)) owners.set(postal_code, []);
          owners.get(postal_code).push(entry);
        }
      } catch (error) {
        if (!(error instanceof SchemaError)) throw error;
        issues.push(`Station ${station}: ${error.message}`);
      }
    }
    const conflicts = findPostalCodeConflicts(validRows);
    if (conflicts.length) issues.push(`Station ${station} ZIP 冲突: ${JSON.stringify(conflicts)}`);
    summary.push({ station, route_count: snapshot.rows.length, row_count: validRows.reduce((n, row) => n + row.postal_codes.length, 0), unique_zip_count: zips.size });
  }
  for (const [zip, entries] of owners) {
    if (new Set(entries.map((entry) => entry.station)).size > 1) {
      issues.push(`跨 Station ZIP 冲突 ${zip}: ${JSON.stringify(entries.map(({ station, route_id, route_name }) => ({ station, route_id, route_name })))}`);
    }
  }
  if (issues.length) throw new SchemaError(issues.join('\n'));
  rows.sort((a, b) => compare(a.station, b.station) || compare(a.route_name, b.route_name) || compare(a.postal_code, b.postal_code));
  const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => cell(row[key])).join(','))].join('\n') + '\n';
  return { rows, csv, summary, conflict_count: 0 };
}
