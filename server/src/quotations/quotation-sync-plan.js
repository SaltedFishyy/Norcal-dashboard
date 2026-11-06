import { quotationBands } from './lark-sheet-parse.js';

const key = row => JSON.stringify([String(row.route_id), row.postal_code, row.effective_from]);
const pair = (route, zip) => JSON.stringify([route?.trim(), zip]);
const identity = row => ({ sheetRow: row.sheetRow, routeName: row.routeName, postalCode: row.postalCode });
const identifiable = row => Boolean(row.routeName?.trim()) && /^\d{5}$/.test(row.postalCode ?? '');
const byLine = (a, b) => {
  const left = BigInt(a.line_id ?? a.voidLineId), right = BigInt(b.line_id ?? b.voidLineId);
  return left < right ? -1 : left > right ? 1 : 0;
};
const bySheet = (a, b) => (a.sheetRow ?? a.insert?.sheetRow) - (b.sheetRow ?? b.insert?.sheetRow);
const sameContent = (a, b) => ['end_date', 'route_name', 'station_label_raw', 'fleet_name',
  'reference_postal_code', 'remarks', 'second_parcel_half_price_raw'].every(field => (a[field] ?? null) === (b[field] ?? null))
  && ['first', 'additional'].every(type => quotationBands.every(band =>
    Math.round(Number(a[type][band]) * 100) === Math.round(Number(b[type][band]) * 100)));

export function planQuotationSync({ parsed, activeRoutes, scopeLines, otherSourceKeys, maxRemovalRatio = 0.2 }) {
  if (!parsed.ok) throw new TypeError('A valid parsed quotation sheet is required.');
  const rejected = parsed.rejected.map(row => ({ ...row })), warnings = parsed.warnings.map(row => ({ ...row }));
  let inserts = [], replacements = [], removals = [];
  const unchanged = [], matched = [], hits = new Set();
  const routes = new Map();
  for (const route of activeRoutes) {
    const name = route.route_name.trim();
    if (!routes.has(name)) routes.set(name, []);
    routes.get(name).push(route);
  }
  for (const row of parsed.rows) {
    const candidates = routes.get(row.routeName.trim()) ?? [];
    if (candidates.length !== 1) {
      rejected.push({ ...identity(row), reason: candidates.length ? 'route_ambiguous' : 'route_not_found' });
      continue;
    }
    const route = candidates[0];
    if (!route.postal_codes.includes(row.postalCode)) warnings.push({ ...identity(row), code: 'zip_not_in_route' });
    matched.push({ sheetRow: row.sheetRow, route_id: route.route_id, station_code: route.station_code,
      route_name: row.routeName, postal_code: row.postalCode, effective_from: row.effectiveFrom,
      end_date: row.endDate, station_label_raw: row.stationLabelRaw, fleet_name: row.fleetName,
      reference_postal_code: row.referencePostalCode, remarks: row.remarks,
      second_parcel_half_price_raw: row.secondParcelHalfPriceRaw,
      first: { ...row.first }, additional: { ...row.additional } });
  }
  const frequencies = new Map();
  for (const row of matched) frequencies.set(key(row), (frequencies.get(key(row)) ?? 0) + 1);
  const others = new Set(otherSourceKeys.map(key)), existing = new Map(scopeLines.map(row => [key(row), row]));
  for (const row of matched) {
    const rowKey = key(row);
    const reason = frequencies.get(rowKey) > 1 ? 'duplicate_in_sheet' : others.has(rowKey) ? 'conflict_other_source' : null;
    if (reason) {
      rejected.push({ sheetRow: row.sheetRow, routeName: row.route_name, postalCode: row.postal_code, reason });
      continue;
    }
    hits.add(rowKey);
    const old = existing.get(rowKey);
    if (!old) inserts.push(row);
    else if (sameContent(old, row)) unchanged.push({ sheetRow: row.sheetRow, line_id: old.line_id });
    else replacements.push({ voidLineId: old.line_id, voidReason: 'lark_replaced', insert: row });
  }
  const protectedPairs = new Set(rejected.filter(identifiable)
    .map(row => pair(row.routeName, row.postalCode)));
  const skipRemovals = rejected.some(row => !identifiable(row));
  let protectedCount = 0;
  for (const row of [...scopeLines].sort(byLine)) {
    if (hits.has(key(row))) continue;
    if (protectedPairs.has(pair(row.route_name, row.postal_code))) {
      protectedCount++;
      warnings.push({ line_id: row.line_id, routeName: row.route_name, postalCode: row.postal_code, code: 'protected_by_rejected_row' });
    } else if (!skipRemovals) removals.push({ line_id: row.line_id, voidReason: 'lark_removed' });
  }
  if (skipRemovals) warnings.push({ code: 'removals_skipped' });
  const plannedRemovals = removals.length;
  let result;
  if (parsed.dataRowCount > 0 && inserts.length + replacements.length + unchanged.length === 0) result = 'rejected';
  else if (scopeLines.length && removals.length / scopeLines.length > maxRemovalRatio) result = 'aborted_mass_removal';
  else if (!inserts.length && !replacements.length && !removals.length) result = 'unchanged';
  else result = rejected.length ? 'partial' : 'completed';
  if (['rejected', 'aborted_mass_removal'].includes(result)) { inserts = []; replacements = []; removals = []; }
  inserts.sort(bySheet); replacements.sort(bySheet); unchanged.sort(bySheet); rejected.sort(bySheet); removals.sort(byLine);
  warnings.sort((a, b) => {
    if (a.sheetRow != null && b.sheetRow != null) return bySheet(a, b);
    if (a.sheetRow != null || b.sheetRow != null) return a.sheetRow != null ? -1 : 1;
    if (a.line_id != null && b.line_id != null) return byLine(a, b);
    return a.line_id != null ? -1 : b.line_id != null ? 1 : 0;
  });
  return { result, inserts, replacements, removals, unchanged, rejected, warnings,
    counts: { dataRows: parsed.dataRowCount, blank: parsed.blankRowCount, inserted: inserts.length,
      replaced: replacements.length, unchanged: unchanged.length, removed: removals.length, plannedRemovals,
      protected: protectedCount, rejected: rejected.length, warnings: warnings.length } };
}
