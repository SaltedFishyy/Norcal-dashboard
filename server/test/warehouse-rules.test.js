import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWarehouse, validateAssignment, addressKey, distanceToExtentKm, projectWarehouse,
  FAR_FROM_DISTRICT_KM } from '../src/warehouses/warehouse-rules.js';

const body = { warehouse_name: ' Mock ', address: ' 1 Mock Street ', district_id: 'mock' };
const config = { districts: [{ id: 'mock', name_zh: '模拟', name_en: 'Mock', stations: ['AAA01'], scrape_disabled: { AAA01: 'disabled' } }] };
test('WH rules trim, required fields, lengths, unknown fields, optional station and PATCH version', () => {
  for (const station_id of [null, undefined, '']) {
    const result = validateWarehouse({ ...body, station_id });
    assert.equal(result.values.warehouse_name, 'Mock'); assert.equal(result.values.address, '1 Mock Street');
    assert.equal(result.values.station_id, null);
  }
  for (const [key, value] of [['warehouse_name', ' '], ['warehouse_name', 'a'.repeat(121)], ['address', 'a'.repeat(301)],
    ['address', 4], ['district_id', 'Bad'], ['station_id', 'BAD'], ['manual_coordinates', null],
    ['manual_coordinates', { latitude: 91, longitude: 0 }], ['manual_coordinates', { latitude: 0, longitude: Infinity }],
    ['manual_coordinates', { latitude: '1', longitude: 0 }], ['manual_coordinates', { latitude: 0, longitude: 0, extra: 1 }],
    ['confirm', 'duplicate_address'], ['confirm', ['invalid']]]) {
    assert.deepEqual(validateWarehouse({ ...body, [key]: value }).fields, [key]);
  }
  assert.equal(validateWarehouse({ ...body, extra: 1 }).error, 'invalid_body');
  assert.equal(validateWarehouse({ ...body, expected_updated_at: '2026-01-01T00:00:00Z' }).error, 'invalid_body');
  assert.deepEqual(validateWarehouse(body, { patch: true }).fields, ['expected_updated_at']);
  assert.ok(validateWarehouse({ ...body, expected_updated_at: '2026-01-01T00:00:00.123456Z' }, { patch: true }).values);
  assert.ok(validateWarehouse({ ...body, manual_coordinates: { latitude: -90, longitude: 180 }, confirm: ['duplicate_address', 'far_from_district'] }).values);
});
test('WH assignment uses config including disabled stations; projection uses whitelist', () => {
  assert.equal(validateAssignment({ district_id: 'missing', station_id: null }, config), 'district_not_found');
  assert.equal(validateAssignment({ district_id: 'mock', station_id: 'BBB01' }, config), 'station_not_in_district');
  assert.equal(validateAssignment({ district_id: 'mock', station_id: 'AAA01' }, config), null);
  const row = { ...body, station_id: null, address_key: 'private', raw: 'private' };
  assert.equal(projectWarehouse(row, config).station_known, true);
  assert.equal(projectWarehouse({ ...row, station_id: 'BBB01' }, config).station_known, false);
  const projected = projectWarehouse({ ...row, district_id: 'deleted', station_id: 'AAA01' }, config);
  assert.equal(projected.district_known, false); assert.equal(projected.district_name_en, null);
  assert.equal(projected.district_name_zh, null); assert.equal(projected.station_known, false);
  assert.equal(Object.hasOwn(projected, 'address_key'), false); assert.equal(Object.hasOwn(projected, 'raw'), false);
});
test('WH address normalization follows NFKC, punctuation, whitespace and whole word abbreviations', () => {
  assert.equal(addressKey(' １２３ North Street., # Suite ４ '), '123 n st ste 4');
  assert.equal(addressKey('Avenue Road Drive Boulevard Highway Lane Court Parkway South East West'), 'ave rd dr blvd hwy ln ct pkwy s e w');
  assert.equal(addressKey('Northwood STREET\tStreet'), 'northwood st st');
});
test('WH distance to district bbox inside, boundary and outside', () => {
  const extent = [[0, 0], [1, 1]];
  assert.equal(distanceToExtentKm({ latitude: 0.5, longitude: 0.5 }, extent), 0);
  assert.equal(distanceToExtentKm({ latitude: 1, longitude: 1 }, extent), 0);
  assert.ok(distanceToExtentKm({ latitude: 2, longitude: 1 }, extent) > 111);
  assert.equal(FAR_FROM_DISTRICT_KM, 50);
});
