import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotationSheet } from '../src/quotations/lark-sheet-parse.js';
import { sfoHeader, summaryHeader, syntheticCells } from './lark-quotation-fixtures.js';

const parse = (...rows) => parseQuotationSheet([...sfoHeader, ...rows]);

test('LQ parser maps real SFO multirow headers and preserves optional raw text', () => {
  const cells = syntheticCells();
  cells[21] = ' unexpected '; cells[4] = 123;
  const parsed = parse(cells);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.headerRowIndex, 2);
  assert.equal(parsed.dataStartRow, 4);
  assert.deepEqual(parsed.rows[0], { sheetRow: 4, routeName: 'Mock Route', postalCode: '12345',
    stationLabelRaw: 'Mock Station', fleetName: 'Mock Fleet', referencePostalCode: '123',
    first: { '0_1': 900, '1_5': 901, '5_10': 902, '10_20': 903, '20_30': 904, '30_40': 905, '40_plus': 906 },
    additional: { '0_1': 907, '1_5': 908, '5_10': 909, '10_20': 910, '20_30': 911, '30_40': 912, '40_plus': 913 },
    effectiveFrom: '2026-11-01', endDate: null, secondParcelHalfPriceRaw: 'unexpected', remarks: 'Mock remarks' });
  assert.deepEqual(parsed.warnings, [{ sheetRow: 4, routeName: 'Mock Route', postalCode: '12345', code: 'half_price_flag_unexpected' }]);
});

test('LQ parser rejects summary, missing and duplicate columns without confusing weight boundaries', () => {
  assert.equal(parseQuotationSheet(summaryHeader).error, 'header_invalid');
  const missing = structuredClone(sfoHeader); missing[2][5] = null;
  assert.ok(parseQuotationSheet(missing).detail.includes('first.0_1'));
  const duplicate = structuredClone(sfoHeader); duplicate[2].push(duplicate[2][8]);
  assert.ok(parseQuotationSheet(duplicate).detail.includes('first.10_20'));
  const noEnd = structuredClone(sfoHeader); noEnd[2][20] = null;
  assert.deepEqual(parseQuotationSheet(noEnd).notes, ['end_date_column_missing']);
  assert.equal(parseQuotationSheet(sfoHeader, { headerScanRows: 2 }).ok, false);
  const unitless = structuredClone(sfoHeader);
  unitless[2][5] = 'first 0-1';
  assert.equal(parseQuotationSheet(unitless).ok, true);
});

test('LQ parser locates reordered columns and supports a single header row without optional columns', () => {
  const headers = sfoHeader[2].map((value, i) => value?.trim() ? value : sfoHeader[1][i]);
  const indices = [2, 3, ...Array.from({ length: 16 }, (_, i) => i + 5)].reverse();
  const row = syntheticCells(); row[3] = '01234';
  const parsed = parseQuotationSheet([indices.map(i => headers[i]), indices.map(i => row[i])]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows[0].postalCode, '01234');
  for (const field of ['stationLabelRaw', 'fleetName', 'referencePostalCode', 'secondParcelHalfPriceRaw', 'remarks'])
    assert.equal(parsed.rows[0][field], null);
});

for (const [column, value, reason] of [
  [2, ' ', 'route_missing'], [3, '1234', 'postal_code_invalid'], [3, 12345.5, 'postal_code_invalid'],
  [5, null, 'price_missing'], [5, ' ', 'price_missing'], [5, '1e2', 'price_invalid'],
  [5, '-1', 'price_invalid'], [5, -1, 'price_invalid'], [5, Infinity, 'price_invalid'],
  [5, NaN, 'price_invalid'], [5, '9usd', 'price_invalid'], [5, '1,000', 'price_invalid'],
  [5, 0, 'price_zero'], [5, '0', 'price_zero'], [5, 900.123, 'price_precision'],
  [19, null, 'date_invalid'], [19, '02/30/2026', 'date_invalid'], [19, '11/1/20217', 'date_invalid'],
  [19, 46307, 'date_invalid'], [19, '2026-11-01', 'date_invalid'], [20, '10/31/2026', 'end_before_effective'],
  [20, '02/29/2025', 'date_invalid'], [20, 46308, 'date_invalid'],
]) test(`LQ parser rejects ${reason}: column ${column}, ${String(value)}`, () => {
  const cells = syntheticCells(); cells[column] = value;
  const parsed = parse(cells);
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.rejected[0].reason, reason);
  assert.deepEqual(Object.keys(parsed.rejected[0]), ['sheetRow', 'routeName', 'postalCode', 'reason']);
});

