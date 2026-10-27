import test from 'node:test';
import assert from 'node:assert/strict';
import { sortRows } from '../../web/format.js';
for (const key of ['pickup_volume', 'pph']) for (const dir of ['asc', 'desc']) test('PS1 stable finite numeric sort ' + key + ' ' + dir, () => {
  const values = [null, 5, 0, undefined, '20', NaN, Infinity, 5, -2, false];
  const rows = values.map((value, id) => ({ id, [key]: value })), before = structuredClone(rows);
  const sorted = sortRows(rows, { key, dir });
  assert.deepEqual(sorted.map(r => r.id), dir === 'asc' ? [8, 2, 1, 7, 0, 3, 4, 5, 6, 9] : [1, 7, 2, 8, 0, 3, 4, 5, 6, 9]);
  assert.deepEqual(rows, before); assert.notEqual(sorted, rows);
  assert.deepEqual(sortRows(rows, { key: null, dir }), rows);
  assert.notEqual(sortRows(rows, { key: null, dir }), rows);
});
