import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startApiServer } from '../src/api/server.js';
import { createRequestHandler } from '../src/api/app.js';
import { buildRouteMap, lookupZip } from '../src/route-map/route-map.js';
import { profiles, boundaries } from './route-map-fixtures.js';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-map-'));
  const runtimeDir = path.join(root, 'mock-runtime'), geoDir = path.join(root, 'mock-geo');
  await fs.mkdir(runtimeDir); await fs.mkdir(geoDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profileFile = path.join(runtimeDir, 'route-profiles.json');
  const geoFile = path.join(geoDir, 'zcta2020_ca_nv_or.geojson');
  const metaFile = path.join(geoDir, 'zcta2020_ca_nv_or.meta.json');
  await fs.writeFile(profileFile, JSON.stringify(profiles()));
  const boundary = boundaries();
  await fs.writeFile(geoFile, JSON.stringify(boundary.geojson));
  await fs.writeFile(metaFile, JSON.stringify(boundary.meta));
  const logs = [];
  const server = await startApiServer({ port: 0, runtimeDir, geoDir, log: line => logs.push(line), ...options });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { root, profileFile, geoFile, metaFile, server, logs, url: `http://127.0.0.1:${server.address().port}` };
}

async function json(url, pathname, status, expected, options) {
  const response = await fetch(url + pathname, options);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal([...response.headers.keys()].some(key => key.startsWith('access-control-')), false);
  assert.deepEqual(await response.json(), expected);
  return response;
}

test('MS-T2b Station API follows configured order, then alphabetical extras, only available snapshots', async t => {
  const { url, profileFile } = await fixture(t);
  const { districts } = JSON.parse(await fs.readFile(new URL('../../config/districts.json', import.meta.url)));
  const defaultStationOrder = districts[0].stations;
  const snapshot = profiles().stations.MOCKA;
  const codes = [...defaultStationOrder].reverse();
  await fs.writeFile(profileFile, JSON.stringify({ schema_version: 1,
    stations: Object.fromEntries(['ZZZ01', ...codes, 'AAA01'].map(code => [code, snapshot])) }));
  await json(url, '/api/route-map/stations', 200, { stations: [...defaultStationOrder, 'AAA01', 'ZZZ01'] });
  await fs.writeFile(profileFile, JSON.stringify({ schema_version: 1,
    stations: { RDG02: snapshot, SMF01: snapshot, ZZZ01: snapshot, AAA01: snapshot } }));
  await json(url, '/api/route-map/stations', 200, { stations: ['SMF01', 'RDG02', 'AAA01', 'ZZZ01'] });
});

test('route-map API returns assembled data and sorted Station list, read-only', async t => {
  const { url, profileFile, geoFile, metaFile, logs } = await fixture(t);
  const files = [profileFile, geoFile, metaFile];
  const before = await Promise.all(files.map(filename => fs.readFile(filename)));
  await json(url, '/api/route-map?station=MOCKA', 200, buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() }));
  await json(url, '/api/route-map/stations', 200, { stations: ['MOCKA', 'MOCKB'] });
  assert.deepEqual(await Promise.all(files.map(filename => fs.readFile(filename))), before);
  assert.deepEqual(logs, ['HTTP 200', 'HTTP 200']);
});

test('ZIP API returns all statuses and cross-Station ownership with unchanged response headers', async t => {
  const { url, profileFile, metaFile } = await fixture(t);
  const data = profiles(); data.stations.MOCKA.rows[1].postal_codes = ['00002'];
  await fs.writeFile(profileFile, JSON.stringify(data));
  const boundary = boundaries(); boundary.meta.scope.postal_code_pattern = '^(0000[249]|00123|00024)$';
  await fs.writeFile(metaFile, JSON.stringify(boundary.meta));
  boundary.inScope = zip => /^(0000[249]|00123|00024)$/.test(zip);
  for (const postalCode of ['00002', '00004', '00123', '00024', '10001', '00009', '00005']) {
    await json(url, '/api/route-map/zip?postal_code=' + postalCode, 200,
      lookupZip({ profiles: data, boundaries: boundary, postalCode }));
  }
  for (const query of ['', '?postal_code=', '?postal_code=1234', '?postal_code=123456', '?postal_code=abcde',
    '?postal_code=00002&postal_code=00002', '?postal_code=%2000002', '?postal_code=１２３４５']) {
    await json(url, '/api/route-map/zip' + query, 400, { error: 'invalid_postal_code' });
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
    const response = await fetch(url + '/api/route-map/zip?postal_code=00002', { method });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else assert.deepEqual(await response.json(), { error: 'method_not_allowed' });
  }
});