test('LQ parser skips blank/short rows, retains date-only rows and follows rejection priority', () => {
  const dateOnly = []; dateOnly[19] = '11/1/2026';
  const invalid = syntheticCells(); invalid[2] = null; invalid[3] = null; invalid[5] = null;
  const parsed = parse([], [null, '\n'], dateOnly, invalid);
  assert.equal(parsed.blankRowCount, 2);
  assert.equal(parsed.dataRowCount, 2);
  assert.deepEqual(parsed.rejected.map(row => row.reason), ['route_missing', 'route_missing']);
  assert.equal(parsed.rejected[1].routeName, null);
  assert.equal(parsed.rejected[1].postalCode, null);
});

test('LQ parser accepts strict decimals, floating noise, leap day and inclusive end date', () => {
  const row = syntheticCells(); row[5] = 2.9999999999999996; row[6] = ' 900.25 ';
  row[19] = '2/29/2024'; row[20] = '02/29/2024'; row[21] = '否'; row[0] = 123; row[22] = '\n';
  const before = structuredClone(row), parsed = parse(row);
  assert.deepEqual(row, before);
  assert.equal(parsed.rows[0].first['0_1'], 3);
  assert.equal(parsed.rows[0].first['1_5'], 900.25);
  assert.equal(parsed.rows[0].effectiveFrom, '2024-02-29');
  assert.equal(parsed.rows[0].endDate, '2024-02-29');
  assert.equal(parsed.rows[0].stationLabelRaw, '123');
  assert.equal(parsed.rows[0].remarks, null);
  assert.deepEqual(parsed.warnings, []);
});

test('LQ extended dates and California header fixtures', () => {
  for (const value of ['2024/2/29', '2/29/2024']) {
    const row = syntheticCells(); row[19] = value; row[20] = value;
    assert.equal(parse(row).rows[0].endDate, '2024-02-29');
  }
  for (const [value, reason] of [['2025/2/29', 'date_invalid'], ['26/1/1', 'date_invalid'], ['########', 'date_placeholder']]) {
    const row = syntheticCells(); row[19] = value;
    assert.equal(parse(row).rejected[0].reason, reason);
  }
  const lax = structuredClone(sfoHeader);
  lax[2].splice(5, 7, '0 - 1(Ib)', '1-5(Ib)', '5-10(Ib)', '10-20(lb)', '20-30(lb)', '30-40(lb)', '40(Ib)\u4ee5\u4e0a');
  assert.equal(parseQuotationSheet([...lax, syntheticCells()]).rows.length, 1);
  const smf = lax.map(row => row.filter((_, i) => i !== 4));
  assert.equal(parseQuotationSheet([...smf, syntheticCells().filter((_, i) => i !== 4)]).rows.length, 1);
  const cno = structuredClone(lax); cno[2][20] = null;
  const cnoResult = parseQuotationSheet([...cno, syntheticCells()]);
  assert.equal(cnoResult.rows[0].endDate, null);
  assert.deepEqual(cnoResult.notes, ['end_date_column_missing']);
  const ungrouped = structuredClone(lax); ungrouped[1][5] = null;
  assert.equal(parseQuotationSheet(ungrouped).ok, false);
  const sfv = structuredClone(lax); sfv[2].push('\u751f\u6548\u65e5\u671f');
  assert.equal(parseQuotationSheet(sfv).ok, false);
  const duplicateEnd = structuredClone(lax); duplicateEnd[2].push('\u7ed3\u675f\u65e5\u671f');
  assert.equal(parseQuotationSheet(duplicateEnd).ok, false);
  const quotation = structuredClone(sfoHeader); quotation[2].push('\u62a5\u4ef7\u65e5\u671f');
  assert.deepEqual(parseQuotationSheet([...quotation, syntheticCells()]).rows, parse(syntheticCells()).rows);
});
