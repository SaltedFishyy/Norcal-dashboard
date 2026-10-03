import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBasemap, BasemapNotFoundError, BasemapInvalidError } from '../src/store/basemap-file.js';
import { startApiServer } from '../src/api/server.js';
import { parseRange } from '../src/api/basemap.js';

const bytes = Buffer.concat([Buffer.from('PMTiles'), Buffer.from([3]), Buffer.from('synthetic-archive')]);
async function fixture(t) {
  const basemapDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-basemap-mock-'));
  t.after(() => fs.rm(basemapDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(basemapDir, 'us.pmtiles'), bytes);
  return basemapDir;
}

test('basemap store validates header and fixed whitelist with sanitized errors', async t => {
  const basemapDir = await fixture(t);
  const file = await readBasemap({ basemapDir, name: 'us' });
  assert.equal(file.size, bytes.length);
  const parts = []; for await (const part of file.stream(8, 11)) parts.push(part);
  assert.deepEqual(Buffer.concat(parts), bytes.subarray(8, 12)); await file.close();
  for (const name of ['../us', 'constructor', 'US', 'us.pmtiles', 'ops', 'norcal']) {
    await assert.rejects(readBasemap({ basemapDir, name }), BasemapNotFoundError);
  }
  for (const invalid of [Buffer.from('bad'), Buffer.from('PMTiles\x02'), Buffer.from('Invalid\x03')]) {
    await fs.writeFile(path.join(basemapDir, 'us.pmtiles'), invalid);
    await assert.rejects(readBasemap({ basemapDir, name: 'us' }), error => {
      assert.ok(error instanceof BasemapInvalidError); assert.ok(!error.message.includes(basemapDir)); return true;
    });
  }
});

test('basemap API streams full files, supports single ranges and preserves security headers', async t => {
  const basemapDir = await fixture(t);
  const server = await startApiServer({ port: 0, runtimeDir: basemapDir, basemapDir });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [range, start, end] of [[undefined, 0, bytes.length - 1], ['bytes=0-7', 0, 7],
    ['bytes=8-', 8, bytes.length - 1], ['bytes=-5', bytes.length - 5, bytes.length - 1],
    ['bytes=-999', 0, bytes.length - 1], ['bytes=8-999', 8, bytes.length - 1]]) {
    const response = await fetch(url + '/basemap/us.pmtiles', { headers: range ? { Range: range } : {} });
    assert.equal(response.status, range ? 206 : 200);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'");
    assert.equal(response.headers.get('content-range'), range ? `bytes ${start}-${end}/${bytes.length}` : null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  for (const range of ['bytes=999-', 'bytes=9-8', 'bytes=-0', 'bytes=0-1,3-4', 'items=1-2', 'bytes=-', 'bytes=9007199254740992-']) {
    const response = await fetch(url + '/basemap/us.pmtiles', { headers: { Range: range } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await fetch(url + '/basemap/us.pmtiles', { method });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
  }
  let response = await fetch(url + '/basemap/ops.pmtiles');
  assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'basemap_not_found' });
  await fs.writeFile(path.join(basemapDir, 'ops.pmtiles'), 'invalid');
  response = await fetch(url + '/basemap/ops.pmtiles');
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: 'basemap_invalid' });
  response = await fetch(url + '/basemap/unknown.pmtiles'); assert.equal(response.status, 404);
});

test('Range parsing rejects malformed and unsafe numbers', () => {
  assert.equal(parseRange('bytes=0-9007199254740992', 24), null);
  assert.equal(parseRange('bytes= 0-7', 24), null);
});
