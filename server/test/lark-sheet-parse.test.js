import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotationSheet, UNDATED_EFFECTIVE_FROM } from '../src/quotations/lark-sheet-parse.js';
import { sfoHeader, summaryHeader, syntheticCells } from './lark-quotation-fixtures.js';

const parse = (...rows) => parseQuotationSheet([...sfoHeader, ...rows]);

test('LQ-T20 parses first-only PRC, SAF and HNL headers without unrelated columns', () => {
  const bands = ['0 - 1(Ib)', '1-5(Ib)', '5-10(Ib)', '10-20(lb)', '20-30(lb)', '30-40(lb)', '40(Ib)以上/Above 40(lb)'];
  const fixtures = [
    { headers: [['DSP报价/Quotation for DSP'], ['站点名称/Station', '转运中心/Sorting Center', '线路名称/Route', '邮编/Zipcode', '参考邮编', '按重量段报价（美元/单）/Quotation by weight range (', null, null, null, null, null, null, null, '城市/地区', '备注/Remarks'], [null, null, null, null, null, ...bands, '是否使用第二票半价', null, '生效日期']], row: ['PRC', 'XAE', 'WE - PRC01 - 001', '86301', '86301', 2, 2, 2.2, 2.2, 5, 5, 5, '是', 'Prescott', '2026/11/1'], route: 'WE - PRC01 - 001', zip: '86301', prices: [2, 2, 2.2, 2.2, 5, 5, 5], effective: '2026-11-01' },
    { headers: [['城市', 'DSP', '格口对应', '邮编', '参考邮编', '价格', null, null, null, null, null, null, '第二件半价是否实施', '线路分类和更新日期', '面单编号', '额外补充', '生效时间', '司机配送效率 PPR'], [null, null, null, null, null, ...bands], []], row: ['SAF', 'WDL', 'SAF01-001', '87505', '87505', 2.2, 2.2, 2.4, 2.4, 5, 5, 5, '是', '2026/5/4', 'WE-SAF01-001'], route: 'SAF01-001', zip: '87505', prices: [2.2, 2.2, 2.4, 2.4, 5, 5, 5], effective: UNDATED_EFFECTIVE_FROM },
    { headers: [['站点', 'DSP', '线路编号', '邮编', '参考邮编', '预期价格+开半价', '价格', null, null, null, null, null, null, '难易程度', '线路分类和更新日期', '城市', '额外补充', '生效时间', '日均单量'], [null, null, null, null, null, null, ...bands], []], row: ['HNL', 'HNL-ZHN', 'HNL01-001', '96712', '96712', 9, 3, 3, 3, 3, 5, 5, 5, '易', '2026/9/21', 'Haleiwa'], route: 'HNL01-001', zip: '96712', prices: [3, 3, 3, 3, 5, 5, 5], effective: UNDATED_EFFECTIVE_FROM },
  ];
  for (const fixture of fixtures) {
    const result = parseQuotationSheet([...fixture.headers, fixture.row]);
    assert.equal(result.ok, true);
    assert.equal(result.rows[0].routeName, fixture.route);
    assert.equal(result.rows[0].postalCode, fixture.zip);
    assert.deepEqual(Object.values(result.rows[0].first), fixture.prices);
    assert.equal(result.rows[0].effectiveFrom, fixture.effective);
    assert.equal(Boolean(result.rows[0].undatedEffective), fixture.effective === UNDATED_EFFECTIVE_FROM);
    assert.deepEqual(result.rows[0].additional, {});
    assert.ok(result.notes.includes('additional_columns_missing'));
    const partial = structuredClone(fixture.headers);
    partial[result.headerRowIndex].push('续票价格 0-1(lb)');
    const invalid = parseQuotationSheet(partial);
    assert.equal(invalid.error, 'header_invalid');
    assert.ok(invalid.detail.includes('additional.1_5'));
  }
  const ungrouped = structuredClone(fixtures[2].headers); ungrouped[0][6] = null;
  assert.equal(parseQuotationSheet(ungrouped).error, 'header_invalid');
});

test('LQ-T17 parses rich text headers and data cells', () => {
  const rich = value => [{ type: 'text', text: String(value).slice(0, 3) }, { type: 'text', text: String(value).slice(3) }];
  const headers = sfoHeader.map(row => row.map(value => value == null ? value : rich(value)));
  const row = syntheticCells();
  row[2] = rich('WE - CGZ01 - 001'); row[3] = rich('85138'); row[5] = rich('2.2');
  row[19] = rich('2026/7/20'); row[20] = rich('2027/7/20');
  const result = parseQuotationSheet([...headers, row]);
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].routeName, 'WE - CGZ01 - 001');
  assert.equal(result.rows[0].postalCode, '85138');
  assert.equal(result.rows[0].first['0_1'], 2.2);
  assert.equal(result.rows[0].effectiveFrom, '2026-07-20');
  assert.equal(result.rows[0].endDate, '2027-07-20');
});

