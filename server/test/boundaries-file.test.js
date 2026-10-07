import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readBoundaries, validateBoundaries, BoundaryInvalidError, BoundaryNotFoundError } from '../src/store/boundaries-file.js';
import { rawBoundaries as boundaries } from './route-map-fixtures.js';

const read = data => readBoundaries({ geoDir: 'unused', fileOps: { readdir: async () => ['zcta2020_ca_nv_or.meta.json'], readFile: async filename =>
  JSON.stringify(filename.endsWith('.geojson') ? data.geojson : data.meta) } });

test('boundary reader validates Polygon and MultiPolygon without changing source data', async () => {
  const data = boundaries(); const before = structuredClone(data);
  assert.deepEqual((await read(data)).geojson, before.geojson); assert.deepEqual(data, before);
  const feature = data.geojson.features[0];
  feature.geometry = { type: 'MultiPolygon', coordinates: [feature.geometry.coordinates] };
  assert.deepEqual((await read(data)).geojson, data.geojson);
});

test('boundary index preserves ZIP strings and geometry, and scope works for absent ZIPs too', async () => {
  const data = boundaries(), result = await read(data);
  assert.equal(result.byZip.size, 3);
  assert.deepEqual(result.byZip.get('00123'), data.geojson.features[0].geometry);
  assert.equal(result.byZip.get('00004'), undefined);
  assert.equal(result.inScope('00004'), true);
  for (const value of ['00005', '123', 123, null]) assert.equal(result.inScope(value), false);
});

for (const [name, mutate] of [
  ['collection type', d => d.geojson.type = 'Feature'],
  ['features type', d => d.geojson.features = {}],
  ['feature type', d => d.geojson.features[0].type = 'wrong'],
  ['geometry type', d => d.geojson.features[0].geometry.type = 'Point'],
  ['coordinates', d => d.geojson.features[0].geometry.coordinates = []],
  ['unclosed ring', d => d.geojson.features[0].geometry.coordinates[0][3] = [2, 2]],
  ['non-numeric coordinate', d => d.geojson.features[0].geometry.coordinates[0][1] = ['1', 0]],
  ['missing geometry', d => delete d.geojson.features[0].geometry],
  ['numeric ZIP', d => d.geojson.features[0].properties.postal_code = 12345],
  ['invalid ZIP', d => d.geojson.features[0].properties.postal_code = 'abcde'],
  ['duplicate ZIP', d => d.geojson.features.push(d.geojson.features[0])],
  ['missing properties', d => delete d.geojson.features[0].properties],
  ['missing scope', d => delete d.meta.scope],
  ['pattern type', d => d.meta.scope.postal_code_pattern = 2],
  ['invalid pattern', d => d.meta.scope.postal_code_pattern = '['],
  ['empty pattern', d => d.meta.scope.postal_code_pattern = ''],
  ['out of scope feature', d => d.meta.scope.postal_code_pattern = '^9'],
  ['feature count', d => d.meta.feature_count = 99],
  ['feature count type', d => d.meta.feature_count = '3'],
  ['dataset', d => delete d.meta.dataset],
  ['vintage', d => d.meta.vintage = '2020'],
  ['missing meta', d => d.meta = null],
]) test(`boundary rejects ${name}`, async () => {
  const data = boundaries(); mutate(data);
  await assert.rejects(read(data), BoundaryInvalidError);
});

test('boundary file errors and malformed JSON are sanitized', async () => {
  for (const [code, expected] of [['ENOENT', BoundaryInvalidError], ['EACCES', BoundaryInvalidError]]) {
    await assert.rejects(readBoundaries({ geoDir: 'private-path', fileOps: { readdir: async () => ['zcta2020_ca_nv_or.meta.json'], readFile: async () => {
      throw Object.assign(new Error('private-path secret stack'), { code });
    } } }), error => { assert.ok(error instanceof expected); assert.doesNotMatch(error.message, /private|secret|stack/); return true; });
  }
  await assert.rejects(readBoundaries({ geoDir: 'unused', fileOps: { readdir: async () => ['zcta2020_ca_nv_or.meta.json'], readFile: async () => '{' } }), BoundaryInvalidError);
  assert.throws(() => validateBoundaries(null, null), BoundaryInvalidError);
});

