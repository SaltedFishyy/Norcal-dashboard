import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteMap, lookupZip, PostalCodesMissingError, RouteZipConflictError } from '../src/route-map/route-map.js';
import { StationNotFoundError, SnapshotInvalidError } from '../src/store/route-profiles-file.js';
import { profiles, boundaries } from './route-map-fixtures.js';

const build = data => buildRouteMap({ profiles: data, station: 'MOCKA', boundaries: boundaries() });

test('route summary metrics are copied directly from source rows, including nulls and zeros', () => {
  const data = profiles();
  Object.assign(data.stations.MOCKA.rows[0], { station: 'MOCKA', dsp_name: 'Mock DSP', pickup_volume: 12345, pph: 12.345 });
  Object.assign(data.stations.MOCKA.rows[1], { station: 'MOCKA', dsp_name: null, pickup_volume: 0, pph: null });
  for (const row of data.stations.MOCKA.rows) {
    const result = build(data).routes.find(route => route.route_id === row.route_id);
    for (const field of ['station', 'dsp_name', 'pickup_volume', 'pph']) assert.equal(result[field], row[field]);
  }
});

test('ZIP lookup distinguishes all five statuses, searches across Stations and returns the same route summary', () => {
  const data = profiles(), boundary = boundaries();
  const expected = [['00002', 'covered'], ['00004', 'covered_no_boundary'], ['00123', 'uncovered'],
    ['00024', 'no_boundary'], ['10001', 'out_of_range']];
  data.stations.MOCKA.rows[1].postal_codes = ['00002'];
  // Include a scope ZIP without geometry; out-of-scope route ownership still takes priority.
  boundary.inScope = zip => ['00002', '00004', '00009', '00123', '00024'].includes(zip);
  for (const [postalCode, status] of expected) {
    const result = lookupZip({ profiles: data, boundaries: boundary, postalCode });
    assert.equal(result.postal_code, postalCode); assert.equal(result.status, status);
    assert.equal(!!result.geometry, ['covered', 'uncovered'].includes(status));
    if (status.startsWith('covered')) {
      assert.equal(result.station, 'MOCKA');
      assert.deepEqual(result.route, buildRouteMap({ profiles: data, station: 'MOCKA', boundaries: boundary })
        .routes.find(route => route.route_id === result.route_id));
      assert.equal(result.fetched_at, data.stations.MOCKA.fetched_at);
    } else for (const key of ['station', 'route_id', 'route_name', 'route', 'fetched_at']) assert.equal(result[key], null);
  }
  assert.equal(lookupZip({ profiles: data, boundaries: boundary, postalCode: '00009' }).station, 'MOCKB');
  assert.equal(lookupZip({ profiles: data, boundaries: boundary, postalCode: '00005' }).status, 'covered_no_boundary');
});

test('ZIP lookup validates every Station and rejects ownership conflicts even for an unrelated query', () => {
  for (const station of ['MOCKA']) {
    const data = profiles(); data.stations[station].rows[0].postal_codes = ['00002'];
    assert.throws(() => lookupZip({ profiles: data, boundaries: boundaries(), postalCode: '10001' }), RouteZipConflictError);
  }
  const data = profiles(); delete data.stations.MOCKB.rows[0].postal_codes;
  assert.throws(() => lookupZip({ profiles: data, boundaries: boundaries(), postalCode: '00002' }), PostalCodesMissingError);
  data.stations.MOCKB.rows[0].postal_codes = [9];
  assert.throws(() => lookupZip({ profiles: data, boundaries: boundaries(), postalCode: '00002' }), SnapshotInvalidError);
});

