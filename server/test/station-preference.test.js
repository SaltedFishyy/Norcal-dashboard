import test from 'node:test';
import assert from 'node:assert/strict';
import { STATION_STORAGE_KEY, chooseStation, readSavedStation, saveStation } from '../../web/station-preference.js';

test('Station preference priority skips unavailable codes and handles empty lists', () => {
  const stations = ['SMF01', 'SFO01', 'RNO01'];
  assert.equal(chooseStation({ urlStation: 'RNO01', savedStation: 'SMF01', stations }), 'RNO01');
  assert.equal(chooseStation({ urlStation: 'ABSENT', savedStation: 'SMF01', stations }), 'SMF01');
  assert.equal(chooseStation({ savedStation: 'ABSENT', stations }), 'SFO01');
  assert.equal(chooseStation({ stations: ['SMF01', 'RNO01'] }), 'SMF01');
  assert.equal(chooseStation({ stations: [] }), undefined);
});

test('Station storage uses the shared key and tolerates read and write errors', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(readSavedStation(storage), null);
  saveStation(storage, 'SMF01');
  assert.deepEqual([...values], [[STATION_STORAGE_KEY, 'SMF01']]);
  assert.equal(readSavedStation(storage), 'SMF01');
  const unavailable = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); } };
  assert.equal(readSavedStation(unavailable), null);
  assert.doesNotThrow(() => saveStation(unavailable, 'SFO01'));
  assert.equal(chooseStation({ savedStation: readSavedStation(unavailable), stations: ['SMF01', 'SFO01'] }), 'SFO01');
});

test('Station storage catches a throwing global localStorage getter', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('unavailable'); } });
  assert.equal(readSavedStation(), null);
  assert.doesNotThrow(() => saveStation(undefined, 'SFO01'));
});