test('checked-in public Census boundary files satisfy the boundary contract', async () => {
  const result = await readBoundaries({ geoDir: fileURLToPath(new URL('../../geo/', import.meta.url)) });
  assert.equal(result.geojson.features.length, 4542);
  assert.equal(result.byZip.size, 4542);
  assert.ok(result.inScope('95812')); assert.ok(!result.inScope('10001'));
  assert.equal(result.byZip.get('95814').type, 'Polygon');
  assert.equal(await readBoundaries({ geoDir: fileURLToPath(new URL('../../geo/', import.meta.url)) }), result);
});

const readRegions = entries => readBoundaries({ geoDir: 'synthetic-only', fileOps: {
  readdir: async () => Object.keys(entries).reverse(),
  readFile: async filename => {
    const name = filename.split(/[\\/]/).at(-1);
    if (!(name in entries)) throw Object.assign(new Error('private missing path'), { code: 'ENOENT' });
    return JSON.stringify(entries[name]);
  },
} });
const regions = () => {
  const a = boundaries(), b = boundaries();
  a.meta.boundary_file = 'a.geojson';
  b.meta.boundary_file = 'b.geojson'; b.meta.scope.postal_code_pattern = '^8';
  b.geojson.features.forEach((feature, i) => feature.properties.postal_code = '8000' + i);
  return { 'a.meta.json': a.meta, 'a.geojson': a.geojson, 'b.meta.json': b.meta, 'b.geojson': b.geojson };
};
test('multiple regions merge in filename order and union scope including absent ZIPs', async () => {
  const data = regions(), result = await readRegions(data);
  assert.deepEqual([...result.byZip.keys()], ['00123', '00002', '00009', '80000', '80001', '80002']);
  assert.equal(result.geojson.features.length, 6);
  assert.equal(result.meta.dataset, 'mock-census'); assert.equal(result.meta.vintage, 2020);
  for (const zip of ['00004', '80099']) assert.equal(result.inScope(zip), true);
  assert.equal(result.inScope('90000'), false);
});
for (const [name, mutate] of [
  ['duplicate ZIP across regions', d => { d['b.geojson'].features[0].properties.postal_code = '00123'; d['b.meta.json'].scope.postal_code_pattern = '^(8|00123)'; }],
  ['different dataset', d => d['b.meta.json'].dataset = 'other'],
  ['different vintage', d => d['b.meta.json'].vintage = 2010],
  ['missing referenced file', d => delete d['b.geojson']],
  ['missing boundary_file', d => delete d['b.meta.json'].boundary_file],
  ['path outside geo directory', d => d['b.meta.json'].boundary_file = '../b.geojson'],
]) test('multiple regions reject ' + name, async () => {
  const data = regions(); mutate(data); await assert.rejects(readRegions(data), BoundaryInvalidError);
});
test('no metadata and missing directory return not found; directory errors are sanitized', async () => {
  await assert.rejects(readRegions({ 'ignored.geojson': {} }), BoundaryNotFoundError);
  for (const [code, type] of [['ENOENT', BoundaryNotFoundError], ['EACCES', BoundaryInvalidError]]) {
    await assert.rejects(readBoundaries({ geoDir: 'unused', fileOps: { readdir: async () => {
      throw Object.assign(new Error('private path'), { code });
    } } }), type);
  }
});
test('successful default reads cache; failed reads retry; injected operations bypass cache', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const geoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-boundary-mock-'));
  t.after(() => fs.rm(geoDir, { recursive: true, force: true }));
  await assert.rejects(readBoundaries({ geoDir }), BoundaryNotFoundError);
  const data = regions();
  for (const [name, value] of Object.entries(data)) await fs.writeFile(path.join(geoDir, name), JSON.stringify(value));
  const result = await readBoundaries({ geoDir });
  await fs.writeFile(path.join(geoDir, 'a.meta.json'), '{');
  assert.equal(await readBoundaries({ geoDir }), result);
  assert.notEqual(await readRegions(data), await readRegions(data));
});