test('route map joins, classifies missing ZIPs, sorts and preserves inputs with source metrics and without colors', () => {
  const data = profiles(), before = structuredClone(data), boundary = boundaries(), boundaryBefore = structuredClone({ geojson: boundary.geojson, meta: boundary.meta });
  const result = buildRouteMap({ profiles: data, station: 'MOCKA', boundaries: boundary });
  assert.deepEqual(data, before); assert.deepEqual({ geojson: boundary.geojson, meta: boundary.meta }, boundaryBefore);
  assert.equal(result.station, 'MOCKA'); assert.equal(result.fetched_at, data.stations.MOCKA.fetched_at);
  assert.deepEqual(result.boundary_source, { dataset: 'mock-census', vintage: 2020 });
  assert.deepEqual(result.coverage, { total: 4, mapped: 2, missing: 2, missing_no_zcta: 1, missing_not_checked: 1 });
  assert.equal(result.coverage.mapped + result.coverage.missing, result.coverage.total);
  assert.deepEqual(result.routes, [
    { route_id: 1, route_name: 'Mock-A', zip_count: 2, mapped_count: 2, station: 'MOCKA', dsp_name: null, pickup_volume: null, pph: null, route_difficulty: null, zip_detail: { status: 'missing', fetched_at: null, zip_count: null } },
    { route_id: 2, route_name: 'Mock-B', zip_count: 2, mapped_count: 0, station: 'MOCKA', dsp_name: null, pickup_volume: null, pph: null, route_difficulty: null, zip_detail: { status: 'missing', fetched_at: null, zip_count: null } },
  ]);
  assert.deepEqual(result.missing, [
    { postal_code: '00004', route_id: 2, route_name: 'Mock-B', reason: 'no_zcta' },
    { postal_code: '00005', route_id: 2, route_name: 'Mock-B', reason: 'not_checked' },
  ]);
  assert.equal(result.features.type, 'FeatureCollection');
  assert.deepEqual(result.features.features.map(f => f.properties), ['00002', '00123'].map(postal_code =>
    ({ postal_code, route_id: 1, route_name: 'Mock-A', station: 'MOCKA', dsp_name: null, experienced_pph: null, pickup_volume_daily: null, route_difficulty: null, zip_difficulty: null, zip_detail_status: 'missing' })));
  assert.deepEqual(result.features.features[0].geometry, boundary.geojson.features[1].geometry);
  assert.doesNotMatch(JSON.stringify(result), /color|raw|source_url/);
});

test('route map handles empty Routes and Station and absent Station', () => {
  const data = profiles(); data.stations.MOCKA.rows.forEach(row => row.postal_codes = []);
  assert.equal(build(data).coverage.total, 0);
  data.stations.MOCKA.rows = []; assert.deepEqual(build(data).routes, []);
  delete data.stations.MOCKA; assert.throws(() => build(data), StationNotFoundError);
  assert.throws(() => buildRouteMap({ profiles: data, station: 'constructor', boundaries: boundaries() }), StationNotFoundError);
});

test('route map requires postal_codes and validates format in all Station snapshots', () => {
  for (const station of ['MOCKA', 'MOCKB']) {
    const data = profiles(); delete data.stations[station].rows[0].postal_codes;
    assert.throws(() => build(data), PostalCodesMissingError);
  }
  for (const codes of ['00002', [2], ['abcde'], ['00002', '00002']]) {
    const data = profiles(); data.stations.MOCKA.rows[0].postal_codes = codes;
    assert.throws(() => build(data), SnapshotInvalidError);
  }
  const data = profiles(); data.stations.MOCKA.rows[0].route_name = 2;
  assert.throws(() => build(data), SnapshotInvalidError);
});

test('route map rejects intra-Station conflicts with ownership details', () => {
  for (const station of ['MOCKA']) {
    const data = profiles(); data.stations[station].rows[0].postal_codes = ['00002'];
    assert.throws(() => build(data), error => {
      assert.ok(error instanceof RouteZipConflictError);
      assert.equal(error.conflicts[0].postal_code, '00002');
      assert.equal(error.conflicts[0].routes.length, 2);
      assert.ok(error.conflicts[0].routes.some(row => row.route_name === 'Mock-A'));
      return true;
    });
  }
});