test('LQ-T17 prefers quotation effective date and preserves single-kind duplicate checks', () => {
  const headers = structuredClone(sfoHeader);
  headers[1][19] = '报价生效日期'; headers[2][19] = null; headers[2][23] = '生效日期';
  const dated = syntheticCells(); dated[19] = '2026/7/20'; dated[23] = '2027/7/20';
  const undated = syntheticCells(); undated[19] = null; undated[20] = null; undated[23] = '2027/7/20';
  const result = parseQuotationSheet([...headers, dated, undated]);
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].effectiveFrom, '2026-07-20');
  assert.equal(result.rows[1].effectiveFrom, UNDATED_EFFECTIVE_FROM);
  assert.equal(result.rows[1].undatedEffective, true);
  const onlyQuotation = structuredClone(headers); onlyQuotation[2][23] = null;
  assert.equal(parseQuotationSheet([...onlyQuotation, dated]).rows[0].effectiveFrom, '2026-07-20');
  onlyQuotation[2][23] = '报价生效日期';
  assert.equal(parseQuotationSheet(onlyQuotation).ok, false);
});

test('LQ-T14 parses LAS headers without treating postal difficulty as a ZIP column', () => {
  const headers = structuredClone(sfoHeader);
  headers[1][3] = '邮编\n /Zipcode';
  headers[1][4] = '参考邮编（唯一值）\n /Reference postal code';
  for (const row of headers) row.splice(5, 0, null, null);
  headers[1][5] = '邮编难易度';
  headers[1][6] = '熟手PPH（件）50%';
  const row = syntheticCells();
  row[2] = 'LAS01-03'; row[3] = '89103'; row[4] = '99999'; row[5] = 1.9; row[19] = '9/14/2026';
  row.splice(5, 0, '难', 50);
  const result = parseQuotationSheet([...headers, row]);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].postalCode, '89103');
  assert.equal(result.rows[0].referencePostalCode, '99999');
  assert.equal(result.rows[0].routeName, 'LAS01-03');
  assert.equal(result.rows[0].first['0_1'], 1.9);
  assert.equal(result.rows[0].effectiveFrom, '2026-09-14');
  for (const label of ['邮编', '邮编/Zipcode', 'ZIPCODE']) {
    headers[1][3] = label;
    assert.equal(parseQuotationSheet([...headers, row]).rows[0].postalCode, '89103', label);
  }
});

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
  [19, '02/30/2026', 'date_invalid'], [19, '11/1/20217', 'date_invalid'],
  [19, '2026-11/01', 'date_invalid'], [20, '10/31/2026', 'end_before_effective'],
  [20, '02/29/2025', 'date_invalid'],
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
  for (const [value, reason] of [['2025/2/29', 'date_invalid'], ['26/1/1', 'date_invalid']]) {
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
  const sfv = structuredClone(lax); sfv[2][19] = '生效日期'; sfv[2].push('\u751f\u6548\u65e5\u671f');
  assert.equal(parseQuotationSheet(sfv).ok, false);
  const duplicateEnd = structuredClone(lax); duplicateEnd[2].push('\u7ed3\u675f\u65e5\u671f');
  assert.equal(parseQuotationSheet(duplicateEnd).ok, false);
  const quotation = structuredClone(sfoHeader); quotation[2].push('\u62a5\u4ef7\u65e5\u671f');
  assert.deepEqual(parseQuotationSheet([...quotation, syntheticCells()]).rows, parse(syntheticCells()).rows);
});


test('LQ-T10 accepts four date formats and maps every two-digit year to 20YY', () => {
  for (const [value, expected] of [
    ['2/29/2024', '2024-02-29'], ['2024/2/29', '2024-02-29'],
    ['2024-02-29', '2024-02-29'], ['2024-2-9', '2024-02-09'],
    ['2/29/24', '2024-02-29'], ['10/26/26', '2026-10-26'],
    ['1/1/00', '2000-01-01'], ['12/31/99', '2099-12-31'],
  ]) {
    const row = syntheticCells(); row[19] = value; row[20] = value;
    const result = parse(row);
    assert.deepEqual(result.rejected, [], value);
    assert.equal(result.rows[0].effectiveFrom, expected, value);
    assert.equal(result.rows[0].endDate, expected, value);
  }
});

