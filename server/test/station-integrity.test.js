import test from 'node:test';
import assert from 'node:assert/strict';
import { completeRouteDetail, checkStationIntegrity } from '../src/batch/station-integrity.js';
const profile = { station: 'SFO01', route_id: 1, route_name: 'MOCK-1', postal_codes: ['00123'] };
const detail = { ...profile, zips: [{ postal_code: '00123', pickup_volume_daily: null }] };
const check = changes => checkStationIntegrity({ station: 'SFO01', snapshot: { total: 1, rows: [profile] },
  details: { 1: detail }, successCount: 0, skippedCount: 1, failedCount: 0, ...changes });
test('MS completeness checks station, name, ZIP sets and original pickup key', () => {
  assert.equal(completeRouteDetail(detail, profile), true);
  for (const value of [{ ...detail, station: 'MFR01' }, { ...detail, route_name: 'old' },
    { ...detail, zips: [{ postal_code: '00123' }] }, { ...detail, zips: [{ postal_code: '00124', pickup_volume_daily: 2 }] }]) assert.equal(completeRouteDetail(value, profile), false);
});
test('MS integrity failures, limited subsets and mismatch/overlap/boundary warnings', () => {
  assert.equal(check().passed, true); assert.equal(check({ failedCount: 1 }).passed, false);
  assert.equal(check({ details: {} }).passed, false);
  const mismatch = { ...detail, zips: [{ postal_code: '00124', pickup_volume_daily: 2 }] };
  const result = check({ details: { 1: mismatch }, freshlyFetchedIds: new Set([1]),
    snapshots: { MFR01: { rows: [{ postal_codes: ['00123'] }] } }, boundaries: new Set() });
  assert.equal(result.passed, true);
  assert.deepEqual(result.warnings.map(value => value.type), ['zip_set_mismatch', 'cross_station_overlap', 'boundary_coverage']);
  assert.equal(check({ limited: true, processedIds: new Set(), skippedCount: 0, details: {} }).passed, true);
});
