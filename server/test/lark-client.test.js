import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createLarkClient, LarkError } from '../src/quotations/lark-client.js';

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const auth = () => response({ code: 0, tenant_access_token: 'TOKEN-SENTINEL-456', expire: 3600 });
const client = options => createLarkClient({ apiBase: 'https://example.test/open-apis', appId: 'fake',
  appSecret: 'SECRET-SENTINEL-123', ...options });
test('Lark URLs, methods, body, render options and token early refresh', async () => {
  const calls = []; let time = 0;
  const api = client({ now: () => time, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (url.includes('/auth/')) return auth();
    if (url.endsWith('/query')) return response({ code: 0, data: { sheets: [{ sheet_id: 's', title: 'Mock', index: 1,
      hidden: false, grid_properties: { row_count: 427, column_count: 30 } }] } });
    return response({ code: 0, data: { valueRange: {}, revision: 42 } });
  } });
  assert.deepEqual(await api.querySheets('book'), [{ sheetId: 's', title: 'Mock', index: 1, hidden: false, rowCount: 427, columnCount: 30 }]);
  assert.deepEqual(await api.readValues('book', 's!A1:AD427'), { values: [], revision: 42 });
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { app_id: 'fake', app_secret: 'SECRET-SENTINEL-123' });
  assert.equal(calls[0].url, 'https://example.test/open-apis/auth/v3/tenant_access_token/internal');
  assert.equal(calls[1].url, 'https://example.test/open-apis/sheets/v3/spreadsheets/book/sheets/query');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].headers.Authorization, 'Bearer TOKEN-SENTINEL-456');
  assert.equal(calls[2].url, 'https://example.test/open-apis/sheets/v2/spreadsheets/book/values/s!A1%3AAD427?valueRenderOption=UnformattedValue&dateTimeRenderOption=FormattedString');
  assert.ok(calls.every(call => call.signal instanceof AbortSignal));
  time = 3299999; await api.getTenantToken(); assert.equal(calls.length, 3);
  time = 3300000; await api.getTenantToken(); assert.equal(calls.length, 4);
});
test('Lark invalid token codes refresh and retry exactly once', async () => {
  for (const code of [99991661, 99991663, 99991668]) {
    let tokens = 0, reads = 0;
    const api = client({ fetchImpl: async url => {
      if (url.includes('/auth/')) { tokens++; return auth(); }
      reads++; return response({ code, msg: 'ECHO-SENTINEL' });
    } });
    await assert.rejects(api.querySheets('book'), { kind: 'unexpected', stage: 'sheet_query', larkCode: code });
    assert.equal(tokens, 2); assert.equal(reads, 2);
  }
});
test('Lark error classification and sentinel redaction', async () => {
  for (const [status, code, kind] of [[429, 7, 'rate_limited'], [401, 7, 'permission'], [403, 7, 'permission'],
    [404, 7, 'not_found'], [500, 0, 'unexpected'], [200, 7, 'unexpected']]) {
    const api = client({ fetchImpl: async url => url.includes('/auth/') ? auth()
      : response({ code, msg: 'SECRET-SENTINEL-123 TOKEN-SENTINEL-456 ECHO-SENTINEL' }, status) });
    await assert.rejects(api.readValues('book', 's!A1'), error => {
      assert.ok(error instanceof LarkError); assert.equal(error.kind, kind); assert.equal(error.stage, 'values');
      assert.equal(error.httpStatus, status); assert.equal(error.larkCode, code);
      for (const output of [String(error), inspect(error), JSON.stringify(error)]) assert.ok(!output.includes('SENTINEL'));
      return true;
    });
  }
  await assert.rejects(client({ fetchImpl: async () => response({ code: 1, msg: 'ECHO-SENTINEL' }) }).getTenantToken(),
    { kind: 'credentials', stage: 'token' });
  await assert.rejects(client({ fetchImpl: async () => { throw new Error('SECRET-SENTINEL-123'); } }).getTenantToken(), { kind: 'network' });
  await assert.rejects(client({ timeoutMs: 1, fetchImpl: async (_url, { signal }) => {
    await new Promise(resolve => setTimeout(resolve, 10)); signal.throwIfAborted();
  } }).getTenantToken(), { kind: 'timeout' });
});