test('LQ-T10 rejects invalid dates and distinguishes numeric cells and placeholders in both columns', () => {
  for (const column of [19, 20]) for (const [value, reason] of [
    ['2025-02-29', 'date_invalid'], ['2/29/25', 'date_invalid'],
    ['2026-13-1', 'date_invalid'], ['2026-4-31', 'date_invalid'],
    ['0/1/26', 'date_invalid'], ['1/0/26', 'date_invalid'],
    ['26-1-1', 'date_invalid'], ['1/1/026', 'date_invalid'],
    ['2026/1-1', 'date_invalid'], ['2026-1/1', 'date_invalid'],
    ['2026-11-01T00:00:00Z', 'date_invalid'], ['46118', 'date_invalid'],
    [0, 'date_not_date_cell'], [NaN, 'date_not_date_cell'],
  ]) {
    const row = syntheticCells(); row[19] = '1/1/00'; row[column] = value;
    const result = parse(row);
    assert.equal(result.rows.length, 0);
    assert.equal(result.rejected[0].reason, reason, `${column}: ${value}`);
  }
});

test('LQ-T10 OAR 40-plus headers map all 14 synthetic prices with bounded ranges', () => {
  for (const upper of [1000, 999999]) {
    const headers = structuredClone(sfoHeader);
    headers[2].splice(5, 7, '0 - 1(Ib)', '1-5(Ib)', '5-10(Ib)', '10-20(lb)', '20-30(lb)', '30-40(lb)', `40-${upper}(Ib)`);
    headers[2][18] = `续票价格 40-${upper}(Ib)/Quotation for second and subsequent pieces`;
    const result = parseQuotationSheet([...headers, syntheticCells()]);
    assert.deepEqual(result.rows, parse(syntheticCells()).rows);
    assert.equal(Object.keys(result.rows[0].first).length + Object.keys(result.rows[0].additional).length, 14);
    const explicit = structuredClone(headers); explicit[2][11] = `首票价格 40-${upper}(lb)`;
    assert.deepEqual(parseQuotationSheet([...explicit, syntheticCells()]).rows, result.rows);
    for (const column of [11, 18]) for (const label of ['40-999(lb)', '140-1000(lb)', '40-1000.5(lb)']) {
      const invalid = structuredClone(headers);
      invalid[2][column] = `${column === 11 ? '首票价格' : '续票价格'} ${label}`;
      assert.equal(parseQuotationSheet(invalid).error, 'header_invalid', label);
    }
  }
});


test('LQ-T11a accepts blank effective dates and counts only accepted rows', () => {
  const blank = syntheticCells(); blank[19] = '  ';
  const ended = syntheticCells(); ended[19] = null; ended[20] = '2026-12-31';
  const tooEarly = syntheticCells(); tooEarly[19] = null; tooEarly[20] = '1999-12-31';
  const invalid = syntheticCells(); invalid[19] = null; invalid[5] = 0;
  const result = parse(blank, ended, tooEarly, invalid, syntheticCells());
  assert.equal(result.undatedRowCount, 2);
  assert.deepEqual(result.rows.slice(0, 2).map(row => [row.effectiveFrom, row.endDate, row.undatedEffective]),
    [[UNDATED_EFFECTIVE_FROM, null, true], [UNDATED_EFFECTIVE_FROM, '2026-12-31', true]]);
  assert.deepEqual(result.rejected.map(row => row.reason), ['end_before_effective', 'price_zero']);
});


test('LQ-T19 accepts placeholders and numeric dates, and skips only imprecise additional bands', () => {
  const placeholder = syntheticCells(); placeholder[19] = ' ######## '; placeholder[20] = '###';
  const undated = parse(placeholder);
  assert.equal(undated.rows[0].effectiveFrom, UNDATED_EFFECTIVE_FROM);
  assert.equal(undated.rows[0].undatedEffective, true);
  assert.equal(undated.rows[0].endDate, null);
  assert.equal(undated.undatedRowCount, 1);
  const numeric = syntheticCells(); numeric[19] = 46000.9; numeric[20] = 46000;
  const dates = parse(numeric);
  assert.equal(dates.rows[0].effectiveFrom, '2025-12-09');
  assert.equal(dates.rows[0].endDate, '2025-12-09');
  for (const column of [19, 20]) {
    const invalid = syntheticCells(); invalid[column] = 1000000;
    assert.equal(parse(invalid).rejected[0].reason, 'date_not_date_cell');
  }
  const row = syntheticCells(); row[12] = 1.075; row[13] = 1.125;
  const result = parse(row);
  assert.equal(result.rows[0].first['0_1'], 900);
  assert.equal(result.rows[0].additional['0_1'], undefined);
  assert.equal(result.rows[0].additional['1_5'], undefined);
  assert.equal(result.rows[0].additional['5_10'], 909);
  assert.deepEqual(result.warnings, [{ sheetRow: 4, routeName: 'Mock Route', postalCode: '12345', code: 'additional_price_precision_skipped' }]);
  row[5] = 1.075;
  assert.equal(parse(row).rejected[0].reason, 'price_precision');
});
