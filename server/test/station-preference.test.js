import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSelection, readSelection, saveSelection, readMapScope, saveMapScope, SELECTION_STORAGE_KEY, MAP_SCOPE_STORAGE_KEY } from '../../web/station-preference.js';
const districts = [ { id: 'north-cal', stations: [{ code: 'SFO01', has_snapshot: true }, { code: 'OAR01', has_snapshot: false }, { code: 'SMF01', has_snapshot: true }] }, { id: 'south', stations: [{ code: 'LAX01', has_snapshot: true }] }, { id: 'empty', stations: [] } ];
test('DS selection priority, inference, invalid values and district changes', () => {
  const choose = args => chooseSelection({ districts, ...args });
  assert.deepEqual(choose({}), { district: 'north-cal', station: 'SFO01' });
  assert.deepEqual(choose({ urlStation: 'LAX01', saved: { district: 'north-cal', station: 'SMF01' } }), { district: 'south', station: 'LAX01' });
  assert.deepEqual(choose({ urlDistrict: 'south', urlStation: 'SMF01', saved: { district: 'north-cal', station: 'SFO01' } }), { district: 'south', station: 'LAX01' });
  assert.deepEqual(choose({ urlDistrict: 'absent', urlStation: 'OAR01', saved: { district: 'north-cal', station: 'SMF01' } }), { district: 'north-cal', station: 'SMF01' });
  assert.deepEqual(choose({ saved: { district: 'absent', station: 'absent' } }), { district: 'north-cal', station: 'SFO01' });
  assert.deepEqual(choose({ urlDistrict: 'empty' }), { district: 'empty', station: null });
});
test('DS read-only legacy migration, new JSON storage and independent map scope', () => {
  const values = new Map([['nc-ops-console.station', 'SMF01']]), writes = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); writes.push([key, value]); } };
  const selected = readSelection(storage, districts);
  assert.deepEqual(selected, { district: 'north-cal', station: 'SMF01' }); assert.equal(writes.length, 0);
  assert.equal(readMapScope(storage), 'station'); saveMapScope(storage, 'district');
  saveSelection(storage, selected); assert.deepEqual(readSelection(storage, districts), selected);
  assert.deepEqual(writes.map(row => row[0]), [MAP_SCOPE_STORAGE_KEY, SELECTION_STORAGE_KEY]);
  values.set('nc-ops-console.station', 'LAX01'); assert.deepEqual(readSelection(storage, districts), selected);
  values.set(SELECTION_STORAGE_KEY, '{'); assert.equal(readSelection(storage, districts).station, 'LAX01');
});
test('DS storage errors including global getter do not break selection', t => {
  const storage = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); } };
  assert.deepEqual(readSelection(storage, districts), {}); assert.equal(readMapScope(storage), 'station');
  assert.doesNotThrow(() => saveSelection(storage, { district: 'north-cal', station: 'SFO01' })); assert.doesNotThrow(() => saveMapScope(storage, 'district'));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('unavailable'); } });
  assert.deepEqual(readSelection(undefined, districts), {}); assert.doesNotThrow(() => saveSelection(undefined, {}));
});
