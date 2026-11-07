import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readLarkQuotationConfig } from '../src/quotations/lark-config.js';

export const fakeLarkEnv = { LARK_APP_ID: 'fake-app', LARK_APP_SECRET: 'SECRET-SENTINEL-123',
  LARK_QUOTATION_SPREADSHEET_TOKEN: 'fake-spreadsheet', LARK_QUOTATION_SHEET_ID: 'uAaPvG' };
test('Lark config defaults, normalization and secret serialization', () => {
  const config = readLarkQuotationConfig(fakeLarkEnv);
  assert.equal(config.apiBase, 'https://open.larkenterprise.com/open-apis');
  assert.equal(config.maxRemovalRatio, 0.2); assert.equal(config.syncMinutes, 0);
  assert.equal(config.appSecret, fakeLarkEnv.LARK_APP_SECRET);
  for (const output of [JSON.stringify(config), inspect(config)]) assert.ok(!output.includes('SECRET-SENTINEL'));
  for (const suffix of ['', '/', '/open-apis', '/open-apis/'])
    assert.equal(readLarkQuotationConfig({ ...fakeLarkEnv, LARK_OPEN_API_BASE: 'https://example.test' + suffix }).apiBase,
      'https://example.test/open-apis');
});
test('Lark config rejects invalid values without reflecting inputs', () => {
  for (const [key, values] of Object.entries({ LARK_OPEN_API_BASE: ['http://example.test', 'SECRET-SENTINEL-123'],
    LARK_QUOTATION_MAX_REMOVAL_RATIO: ['', '0', '-1', '1.1', 'NaN'],
    LARK_QUOTATION_SYNC_MINUTES: ['', '-1', '0.5', 'NaN'] }))
    for (const value of values) assert.throws(() => readLarkQuotationConfig({ ...fakeLarkEnv, [key]: value }),
      error => error.message === `Invalid ${key}`);
  assert.throws(() => readLarkQuotationConfig({ LARK_APP_SECRET: 'SECRET-SENTINEL-123' }),
    { message: 'Missing: LARK_APP_ID, LARK_QUOTATION_SPREADSHEET_TOKEN' });
});

test('Lark sheet whitelist normalization and conflicts', () => {
  assert.deepEqual(readLarkQuotationConfig({ ...fakeLarkEnv, LARK_QUOTATION_SHEET_IDS: ' A, uAaPvG, A,, B ' }).sheetIds, ['A', 'uAaPvG', 'B']);
  for (const list of ['', 'bad-id', 'A', Array.from({length:61}, (_, i) => `S${i}`).join(',')])
    assert.throws(() => readLarkQuotationConfig({ ...fakeLarkEnv, LARK_QUOTATION_SHEET_IDS: list }));
  assert.deepEqual(readLarkQuotationConfig({ ...fakeLarkEnv, LARK_QUOTATION_SHEET_ID: undefined, LARK_QUOTATION_SHEET_IDS: 'A,B' }).sheetIds, ['A', 'B']);
});
