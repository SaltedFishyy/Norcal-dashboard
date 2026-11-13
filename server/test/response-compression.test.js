import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { createRequestHandler } from '../src/api/app.js';
import { sendBody, sendJson, sendJsonCompressed } from '../src/api/http-utils.js';
import { createWorkerServer } from '../src/worker/worker.js';

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function request(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

const large = { district: 'south-cal', mock: true, text: '模拟数据'.repeat(500) };
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

test('MVR-T10 bodyless JSON responses retain 204 status', async t => {
  const url = await listen(t, http.createServer((req, res) => {
    void sendJsonCompressed(req, res, 204, undefined);
  }));
  const response = await request(url, { 'Accept-Encoding': 'gzip' });
  assert.equal(response.status, 204); assert.equal(response.body.length, 0);
  assert.equal(response.headers['content-encoding'], undefined);
});

test('MVR-T10 district JSON negotiates gzip by token and preserves payload and headers', async t => {
  const url = await listen(t, http.createServer(createRequestHandler({ getDistrictMap: async () => large })));
  for (const encoding of [undefined, 'br', 'xgzip', 'gzip;q=0', 'br, gzip; q=0.000', 'gzip;q=0, *;q=1',
    'gzip', 'br, GZip; q=0.5']) {
    const compressed = ['gzip', 'br, GZip; q=0.5'].includes(encoding);
    const response = await request(url + '/api/route-map/district?district=south-cal',
      encoding === undefined ? {} : { 'Accept-Encoding': encoding });
    assert.equal(response.status, 200);
    for (const [key, value] of Object.entries(jsonHeaders)) assert.equal(response.headers[key], value);
    assert.equal(response.headers['content-encoding'], compressed ? 'gzip' : undefined);
    assert.equal(response.headers.vary, compressed ? 'Accept-Encoding' : undefined);
    const body = compressed ? gunzipSync(response.body) : response.body;
    assert.equal(body.toString(), JSON.stringify(large));
  }
});

test('MVR-T10 compression threshold is strictly greater than 1024 UTF-8 bytes', async t => {
  let body;
  const url = await listen(t, http.createServer(createRequestHandler({ getDistrictMap: async () => body })));
  for (const value of ['a'.repeat(100), 'a'.repeat(1022), 'a'.repeat(1023), '中'.repeat(400)]) {
    body = value;
    const response = await request(url + '/api/route-map/district?district=south-cal', { 'Accept-Encoding': 'gzip' });
    const compressed = Buffer.byteLength(JSON.stringify(body)) > 1024;
    assert.equal(response.headers['content-encoding'], compressed ? 'gzip' : undefined);
    assert.equal((compressed ? gunzipSync(response.body) : response.body).toString(), JSON.stringify(body));
  }
});

test('MVR-T10 static text preserves CSP and security headers; HEAD remains unsupported', async t => {
  const body = Buffer.from('// mock script\n'.repeat(200));
  const url = await listen(t, http.createServer(createRequestHandler({
    getStaticFile: async () => ({ body, contentType: 'text/javascript; charset=utf-8' }),
  })));
  const plain = await request(url + '/map.js');
  const compressed = await request(url + '/map.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.equal(compressed.headers.vary, 'Accept-Encoding');
  assert.deepEqual(gunzipSync(compressed.body), body);
  assert.deepEqual(plain.body, body);
  for (const key of ['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy']) {
    assert.ok(plain.headers[key]); assert.equal(compressed.headers[key], plain.headers[key]);
  }
  const head = await request(url + '/map.js', { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.equal(head.status, 405); assert.equal(head.headers.allow, 'GET');
  assert.equal(head.headers['content-encoding'], undefined); assert.equal(head.body.length, 0);
});

test('MVR-T10 PMTiles full and Range responses bypass compression', async t => {
  const body = Buffer.alloc(4096, 42);
  let closed = 0;
  const url = await listen(t, http.createServer(createRequestHandler({ getBasemap: async () => ({
    size: body.length, stream: (start, end) => Readable.from([body.subarray(start, end + 1)]),
    close: async () => { closed++; },
  }) })));
  for (const range of [undefined, 'bytes=10-2059', 'bytes=9999-']) {
    const headers = { 'Accept-Encoding': 'gzip', ...(range ? { Range: range } : {}) };
    const response = await request(url + '/basemap/socal.pmtiles', headers);
    assert.equal(response.status, range === undefined ? 200 : range === 'bytes=9999-' ? 416 : 206);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers.vary, undefined);
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.headers['cache-control'], 'private, max-age=3600');
    assert.deepEqual(response.body, range === undefined ? body : range === 'bytes=9999-' ? Buffer.alloc(0) : body.subarray(10, 2060));
    if (response.status === 206) assert.equal(response.headers['content-range'], 'bytes 10-2059/4096');
  }
  assert.equal(closed, 3);
});

test('MVR-T10 shared sender preserves existing encoding, Vary and skips HEAD', async t => {
  const body = Buffer.alloc(2048, 42);
  const url = await listen(t, http.createServer((req, res) => {
    res.setHeader('Vary', 'Origin');
    if (req.url === '/encoded') res.setHeader('Content-Encoding', 'br');
    void sendBody(req, res, 200, body, { 'Content-Type': 'text/plain' });
  }));
  const encoded = await request(url + '/encoded', { 'Accept-Encoding': 'gzip' });
  assert.equal(encoded.headers['content-encoding'], 'br'); assert.deepEqual(encoded.body, body);
  const compressed = await request(url + '/', { 'Accept-Encoding': 'gzip' });
  assert.equal(compressed.headers.vary, 'Origin, Accept-Encoding');
  const head = await request(url + '/', { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.equal(head.headers['content-encoding'], undefined); assert.equal(head.body.length, 0);
});

test('MVR-T10 legacy sendJson and Worker API/static responses stay uncompressed', async t => {
  const url = await listen(t, http.createServer((req, res) => sendJson(res, 200, large)));
  const response = await request(url, { 'Accept-Encoding': 'gzip' });
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.body.toString(), JSON.stringify(large));
  const snapshot = { fetched_at: large.text, source_as_of: null, total: 0, rows: [] };
  const worker = createWorkerServer({ dataSource: { source: 'json', getStationSnapshot: async () => snapshot },
    runtimeDir: '.', repoRoot: '.' });
  const workerUrl = await listen(t, worker);
  for (const pathname of ['/api/route-profiles?station=MOCK', '/map.js']) {
    const result = await request(workerUrl + pathname, { 'Accept-Encoding': 'gzip' });
    assert.equal(result.status, 200); assert.ok(result.body.length > 1024);
    assert.equal(result.headers['content-encoding'], undefined); assert.equal(result.headers.vary, undefined);
    if (pathname.startsWith('/api/')) assert.deepEqual(JSON.parse(result.body), { station: 'MOCK', ...snapshot });
  }
});
