import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotationSheet } from '../src/quotations/lark-sheet-parse.js';
import { planQuotationSync } from '../src/quotations/quotation-sync-plan.js';
import { sfoHeader, syntheticCells } from './lark-quotation-fixtures.js';

const parsed = (...rows) => parseQuotationSheet([...sfoHeader, ...rows]);
const activeRoutes = [{ route_id: '1', route_name: ' Mock Route ', station_code: 'MOCK1', postal_codes: ['12345'] }];
const plan = (p, scopeLines = [], options = {}) => planQuotationSync({ parsed: p, activeRoutes, scopeLines, otherSourceKeys: [], ...options });
const insert = () => plan(parsed(syntheticCells())).inserts[0];
const old = (line_id = '1', fields = {}) => ({ ...insert(), line_id, ...fields });

test('LQ plan inserts with DMS station, remains unchanged by cents and replaces changed content', () => {
  const p = parsed(syntheticCells()), before = structuredClone(p), newPlan = plan(p);
  assert.equal(newPlan.result, 'completed'); assert.equal(newPlan.counts.inserted, 1);
  assert.equal(newPlan.inserts[0].station_code, 'MOCK1');
  const existing = old(); existing.first['0_1'] = '900.00';
  assert.equal(plan(p, [existing]).result, 'unchanged');
  for (const field of ['end_date', 'route_name', 'station_label_raw', 'fleet_name', 'reference_postal_code', 'remarks', 'second_parcel_half_price_raw']) {
    const changed = plan(p, [old('1', { [field]: 'changed' })]);
    assert.equal(changed.replacements[0].voidReason, 'lark_replaced', field);
    assert.equal(changed.replacements[0].voidLineId, '1');
    assert.equal(changed.counts.removed, 0);
  }
  const changed = old(); changed.additional['40_plus']++;
  assert.equal(plan(p, [changed]).counts.replaced, 1);
  assert.deepEqual(p, before);
});

test('LQ plan rejects missing/ambiguous routes and warns on ZIP outside current route', () => {
  const p = parsed(syntheticCells());
  for (const [routes, reason] of [[[], 'route_not_found'], [[...activeRoutes, { ...activeRoutes[0], route_id: '2' }], 'route_ambiguous']]) {
    const result = plan(p, [old()], { activeRoutes: routes });
    assert.equal(result.result, 'rejected'); assert.equal(result.rejected[0].reason, reason);
    assert.equal(result.counts.protected, 1);
  }
  const zip = plan(p, [], { activeRoutes: [{ ...activeRoutes[0], postal_codes: [] }] });
  assert.equal(zip.counts.inserted, 1); assert.equal(zip.warnings[0].code, 'zip_not_in_route');
});

test('LQ plan rejects every sheet duplicate and other-source conflict and protects all old dates', () => {
  const scope = [old('10'), old('2', { effective_from: '2025-01-01' })];
  const result = plan(parsed(syntheticCells(), syntheticCells()), scope);
  assert.equal(result.result, 'rejected');
  assert.deepEqual(result.rejected.map(row => row.reason), ['duplicate_in_sheet', 'duplicate_in_sheet']);
  assert.deepEqual(result.warnings.map(row => row.line_id), ['2', '10']);
  assert.equal(result.counts.protected, 2); assert.equal(result.counts.removed, 0);
  const conflict = plan(parsed(syntheticCells()), scope, { otherSourceKeys: [insert()] });
  assert.equal(conflict.rejected[0].reason, 'conflict_other_source');
  assert.equal(conflict.counts.protected, 2);
});

test('LQ plan protects identifiable invalid rows while allowing other writes', () => {
  const bad = syntheticCells(); bad[5] = null;
  const good = syntheticCells(); good[3] = '54321';
  const result = plan(parsed(bad, good), [old('1'), old('2', { effective_from: '2025-01-01' })]);
  assert.equal(result.result, 'partial'); assert.equal(result.counts.inserted, 1);
  assert.equal(result.counts.protected, 2); assert.equal(result.counts.removed, 0);
});

test('LQ plan skips every removal for unidentifiable rejection but still allows replacement', () => {
  const bad = syntheticCells(); bad[2] = null;
  const scope = [old('1', { remarks: 'old' }), old('2', { postal_code: '54321' })];
  const before = structuredClone(scope);
  const result = plan(parsed(bad, syntheticCells()), scope);
  assert.equal(result.result, 'partial'); assert.equal(result.counts.replaced, 1);
  assert.equal(result.counts.removed, 0);
  assert.ok(result.warnings.some(row => row.code === 'removals_skipped'));
  assert.deepEqual(scope, before);
});

