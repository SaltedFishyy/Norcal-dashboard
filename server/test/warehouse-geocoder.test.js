import test from 'node:test';
import assert from 'node:assert/strict';
import { createCensusGeocoder } from '../src/warehouses/geocoder.js';

const match = (x = -122, y = 38) => ({ coordinates: { x, y }, matchedAddress: 'MOCK ADDRESS' });
const response = matches => new Response(JSON.stringify({ result: { addressMatches: matches } }));
test('WH Census HTTPS parameters, no credentials and sanitized success', async () => {
  const geocoder = createCensusGeocoder({ fetch: async (url, options) => {
    assert.equal(url.origin, 'https://geocoding.geo.census.gov');
    assert.equal(url.pathname, '/geocoder/locations/onelineaddress');
    assert.equal(url.searchParams.get('address'), 'Mock & address');
    assert.equal(url.searchParams.get('benchmark'), 'Public_AR_Current'); assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    return response([match()]);
  } });
  assert.deepEqual(await geocoder.geocode('Mock & address'), { status: 'ok', latitude: 38, longitude: -122, matched_address: 'MOCK ADDRESS' });
});
test('WH Census no matches, same matches, ambiguous, bad data, timeout, network and 5xx', async () => {
  for (const [fetch, expected] of [
    [async () => response([]), 'failed'], [async () => response([match(), match()]), 'ok'],
    [async () => response([match(), match(-120)]), 'ambiguous'],
    [async () => response([match(200)]), 'unavailable'], [async () => new Response('{}'), 'unavailable'],
    [async () => new Response('not JSON'), 'unavailable'], [async () => new Response('', { status: 503 }), 'unavailable'],
    [async () => { throw new DOMException('Mock private', 'TimeoutError'); }, 'unavailable'],
    [async () => { throw new Error('Mock private'); }, 'unavailable'],
  ]) assert.equal((await createCensusGeocoder({ fetch }).geocode('Mock')).status, expected);
});
test('WH Census aborts oversized response even without content-length', async () => {
  let cancelled = false, signal;
  const geocoder = createCensusGeocoder({ fetch: async (_, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(262145)); }, cancel() { cancelled = true; } }));
  } });
  assert.deepEqual(await geocoder.geocode('Mock'), { status: 'unavailable' });
  assert.equal(cancelled, true); assert.equal(signal.aborted, true);
  assert.equal((await createCensusGeocoder({ fetch: async () => new Response('{}', { headers: { 'content-length': '262145' } }) }).geocode('Mock')).status, 'unavailable');
});
test('WH Census serial queue and one second between request starts', async () => {
  let time = 0, active = 0, max = 0; const starts = [], delays = [];
  const geocoder = createCensusGeocoder({ now: () => time, sleep: async ms => { delays.push(ms); time += ms; },
    fetch: async () => { active++; max = Math.max(max, active); starts.push(time); await Promise.resolve(); active--; return response([match()]); } });
  await Promise.all(['a', 'b', 'c'].map(a => geocoder.geocode(a)));
  assert.equal(max, 1); assert.deepEqual(starts, [0, 1000, 2000]); assert.deepEqual(delays, [1000, 1000]);
});
