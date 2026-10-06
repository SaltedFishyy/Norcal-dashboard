import test from 'node:test';
import assert from 'node:assert/strict';
import { difficultyLevel, difficultyColor, DIFFICULTY_COLORS } from '../../web/difficulty.js';
import { readRouteDetailsForMap } from '../src/store/route-details-file.js';
import { details } from './route-map-fixtures.js';

test('RM5 exact shared difficulty levels and fixed colors', () => {
  const words = ['S级 极难', 'A级 难', 'B级 中', 'C级 易', 'D级 极易'];
  const colors = ['#7e22ce', '#dc2626', '#eab308', '#15803d', '#86efac'];
  words.forEach((word, i) => {
    assert.equal(difficultyLevel(word), 'SABCD'[i]);
    assert.equal(difficultyLevel('  ' + word + '\t'), 'SABCD'[i]);
    assert.equal(difficultyColor('SABCD'[i]), colors[i]);
  });
  for (const value of [null, undefined, '', 1, {}, 'S', 'S级', 'A级  难', 'A级 难 extra', 'toString']) {
    assert.equal(difficultyLevel(value), null);
  }
  for (const level of [null, undefined, 'X', 'toString']) assert.equal(difficultyColor(level), '#9ca3af');
  assert.equal(Object.isFrozen(DIFFICULTY_COLORS), true);
});

test('RM5 optional detail reader is read-only and validates the complete file', async () => {
  const mock = details();
  let contents = JSON.stringify({ schema_version: 1, routes: mock.routes }), failure;
  const fileOps = { readFile: async (filename, encoding) => {
    assert.ok(filename.endsWith('route-details.json')); assert.equal(encoding, 'utf8');
    if (failure) throw failure; return contents;
  } };
  const read = () => readRouteDetailsForMap({ runtimeDir: 'mock-only', fileOps });
  assert.deepEqual(await read(), mock);
  for (const invalid of ['{', '{}', JSON.stringify({ schema_version: 2, routes: {} }),
    JSON.stringify({ schema_version: 1, routes: { '1': { ...mock.routes['1'], zips: [{}] } } })]) {
    contents = invalid; assert.deepEqual(await read(), { status: 'invalid', routes: {} });
  }
  for (const code of ['ENOENT', 'EACCES', 'EIO']) {
    failure = Object.assign(new Error('private path'), { code });
    assert.deepEqual(await read(), { status: code === 'ENOENT' ? 'none' : 'invalid', routes: {} });
  }
});
