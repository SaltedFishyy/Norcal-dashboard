import test from 'node:test';
import assert from 'node:assert/strict';
import { sortRows } from '../../web/format.js';
test('PL difficulty sort is stable, recognizes canonical levels and keeps unknowns last', () => {
  const values = ['B级 中', null, 'S级 极难', 'A级 难', 'B级 中', 'D级 极易', 'C级 易', '', 'unknown', undefined];
  const rows = values.map((route_difficulty, id) => Object.freeze({ id, route_difficulty }));
  assert.deepEqual(sortRows(rows, { key: 'route_difficulty', dir: 'desc' }).map(r => r.id), [2, 3, 0, 4, 6, 5, 1, 7, 8, 9]);
  assert.deepEqual(sortRows(rows, { key: 'route_difficulty', dir: 'asc' }).map(r => r.id), [5, 6, 0, 4, 3, 2, 1, 7, 8, 9]);
  assert.deepEqual(rows.map(r => r.id), values.map((_, id) => id));
});
for (const key of ['pickup_volume', 'pph']) for (const dir of ['asc', 'desc']) test('PS1 stable finite numeric sort ' + key + ' ' + dir, () => {
  const values = [null, 5, 0, undefined, '20', NaN, Infinity, 5, -2, false];
  const rows = values.map((value, id) => ({ id, [key]: value })), before = structuredClone(rows);
  const sorted = sortRows(rows, { key, dir });
  assert.deepEqual(sorted.map(r => r.id), dir === 'asc' ? [8, 2, 1, 7, 0, 3, 4, 5, 6, 9] : [1, 7, 2, 8, 0, 3, 4, 5, 6, 9]);
  assert.deepEqual(rows, before); assert.notEqual(sorted, rows);
  assert.deepEqual(sortRows(rows, { key: null, dir }), rows);
  assert.notEqual(sortRows(rows, { key: null, dir }), rows);
});