test('RM5 detail join is exact by route, Station and ZIP, without inference or input mutation', async () => {
  const { details } = await import('./route-map-fixtures.js');
  const cache = details(), data = profiles();
  data.stations.MOCKA.rows.find(row => row.route_id === 1).route_difficulty = 'B级 中';
  const before = structuredClone({ cache, data });
  const buildWith = details => buildRouteMap({ profiles: data, station: 'MOCKA', boundaries: boundaries(), details });
  const result = buildWith(cache);
  const route = result.routes[0];
  assert.equal(result.details_status, 'ok');
  assert.equal(route.route_difficulty, 'B级 中');
  assert.deepEqual(route.zip_detail, { status: 'available', fetched_at: cache.routes['1'].fetched_at, zip_count: 1 });
  assert.deepEqual(result.features.features.map(f => f.properties.zip_detail_status), ['available', 'not_in_detail']);
  assert.deepEqual(result.features.features.map(f => f.properties.zip_difficulty), ['A级 难', null]);
  assert.ok(result.features.features.every(f => f.properties.route_difficulty === 'B级 中'));
  assert.equal(result.routes[1].zip_detail.status, 'missing');
  const lookup = lookupZip({ profiles: data, boundaries: boundaries(), postalCode: '00002', details: cache });
  for (const key of ['route_difficulty', 'zip_difficulty', 'zip_detail_status']) assert.equal(lookup[key], result.features.features[0].properties[key]);
  assert.deepEqual(lookup.route, route);
  assert.deepEqual({ cache, data }, before);
  assert.doesNotMatch(JSON.stringify(result), /raw|private|difficulty_code/);
  cache.routes['1'].zips[0].postal_code_difficulty = null;
  assert.equal(buildWith(cache).features.features[0].properties.zip_detail_status, 'available');
  assert.equal(buildWith(cache).features.features[0].properties.zip_difficulty, null);
  for (const mismatch of ['station', 'route_id', 'postal_code']) {
    const other = details();
    if (mismatch === 'postal_code') other.routes['1'].zips[0].postal_code = ' 00002';
    else other.routes['1'][mismatch] = mismatch === 'station' ? 'MOCKB' : 2;
    assert.equal(buildWith(other).features.features[0].properties.zip_detail_status, mismatch === 'postal_code' ? 'not_in_detail' : 'missing');
  }
  for (const cache of [undefined, { status: 'none', routes: {} }, { status: 'invalid', routes: {} }]) {
    const fallback = buildWith(cache);
    assert.equal(fallback.details_status, cache?.status ?? 'none');
    assert.ok(fallback.features.features.every(f => f.properties.zip_difficulty === null && f.properties.zip_detail_status === 'missing'));
  }
});

 test('MS-T2 cross-Station warnings are local and lookup never chooses an owner', () => {
  const data = profiles(), boundary = boundaries();
  data.stations.MOCKB.rows[0].postal_codes.push('00002');
  data.stations.MOCKC = structuredClone(data.stations.MOCKB);
  data.stations.MOCKC.rows[0].postal_codes = ['00009'];
  data.stations.MOCKC.rows[0].station = 'MOCKC';
  const result = build(data);
  assert.deepEqual(result.cross_station_conflicts, [{ postal_code: '00002', stations: ['MOCKA', 'MOCKB'] }]);
  const lookup = lookupZip({ profiles: data, boundaries: boundary, postalCode: '00002' });
  assert.equal(lookup.status, 'multi_station'); assert.equal(lookup.station, null); assert.equal(lookup.route, null);
  assert.deepEqual(lookup.owners, [{ station: 'MOCKA', route_id: 1, route_name: 'Mock-A' }, { station: 'MOCKB', route_id: 3, route_name: 'Mock-C' }]);
  assert.deepEqual(lookup.geometry, boundary.byZip.get('00002'));
  data.stations.MOCKB.rows.push({ ...data.stations.MOCKB.rows[0], route_id: 4 });
  assert.doesNotThrow(() => build(data));
  assert.throws(() => buildRouteMap({ profiles: data, station: 'MOCKB', boundaries: boundary }), RouteZipConflictError);
});

test('RM6 projects profile DSP and exact ZIP metrics, preserving zeros and null fallbacks', async () => {
  const { details } = await import('./route-map-fixtures.js');
  const source = profiles(), cache = details(), boundary = boundaries();
  source.stations.MOCKA.rows[1].dsp_name = 'Mock DSP';
  Object.assign(cache.routes['1'].zips[0], { experienced_pph: 0, pickup_volume_daily: 125.5 });
  for (const detail of [cache, undefined, { status: 'none' }, { status: 'invalid' }]) {
    const args = { profiles: source, boundaries: boundary, details: detail };
    const map = buildRouteMap({ ...args, station: 'MOCKA' });
    for (const feature of map.features.features) {
      const p = feature.properties, found = detail === cache && p.postal_code === '00002';
      assert.equal(p.dsp_name, 'Mock DSP'); assert.equal(p.experienced_pph, found ? 0 : null);
      assert.equal(p.pickup_volume_daily, found ? 125.5 : null);
      const lookup = lookupZip({ ...args, postalCode: p.postal_code });
      for (const key of Object.keys(p)) assert.equal(lookup[key], p[key]);
    }
  }
  for (const key of ['station', 'route_id']) {
    const other = structuredClone(cache); other.routes['1'][key] = key === 'station' ? 'MOCKB' : 2;
    const result = lookupZip({ profiles: source, boundaries: boundary, details: other, postalCode: '00002' });
    assert.equal(result.experienced_pph, null); assert.equal(result.pickup_volume_daily, null);
  }
});
