import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { planRefresh, parseRefreshScope } from '../src/batch/refresh-plan.js';
import { validateDistricts, readDistricts, defaultDistrictsPath, DistrictConfigInvalidError } from '../src/store/districts-file.js';
import { parseStationBatchArgs } from '../src/config.js';

const district = (id, stations, scrape_disabled) => ({ id, name_zh: id, name_en: id, stations,
  ...(scrape_disabled === undefined ? {} : { scrape_disabled }) });
export const refreshConfig = { schema_version: 1, districts: [
  district('first', ['SFO01', 'MFR01'], { MFR01: 'disabled' }), district('second', ['DEN01'])] };

test('refresh plan validates disabled reasons, ownership and types without changing district output', async t => {
  for (const disabled of [null, [], 'disabled', 1, { MFR01: 'unknown' }, { DEN01: 'disabled' }])
    assert.throws(() => validateDistricts({ schema_version: 1, districts: [district('first', ['MFR01'], disabled)] }), DistrictConfigInvalidError);
  for (const reason of ['disabled', 'no_permission', 'not_in_dms_menu'])
    validateDistricts({ schema_version: 1, districts: [district('first', ['MFR01'], { MFR01: reason })] });
  const dir = await mkdtemp(path.join(tmpdir(), 'nc-refresh-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const districtsPath = path.join(dir, 'districts.json');
  await writeFile(districtsPath, JSON.stringify(refreshConfig));
  const before = await readDistricts({ districtsPath });
  const config = structuredClone(refreshConfig); delete config.districts[0].scrape_disabled;
  await writeFile(districtsPath, JSON.stringify(config));
  assert.deepEqual(await readDistricts({ districtsPath }), before);
});

test('refresh plan preserves order, excludes unassigned, rejects missing districts and handles real Denver config', async () => {
  assert.deepEqual(planRefresh({ config: refreshConfig, scope: { type: 'all' } }), {
    scope: { type: 'all' }, stations: [{ code: 'SFO01', district: 'first' }, { code: 'DEN01', district: 'second' }],
    skipped: [{ code: 'MFR01', district: 'first', reason: 'disabled' }] });
  assert.deepEqual(planRefresh({ config: refreshConfig, scope: parseRefreshScope('district:second') }).stations,
    [{ code: 'DEN01', district: 'second' }]);
  assert.throws(() => planRefresh({ config: refreshConfig, scope: parseRefreshScope('district:unassigned') }), { name: 'DistrictNotFoundError' });
  const config = JSON.parse(await readFile(defaultDistrictsPath, 'utf8'));
  for (const scope of ['all', 'district:denver']) {
    const plan = planRefresh({ config, scope: parseRefreshScope(scope) });
    const expectedSkipped = ['GJT01', 'BZN01'].map(code => ({ code, district: 'denver', reason: 'not_in_dms_menu' }));
    assert.deepEqual(plan.skipped, expectedSkipped);
    assert.ok(plan.stations.every(s => !expectedSkipped.some(skipped => skipped.code === s.code)));
    assert.ok(plan.stations.every(s => s.code !== 'EUG02'));
    if (scope === 'all') assert.deepEqual(plan.stations.filter(s => s.district === 'seattle').map(s => s.code),
      ['SEA01', 'PAE01', 'GEG01', 'YKM01', 'TRC01', 'BOI01', 'PDX01', 'EUG01']);
  }
});

test('refresh arguments reject conflicts, invalid scopes/triggers and missing values', () => {
  for (const scope of ['', 'ALL', 'district:', 'district:Denver', 'district:a_b', 'district:' + 'a'.repeat(33)])
    assert.throws(() => parseRefreshScope(scope));
  for (const args of [['--scope', 'all', '--stations', 'SFO01'], ['--stations', 'SFO01', '--scope', 'all'],
    ['--scope'], ['--trigger', 'invalid'], ['--progress-file'], ['--scope', 'all', '--scope', 'all']])
    assert.throws(() => parseStationBatchArgs(args));
  assert.deepEqual(parseStationBatchArgs(['--scope', 'district:first', '--trigger', 'ui', '--progress-file', 'synthetic.json']).scope,
    { type: 'district', district: 'first' });
});