test('LQ plan skips removals for invalid ZIPs and preserves rejected raw values', () => {
  for (const postalCode of ['9410', '941030']) {
    const bad = syntheticCells(); bad[2] = 'R1'; bad[3] = postalCode;
    const result = plan(parsed(bad, syntheticCells()), [old('1', { route_name: 'R1', postal_code: '94103' })],
      { maxRemovalRatio: 1 });
    assert.equal(result.result, 'partial');
    assert.equal(result.counts.inserted, 1);
    assert.deepEqual(result.removals, []);
    assert.equal(result.counts.plannedRemovals, 0);
    assert.equal(result.counts.protected, 0);
    assert.deepEqual(result.rejected, [{ sheetRow: 4, routeName: 'R1', postalCode, reason: 'postal_code_invalid' }]);
    assert.deepEqual(result.warnings, [{ code: 'removals_skipped' }]);
  }
});

test('LQ plan protects valid ZIP price-zero rejections while allowing unrelated removals', () => {
  const bad = syntheticCells(); bad[2] = ' R1 '; bad[3] = '94103'; bad[5] = 0;
  const scope = [old('1', { route_name: 'R1', postal_code: '94103' }),
    old('2', { route_name: 'R1', postal_code: '94103', effective_from: '2025-01-01' }),
    old('3', { postal_code: '54321' })];
  const result = plan(parsed(bad, syntheticCells()), scope, { maxRemovalRatio: 1 });
  assert.equal(result.result, 'partial');
  assert.equal(result.counts.inserted, 1);
  assert.equal(result.counts.protected, 2);
  assert.deepEqual(result.rejected, [{ sheetRow: 4, routeName: 'R1', postalCode: '94103', reason: 'price_zero' }]);
  assert.deepEqual(result.removals, [{ line_id: '3', voidReason: 'lark_removed' }]);
  assert.deepEqual(result.warnings.map(row => [row.line_id, row.code]),
    [['1', 'protected_by_rejected_row'], ['2', 'protected_by_rejected_row']]);
});

test('LQ plan permits exactly 20 percent removal, aborts above it and clears all writes', () => {
  const scope = Array.from({ length: 5 }, (_, i) => old(String(i + 1), { postal_code: String(12345 + i) }));
  const rows = scope.slice(0, 4).map(line => { const row = syntheticCells(); row[3] = line.postal_code; return row; });
  const allowed = plan(parsed(...rows), scope);
  assert.equal(allowed.result, 'completed');
  assert.deepEqual(allowed.removals, [{ line_id: '5', voidReason: 'lark_removed' }]);
  rows[0][5]++;
  const newRow = syntheticCells(); newRow[3] = '99999';
  const aborted = plan(parsed(...rows.slice(0, 3), newRow), scope);
  assert.equal(aborted.result, 'aborted_mass_removal');
  assert.equal(aborted.counts.plannedRemovals, 2);
  assert.deepEqual([aborted.inserts, aborted.replacements, aborted.removals], [[], [], []]);
  assert.equal(aborted.counts.inserted + aborted.counts.replaced + aborted.counts.removed, 0);
});

test('LQ plan empty sheet, all rejected priority, custom threshold and deterministic ordering', () => {
  assert.equal(plan(parsed()).result, 'unchanged');
  assert.equal(plan(parsed(), [old()]).result, 'aborted_mass_removal');
  assert.equal(plan(parsed(), [old()], { maxRemovalRatio: 1 }).counts.removed, 1);
  const bad = syntheticCells(); bad[2] = 'Unknown';
  const rejected = plan(parsed(bad), [old()]);
  assert.equal(rejected.result, 'rejected'); assert.equal(rejected.counts.plannedRemovals, 1);
  const p = parsed(syntheticCells(), syntheticCells()); p.rows.reverse();
  assert.deepEqual(plan(p).rejected.map(row => row.sheetRow), [4, 5]);
  const removal = plan(parsed(), [old('10'), old('2')], { maxRemovalRatio: 1 });
  assert.deepEqual(removal.removals.map(row => row.line_id), ['2', '10']);
});

test('LQ plan preserves parser warnings, skips removals for missing ZIP and prioritizes unchanged', () => {
  const missingZip = syntheticCells(); missingZip[3] = null;
  const good = syntheticCells(); good[21] = 'unexpected';
  const result = plan(parsed(missingZip, good), [old('1', { second_parcel_half_price_raw: 'unexpected' }),
    old('2', { postal_code: '54321' })]);
  assert.equal(result.result, 'unchanged');
  assert.equal(result.counts.unchanged, 1);
  assert.equal(result.counts.removed, 0);
  assert.deepEqual(result.warnings.map(row => row.code), ['half_price_flag_unexpected', 'removals_skipped']);
  assert.equal(result.rejected[0].postalCode, null);
});
