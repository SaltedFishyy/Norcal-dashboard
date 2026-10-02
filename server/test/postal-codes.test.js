import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { parseRoutePostalCodes, findPostalCodeConflicts } from '../src/transform/postal-codes.js';
import { transformRoutePortrait, SchemaError } from '../src/transform/route-profile.js';
import { runScrape } from '../bin/dms-scrape.js';

const record = (postalCodeList, postalCodeNum) => ({ roadAreaId: 900001, roadAreaName: 'Mock Route', postalCodeList, postalCodeNum });
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/route-portrait-pagination.json', import.meta.url), 'utf8'));
const options = { station: 'SFO01', fetchedAt: '2026-10-02T00:00:00Z' };

test('postal codes parse strings, whitespace, leading zero and empty lists without mutation', () => {
  const input = record(' 00123 ,00002 ', '2');
  assert.deepEqual(parseRoutePostalCodes(input), ['00123', '00002']);
  assert.equal(input.postalCodeList, ' 00123 ,00002 ');
  for (const value of [null, '']) for (const count of [0, '0']) assert.deepEqual(parseRoutePostalCodes(record(value, count)), []);
});

const invalid = [
  ['short ZIP', record('1234', 1), /ZIP 格式/],
  ['long ZIP', record('123456', 1), /ZIP 格式/],
  ['non-digit ZIP', record('abcde', 1), /ZIP 格式/],
  ['empty item', record('00123,', 2), /ZIP 格式/],
  ['whitespace only', record(' ', 0), /ZIP 格式/],
  ['duplicate', record('00123,00123', 2), /重复.*00123/],
  ['count mismatch', record('00123', 2), /数量/],
  ['null list nonzero', record(null, 1), /数量/],
  ['empty list nonzero', record('', 1), /数量/],
  ['wrong list type', record(['00123'], 1), /postalCodeList/],
  ['missing list', { roadAreaId: 900001, roadAreaName: 'Mock Route', postalCodeNum: 0 }, /缺少 postalCodeList/],
  ...[undefined, null, -1, 1.5, Infinity, true, '', ' 1', '1.0', '1e0', '-1', {}, Number.MAX_SAFE_INTEGER + 1]
    .map((count, i) => [`invalid count ${i}`, record('00123', count), /postalCodeNum/]),
];
for (const [name, input, reason] of invalid) test(`postal codes reject ${name} with Route identity`, () => {
  assert.throws(() => parseRoutePostalCodes(input), (error) => {
    assert.ok(error instanceof SchemaError); assert.match(error.message, /900001.*Mock Route/); assert.match(error.message, reason); return true;
  });
});

test('Station conflict report includes ZIP and every Route identity', () => {
  const rows = [1, 2, 3].map((route_id) => ({ route_id, route_name: `Mock-${route_id}`, postal_codes: ['00123'] }));
  assert.deepEqual(findPostalCodeConflicts(rows), [{ postal_code: '00123', routes: rows.map(({ route_id, route_name }) => ({ route_id, route_name })) }]);
});

test('transform includes normalized ZIPs and original raw fields', () => {
  const body = structuredClone(fixture);
  body.data.records[0].postalCodeList = ' 00123 ,00002,00003 ';
  body.data.records[0].postalCodeNum = '3';
  const row = transformRoutePortrait(body, options).stationSnapshot.rows[0];
  assert.deepEqual(row.postal_codes, ['00123', '00002', '00003']);
  assert.equal(row.raw.postalCodeList, ' 00123 ,00002,00003 '); assert.equal(row.raw.postalCodeNum, '3');
});

test('every ZIP validation failure rejects whole transform instead of parse_errors', () => {
  for (const [, input] of invalid) {
    const body = structuredClone(fixture);
    delete body.data.records[0].postalCodeList; delete body.data.records[0].postalCodeNum;
    Object.assign(body.data.records[0], input);
    assert.throws(() => transformRoutePortrait(body, options), SchemaError);
  }
  const body = structuredClone(fixture);
  body.data.records[1].postalCodeList = '00123,00005,00006,00007';
  assert.throws(() => transformRoutePortrait(body, options), /SFO01.*00123.*900001.*SFO01-901.*900002.*SFO01-902/);
});

test('scrape transform failure never saves snapshot and records SchemaError reason', async () => {
  const body = structuredClone(fixture); body.data.records[0].postalCodeNum = 99;
  let saved = false, failure;
  const code = await runScrape({ args: ['--station', 'SFO01'],
    env: { DMS_BASE_URL: 'https://example.invalid', RUNTIME_DATA_DIR: 'synthetic-runtime' },
    log: () => {}, errorLog: () => {}, sessionExists: async () => {}, capture: async () => ({ body }),
    save: async () => { saved = true; }, failure: async (value) => { failure = value; } });
  assert.equal(code, 1); assert.equal(saved, false);
  assert.equal(failure.step, 'transform'); assert.equal(failure.errorType, 'SchemaError');
  assert.match(failure.detail, /900001.*postalCodeNum.*99/);
});
