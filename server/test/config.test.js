import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatePath, checkStatePath, parseBaseUrl, parseStationBatchConfig, parseRouteDetailBatchDelay } from '../src/config.js';

test('batch delays keep command defaults, honor overrides and validate lower bounds', () => {
  assert.equal(parseRouteDetailBatchDelay(undefined), 4000);
  assert.equal(parseStationBatchConfig({}).routeDelay, 2000);
  assert.equal(parseStationBatchConfig({}).stationDelay, 15000);
  for (const route of ['2000', '3500', '5000']) {
    assert.equal(parseRouteDetailBatchDelay(route), Number(route));
    assert.equal(parseStationBatchConfig({ ROUTE_DETAIL_BATCH_DELAY_MS: route }).routeDelay, Number(route));
  }
  for (const station of ['10000', '12000', '60000']) {
    assert.equal(parseStationBatchConfig({ STATION_BATCH_DELAY_MS: station }).stationDelay, Number(station));
  }
  for (const value of ['', '-1', '1.5', 'invalid', '9007199254740992']) {
    assert.throws(() => parseRouteDetailBatchDelay(value));
    assert.throws(() => parseStationBatchConfig({ ROUTE_DETAIL_BATCH_DELAY_MS: value }));
    assert.throws(() => parseStationBatchConfig({ STATION_BATCH_DELAY_MS: value }));
  }
  assert.throws(() => parseRouteDetailBatchDelay('1999'));
  assert.throws(() => parseStationBatchConfig({ ROUTE_DETAIL_BATCH_DELAY_MS: '1999' }));
  assert.throws(() => parseStationBatchConfig({ STATION_BATCH_DELAY_MS: '9999' }));
});

const options = { env: { LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local' },
  platform: 'win32', homedir: 'C:\\Users\\owner', repoRoot: 'C:\\work\\repo' };

test('Windows default uses LOCALAPPDATA', () => {
  assert.equal(resolveStatePath(options), 'C:\\Users\\owner\\AppData\\Local\\nc-ops-console\\playwright\\.auth\\dms-state.json');
});
test('override is absolute and relative overrides use repoRoot', () => {
  assert.equal(resolveStatePath({ ...options, env: { DMS_STATE_PATH: 'D:\\state\\custom.json' } }), 'D:\\state\\custom.json');
  assert.equal(resolveStatePath({ ...options, env: { DMS_STATE_PATH: '..\\state\\custom.json' } }), 'C:\\work\\state\\custom.json');
});
for (const candidate of ['C:\\work\\repo', 'C:\\WORK\\REPO\\state.json', 'state.json', '.\\sub\\..\\state.json', '..\\repo\\state.json']) {
  test(`reject repository path: ${candidate}`, () => {
    assert.throws(() => checkStatePath(candidate, options.repoRoot, 'win32'), /拒绝运行/);
  });
}
for (const candidate of ['C:\\work\\repo-other\\state.json', '..\\state.json', 'D:\\state.json']) {
  test(`allow external path: ${candidate}`, () => {
    assert.equal(checkStatePath(candidate, options.repoRoot, 'win32').warnings.length, 0);
  });
}
for (const name of ['oNeDrIvE', 'Dropbox', 'Google Drive', 'iCloud']) {
  test(`warn about sync directory: ${name}`, () => {
    assert.equal(checkStatePath(`D:\\${name}\\state.json`, options.repoRoot, 'win32').warnings.length, 1);
  });
}
test('missing or blank LOCALAPPDATA falls back to home', () => {
  for (const env of [{}, { LOCALAPPDATA: '' }]) {
    assert.equal(resolveStatePath({ ...options, env }), 'C:\\Users\\owner\\.nc-ops-console\\playwright\\.auth\\dms-state.json');
  }
});
test('non-Windows uses home even with LOCALAPPDATA', () => {
  assert.equal(resolveStatePath({ ...options, platform: 'linux', homedir: '/home/owner', repoRoot: '/work/repo' }), '/home/owner/.nc-ops-console/playwright/.auth/dms-state.json');
  assert.throws(() => checkStatePath('./sub/../state.json', '/work/repo', 'linux'), /拒绝运行/);
});
test('URL logging excludes query, hash and credentials', () => {
  assert.equal(parseBaseUrl('https://example.invalid/start?private=value#fragment').display, 'https://example.invalid/start');
  assert.throws(() => parseBaseUrl('https://user:secret@example.invalid'), /不能包含/);
  assert.throws(() => parseBaseUrl('file:///tmp/page'), /HTTP/);
  assert.throws(() => parseBaseUrl('invalid'), /有效/);
  assert.throws(() => parseBaseUrl(''), /本地 .env/);
});