test('ZIP API sanitizes the complete route-map error mapping', async t => {
  let errorName;
  const server = http.createServer(createRequestHandler({ getZip: async () => {
    throw Object.assign(new Error('private path and stack'), { name: errorName });
  } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [name, status, code] of [
    ['SnapshotNotFoundError', 404, 'snapshot_not_found'], ['StationNotFoundError', 404, 'station_not_found'],
    ['SnapshotInvalidError', 500, 'snapshot_invalid'], ['PostalCodesMissingError', 409, 'postal_codes_missing'],
    ['RouteZipConflictError', 500, 'route_zip_conflict'], ['BoundaryInvalidError', 500, 'boundary_invalid'],
    ['BoundaryNotFoundError', 500, 'boundary_not_found'], ['Error', 500, 'internal_error'],
  ]) { errorName = name; await json(url, '/api/route-map/zip?postal_code=00002', status, { error: code }); }
});

test('route-map API validates station and rejects non-GET methods with Allow header', async t => {
  const { url } = await fixture(t);
  for (const query of ['', '?station=', '?station=a/b', '?station=a%20b', '?station=a&station=b', '?station=' + 'a'.repeat(33)]) {
    await json(url, '/api/route-map' + query, 400, { error: 'invalid_station' });
  }
  for (const route of ['/api/route-map', '/api/route-map/stations']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await json(url, route, 405, { error: 'method_not_allowed' }, { method });
      assert.equal(response.headers.get('allow'), 'GET');
    }
    const head = await fetch(url + route, { method: 'HEAD' });
    assert.equal(head.status, 405); assert.equal(head.headers.get('allow'), 'GET'); assert.equal(await head.text(), '');
  }
});

test('route-map API maps snapshot, postal-code, conflict and boundary failures to stable sanitized codes', async t => {
  const { url, profileFile, geoFile, metaFile } = await fixture(t);
  await json(url, '/api/route-map?station=constructor', 404, { error: 'station_not_found' });
  await fs.unlink(profileFile);
  for (const route of ['/api/route-map?station=MOCKA', '/api/route-map/stations']) {
    await json(url, route, 404, { error: 'snapshot_not_found' });
  }
  await fs.writeFile(profileFile, '{');
  for (const route of ['/api/route-map?station=MOCKA', '/api/route-map/stations']) {
    await json(url, route, 500, { error: 'snapshot_invalid' });
  }
  const data = profiles(); delete data.stations.MOCKA.rows[0].postal_codes;
  await fs.writeFile(profileFile, JSON.stringify(data));
  await json(url, '/api/route-map?station=MOCKA', 409, { error: 'postal_codes_missing' });
  for (const station of ['MOCKA']) {
    const conflict = profiles(); conflict.stations[station].rows[0].postal_codes = ['00002'];
    await fs.writeFile(profileFile, JSON.stringify(conflict));
    await json(url, '/api/route-map?station=MOCKA', 500, { error: 'route_zip_conflict' });
  }
  const invalid = profiles(); invalid.stations.MOCKA.rows[0].postal_codes = [12345];
  await fs.writeFile(profileFile, JSON.stringify(invalid));
  await json(url, '/api/route-map?station=MOCKA', 500, { error: 'snapshot_invalid' });
  await fs.writeFile(profileFile, JSON.stringify(profiles()));
  // Successful boundary reads are cached; test initial read failures in fresh directories.
  const invalidBoundary = await fixture(t);
  await fs.writeFile(invalidBoundary.metaFile, '{');
  await json(invalidBoundary.url, '/api/route-map?station=MOCKA', 500, { error: 'boundary_invalid' });
  await fs.writeFile(invalidBoundary.metaFile, JSON.stringify(boundaries().meta));
  await fs.unlink(invalidBoundary.geoFile);
  await json(invalidBoundary.url, '/api/route-map?station=MOCKA', 500, { error: 'boundary_invalid' });
  await fs.unlink(invalidBoundary.metaFile);
  await json(invalidBoundary.url, '/api/route-map?station=MOCKA', 500, { error: 'boundary_not_found' });
});

test('route-map API unexpected exceptions are hidden and logs contain only status', async t => {
  const logs = [];
  const fail = async () => { throw new Error('C:/private/path stack secret'); };
  const server = http.createServer(createRequestHandler({ getRouteMap: fail, getMapStations: fail, log: line => logs.push(line) }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  await json(url, '/api/route-map?station=MOCKA&secret=private', 500, { error: 'internal_error' });
  await json(url, '/api/route-map/stations', 500, { error: 'internal_error' });
  assert.deepEqual(logs, ['HTTP 500', 'HTTP 500']);
});

const assets = [
  ...['map-view', 'map-panel', 'map-state', 'map-text'].map(name => [ '/' + name + '.js', name + '.js', 'text/javascript', 'web']),
  ['/vendor/protomaps-leaflet/protomaps-leaflet.js', 'protomaps-leaflet.js', 'text/javascript', 'protomaps'],
  ['/map', 'map.html', 'text/html', 'web'], ['/map.js', 'map.js', 'text/javascript', 'web'],
  ['/route-colors.js', 'route-colors.js', 'text/javascript', 'web'],
  ['/vendor/leaflet/leaflet.js', 'leaflet.js', 'text/javascript', 'leaflet'],
  ['/vendor/leaflet/leaflet.css', 'leaflet.css', 'text/css', 'leaflet'],
];
test('existing API endpoints retain their own error mappings after handler refactoring', async t => {
  const server = http.createServer(createRequestHandler({
    getSnapshot: async () => { throw Object.assign(new Error(), { name: 'RouteDetailNotFoundError' }); },
    getRouteDetail: async () => { throw Object.assign(new Error(), { name: 'SnapshotNotFoundError' }); },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  await json(url, '/api/route-profiles?station=MOCKA', 500, { error: 'internal_error' });
  await json(url, '/api/route-details?route_id=1', 500, { error: 'internal_error' });
});

test('map and local Leaflet assets use fixed whitelist and unchanged CSP', async t => {
  const { url } = await fixture(t);
  const dirs = { web: fileURLToPath(new URL('../../web/', import.meta.url)),
    protomaps: fileURLToPath(new URL('../../node_modules/protomaps-leaflet/dist/', import.meta.url)),
    leaflet: fileURLToPath(new URL('../../node_modules/leaflet/dist/', import.meta.url)) };
  for (const [route, filename, type, source] of assets) {
    const response = await fetch(url + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), `${type}; charset=utf-8`);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'");
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(await response.text(), await fs.readFile(path.join(dirs[source], filename), 'utf8'));
    const post = await json(url, route, 405, { error: 'method_not_allowed' }, { method: 'POST' });
    assert.equal(post.headers.get('allow'), 'GET');
  }
  for (const route of ['/vendor/leaflet/leaflet-src.esm.js', '/geo/zcta2020_ca_nv_or.geojson', '/map.html', '/node_modules/leaflet/dist/leaflet.css',
    '/vendor/leaflet/images/marker-icon.png', '/vendor/leaflet/package.json', '/map.js/']) {
    await json(url, route, 404, { error: 'not_found' });
  }
});

test('Leaflet source directory can be injected independently of web root', async t => {
  const alternate = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-map-assets-'));
  t.after(() => fs.rm(alternate, { recursive: true, force: true }));
  await fs.writeFile(path.join(alternate, 'leaflet.css'), '/* mock local Leaflet */');
  const { url } = await fixture(t, { leafletDir: alternate });
  assert.equal(await (await fetch(url + '/vendor/leaflet/leaflet.css')).text(), '/* mock local Leaflet */');
  await json(url, '/vendor/leaflet/leaflet.js', 500, { error: 'internal_error' });
});


test('RM5 map and ZIP APIs tolerate missing, malformed and structurally invalid details, preserving originals', async t => {
  const { url, root } = await fixture(t);
  const { details } = await import('./route-map-fixtures.js');
  const filename = path.join(root, 'mock-runtime', 'route-details.json');
  const cache = details(); Object.assign(cache.routes['1'].zips[0], { experienced_pph: 21.5, pickup_volume_daily: 0 });
  const original = buildRouteMap({ profiles: profiles(), station: 'MOCKA', boundaries: boundaries() });
  for (const [contents, status] of [[null, 'none'], ['{', 'invalid'], ['{}', 'invalid'],
    [JSON.stringify({ schema_version: 1, routes: cache.routes }), 'ok']]) {
    if (contents !== null) await fs.writeFile(filename, contents);
    const response = await fetch(url + '/api/route-map?station=MOCKA');
    assert.equal(response.status, 200);
    const data = await response.json(); assert.equal(data.details_status, status);
    for (const key of ['station', 'fetched_at', 'boundary_source', 'coverage', 'missing']) assert.deepEqual(data[key], original[key]);
    for (const [index, route] of data.routes.entries()) {
      for (const key of ['route_id', 'route_name', 'station', 'dsp_name', 'pickup_volume', 'pph', 'zip_count', 'mapped_count']) assert.equal(route[key], original.routes[index][key]);
    }
    assert.deepEqual(data.features.features.map(f => f.geometry), original.features.features.map(f => f.geometry));
    const zipResponse = await fetch(url + '/api/route-map/zip?postal_code=00002');
    assert.equal(zipResponse.status, 200);
    const zip = await zipResponse.json();
    assert.equal(zip.zip_detail_status, status === 'ok' ? 'available' : 'missing');
    assert.equal(zip.zip_difficulty, status === 'ok' ? 'A级 难' : null);
    assert.equal(zip.route_difficulty, null);
    for (const value of [zip, data.features.features[0].properties]) {
      assert.equal(value.dsp_name, null); assert.equal(value.experienced_pph, status === 'ok' ? 21.5 : null);
      assert.equal(value.pickup_volume_daily, status === 'ok' ? 0 : null);
    }
    const absent = await (await fetch(url + '/api/route-map/zip?postal_code=00123')).json();
    assert.equal(absent.experienced_pph, null); assert.equal(absent.pickup_volume_daily, null);
    if (contents !== null) assert.equal(await fs.readFile(filename, 'utf8'), contents);
  }
});

test('MS-T2 API permits cross-Station ownership while preserving existing fields', async t => {
  const { url, profileFile } = await fixture(t); const data = profiles();
  const original = buildRouteMap({ profiles: data, station: 'MOCKA', boundaries: boundaries() });
  data.stations.MOCKB.rows[0].postal_codes.push('00002'); await fs.writeFile(profileFile, JSON.stringify(data));
  const response = await fetch(url + '/api/route-map?station=MOCKA'); assert.equal(response.status, 200);
  const actual = await response.json();
  for (const key of Object.keys(original).filter(key => key !== 'cross_station_conflicts')) assert.deepEqual(actual[key], original[key]);
  assert.deepEqual(actual.cross_station_conflicts, [{ postal_code: '00002', stations: ['MOCKA', 'MOCKB'] }]);
  await json(url, '/api/route-map/zip?postal_code=00002', 200, lookupZip({ profiles: data, boundaries: boundaries(), postalCode: '00002' }));
});

test('DS district APIs use injected config, ordered snapshots, scope and sanitized errors', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-district-api-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const districtsPath = path.join(dir, 'districts.json');
  const config = { schema_version: 1, districts: [{ id: 'north', name_zh: '测试片区', name_en: 'Mock District', stations: ['SMF01', 'SFO01', 'OAR01'] }, { id: 'empty', name_zh: '空片区', name_en: 'Empty District', stations: [] }] };
  await fs.writeFile(districtsPath, JSON.stringify(config));
  const { url, profileFile } = await fixture(t, { districtsPath });
  const source = profiles();
  source.stations = Object.fromEntries([['SFO01', source.stations.MOCKA], ['SMF01', source.stations.MOCKB]]);
  for (const [station, snapshot] of Object.entries(source.stations)) snapshot.rows.forEach(row => row.station = station);
  await fs.writeFile(profileFile, JSON.stringify(source));
  const data = await (await fetch(url + '/api/districts')).json();
  assert.deepEqual(data.districts[0].stations, [{ code: 'SMF01', has_snapshot: true }, { code: 'SFO01', has_snapshot: true }, { code: 'OAR01', has_snapshot: false }]);
  await json(url, '/api/route-map/stations', 200, { stations: ['SMF01', 'SFO01'] });
  const { buildDistrictMap } = await import('../src/route-map/route-map.js');
  await json(url, '/api/route-map/district?district=north', 200, buildDistrictMap({ profiles: source, boundaries: boundaries(), districts: data.districts, district: 'north', details: { status: 'none' } }));
  const empty = await (await fetch(url + '/api/route-map/district?district=empty')).json(); assert.equal(empty.coverage.total, 0);
  await json(url, '/api/route-map/district?district=absent', 404, { error: 'district_not_found' });
  for (const query of ['', '?district=UPPER', '?district=north&district=empty']) await json(url, '/api/route-map/district' + query, 400, { error: 'invalid_district' });
  await json(url, '/api/districts', 405, { error: 'method_not_allowed' }, { method: 'POST' });
  await fs.writeFile(districtsPath, '{');
  await json(url, '/api/districts', 500, { error: 'district_config_invalid' });
  await json(url, '/api/route-map/district?district=north', 500, { error: 'district_config_invalid' });
  await json(url, '/api/route-map/stations', 500, { error: 'district_config_invalid' });
  // Existing station endpoint keeps its exact fields even with invalid district configuration.
  await json(url, '/api/route-map?station=SFO01', 200, buildRouteMap({ profiles: source, station: 'SFO01', boundaries: boundaries() }));
});

test('DS APIs return configured unavailable stations and empty district without a snapshot file', async t => {
  const { url, profileFile } = await fixture(t); await fs.unlink(profileFile);
  const response = await fetch(url + '/api/districts'); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.districts[0].stations.length, 10);
  assert.ok(data.districts[0].stations.every(station => !station.has_snapshot));
  const mapResponse = await fetch(url + '/api/route-map/district?district=north-cal'); assert.equal(mapResponse.status, 200);
  const map = await mapResponse.json(); assert.deepEqual(map.routes, []); assert.equal(map.coverage.total, 0);
  await json(url, '/api/route-profiles?station=SFO01', 404, { error: 'snapshot_not_found' });
});
