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

test('LQ-T17 matches normalized names before aliases while retaining sheet names', () => {
  const route = name => ({ route_id: name, route_name: name, station_code: 'DMS', postal_codes: ['12345'] });
  const run = (name, names) => {
    const row = syntheticCells(); row[2] = name;
    return plan(parsed(row), [], { activeRoutes: names.map(route) });
  };
  for (const [name, dms] of [['IFP01 - 001', 'IFP01-001'], ['WE - CGZ01 - 001', 'CGZ01-001'],
    ['RDG01-004', 'WE-RDG01-004'], ['WE-RDG01-004', 'RDG01-004']]) {
    const result = run(name, [dms]);
    assert.equal(result.inserts[0].route_id, dms);
    assert.equal(result.inserts[0].route_name, name);
    assert.equal(result.warnings[0].code, 'route_name_normalized');
  }
  assert.equal(run('RDG01 - 004', ['RDG01-004', 'WE-RDG01-004']).rejected[0].reason, 'route_ambiguous');
  const exact = run('RDG01-004', ['RDG01-004', 'WE-RDG01-004']);
  assert.equal(exact.inserts[0].route_id, 'RDG01-004');
  assert.deepEqual(exact.warnings, []);
  const alias = run('WE - LAS02 - 01', ['LAS01-01']);
  assert.equal(alias.inserts[0].route_id, 'LAS01-01');
  assert.equal(alias.warnings[0].code, 'route_alias_matched');
});

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

test('LQ-T15 matches aliases only with a unique prefix, sequence and ZIP', () => {
  const run = (name, zip, routes) => {
    const row = syntheticCells(); row[2] = name; row[3] = zip;
    return plan(parsed(row), [], { activeRoutes: routes });
  };
  const route = (name, zip, id = name) => ({ route_id: id, route_name: name, station_code: 'DMS', postal_codes: [zip] });
  for (const [name, zip, dms] of [['LAS02-01', '89110', 'LAS01-01'],
    ['SFO02-002', '94501', 'SFO01-002'], ['WE-RDG02-004', '12345', 'WE-RDG01-004']]) {
    const result = run(name, zip, [route(dms, zip)]);
    assert.equal(result.inserts[0].route_id, dms);
    assert.equal(result.inserts[0].station_code, 'DMS');
    assert.equal(result.inserts[0].route_name, name);
    assert.equal(result.warnings[0].code, 'route_alias_matched');
  }
  for (const [name, zip, routes] of [
    ['SMX02-002', '93442', [route('SMX01-002', '93443')]],
    ['LAS02-01', '89110', [route('SFO01-01', '89110')]],
    ['LAS02-01', '89110', [route('LAS01-01', '89110'), route('LAS03-01', '89110')]],
  ]) assert.equal(run(name, zip, routes).rejected[0].reason, 'route_not_found');
  for (const [name, dms] of [['BKD-002', 'BKD-004'], ['BKD-005', 'BKD01-005']]) {
    const result = run(name, '12345', [route(dms, '12345')]);
    assert.equal(result.inserts[0].route_id, dms);
    assert.equal(result.inserts[0].route_name, name);
    assert.deepEqual(result.warnings.map(warning => warning.code), ['route_zip_matched']);
  }
  const exact = run('LAS02-01', '89110', [route('LAS02-01', '89110'), route('LAS01-01', '89110')]);
  assert.equal(exact.inserts[0].route_id, 'LAS02-01');
  assert.deepEqual(exact.warnings, []);
});

test('LQ-T21 falls back to a unique same-prefix ZIP after earlier matches', () => {
  const route = (name, zips) => ({ route_id: name, route_name: name, station_code: 'DMS', postal_codes: zips });
  const run = (name, zip, routes) => {
    const row = syntheticCells(); row[2] = name; row[3] = zip;
    return plan(parsed(row), [], { activeRoutes: routes });
  };
  for (const [name, zip, routes, expected] of [
    ['BKD-003', '93203', [route('BKD-004', ['93263']), route('BKD-005', ['93203'])], 'BKD-005'],
    ['SMX02-002', '93442', [route('SMX01-002', ['93443']), route('SMX01-005', ['93442'])], 'SMX01-005'],
  ]) {
    const result = run(name, zip, routes);
    assert.equal(result.inserts[0].route_id, expected);
    assert.equal(result.inserts[0].route_name, name);
    assert.deepEqual(result.warnings.map(warning => warning.code), ['route_zip_matched']);
  }
  for (const [name, zip, routes] of [
    ['SMF01-002', '95824', [route('SCK01-009', ['95824'])]],
    ['BKD-003', '93203', [route('BKD-004', ['93203']), route('BKD-005', ['93203'])]],
    ['BKD-003', '93203', [route('BKD-005', ['93204'])]],
  ]) assert.equal(run(name, zip, routes).rejected[0].reason, 'route_not_found');
  for (const [name, routes, expected, warning] of [
    ['LAS02-01', [route('LAS02-01', ['89110']), route('LAS01-02', ['89110'])], 'LAS02-01', []],
    ['WE - LAS02 - 01', [route('LAS02-01', ['89110']), route('LAS01-02', ['89110'])], 'LAS02-01', ['route_name_normalized']],
    ['LAS02-01', [route('LAS01-01', ['89110']), route('LAS01-02', ['89110'])], 'LAS01-01', ['route_alias_matched']],
  ]) {
    const result = run(name, '89110', routes);
    assert.equal(result.inserts[0].route_id, expected);
    assert.deepEqual(result.warnings.map(item => item.code), warning);
  }
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


test('LQ-T11a plans dated and undated quotations as distinct keys', () => {
  const undated = syntheticCells(); undated[19] = null;
  const result = plan(parsed(undated, syntheticCells()));
  assert.equal(result.counts.undated, 1);
  assert.deepEqual(result.inserts.map(row => row.effective_from), ['2000-01-01', '2026-11-01']);
  assert.deepEqual(result.rejected, []);
});


test('LQ-T19 compares missing price bands consistently', () => {
  const row = syntheticCells(); row[12] = 1.075;
  const p = parsed(row), existing = old();
  delete existing.additional['0_1'];
  assert.equal(plan(p, [existing]).result, 'unchanged');
  existing.additional['0_1'] = null;
  assert.equal(plan(p, [existing]).result, 'unchanged');
  existing.additional['0_1'] = 1;
  assert.equal(plan(p, [existing]).counts.replaced, 1);
  delete existing.additional['0_1'];
  assert.equal(plan(parsed(syntheticCells()), [existing]).counts.replaced, 1);
});
