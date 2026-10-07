import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readDistricts, validateDistricts, DistrictConfigInvalidError } from '../src/store/districts-file.js';
const config = () => ({ schema_version: 1, districts: [{ id: 'north-cal', name_zh: '北加州片区', name_en: 'North Cal District', stations: ['SFO01', 'OAR01', 'SMF01'] }] });
test('DS configuration rejects invalid schema, empty districts, ids, names and Station ownership', () => {
  for (const mutate of [data => data.schema_version = 2, data => data.districts = [], data => data.districts[0].id = 'BAD',
    data => data.districts[0].id = '', data => data.districts[0].id = 'a'.repeat(33), data => data.districts.push(data.districts[0]),
    data => data.districts[0].name_zh = ' ', data => data.districts[0].name_en = null, data => data.districts[0].stations = ['SFO1'],
    data => data.districts[0].stations = ['SFO01', 'SFO01'], data => data.districts.push({ ...data.districts[0], id: 'second' })]) {
    const data = config(); mutate(data); assert.throws(() => validateDistricts(data), DistrictConfigInvalidError);
  }
  assert.deepEqual(validateDistricts(config()), config());
});
test('DS file merges snapshot availability and alphabetically sorted unassigned, configuration-only extension', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-districts-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const districtsPath = path.join(dir, 'districts.json'); await fs.writeFile(districtsPath, JSON.stringify(config()));
  const profiles = { stations: { SFO01: {}, ZZZ01: {}, AAA01: {} } };
  const districts = await readDistricts({ districtsPath, profiles });
  assert.deepEqual(districts[0].stations, [{ code: 'SFO01', has_snapshot: true }, { code: 'OAR01', has_snapshot: false }, { code: 'SMF01', has_snapshot: false }]);
  assert.equal(districts[1].id, 'unassigned'); assert.deepEqual(districts[1].stations.map(item => item.code), ['AAA01', 'ZZZ01']);
  const extended = config(); extended.districts.push({ id: 'new', name_zh: '新片区', name_en: 'New District', stations: ['AAA01', 'ZZZ01'] });
  await fs.writeFile(districtsPath, JSON.stringify(extended));
  assert.deepEqual((await readDistricts({ districtsPath, profiles })).map(item => item.id), ['north-cal', 'new']);
  await fs.writeFile(districtsPath, '{'); await assert.rejects(readDistricts({ districtsPath }), DistrictConfigInvalidError);
  await assert.rejects(readDistricts({ districtsPath: path.join(dir, 'absent') }), DistrictConfigInvalidError);
});
