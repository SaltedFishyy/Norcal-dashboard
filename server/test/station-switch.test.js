import test from 'node:test';
import assert from 'node:assert/strict';
import { readCurrentStation, switchStation, StationSwitchError, assertCurrentStation } from '../src/dms/station-switch.js';
import { stationPage } from './multi-station-fixtures.js';
import { diagnosticMessage } from '../src/dms/batch-diagnostics.js';
test('MS switch uses exact header and locator menu, listens before clicking, and restores', async () => {
  const h = stationPage(); assert.equal(await readCurrentStation(h.context), 'SFO01');
  assert.equal(await switchStation(h.context, 'SFO01'), false);
  assert.equal(await switchStation(h.context, 'MFR01'), true); await assertCurrentStation(h.context, 'MFR01');
  assert.equal(await switchStation(h.context, 'SFO01'), true);
  assert.deepEqual(h.events.filter(value => value.startsWith('switch:')), ['switch:MFR01', 'switch:SFO01']);
  assert.ok(h.events.includes('locator-scroll:MFR01'));
});
for (const options of [{ headerCount: 0 }, { headerCount: 2 }, { menuCount: 0 }, { menuCount: 2 }, { switchStatus: 403 }, { switchTimeout: true }, { headerChanges: false }, { listStatus: 400 }]) {
  test(`MS switch stops on ${JSON.stringify(options)}`, async () => {
    const h = stationPage(options); await assert.rejects(switchStation(h.context, 'MFR01'), StationSwitchError);
  });
}

for (const count of [0, 2]) test(`MS reload header count ${count} for two seconds waits before success`, async () => {
  const h = stationPage({ headerState: (station, elapsed) => ({ count: station === 'MFR01' && elapsed < 2000 ? count : 1 }) });
  assert.equal(await switchStation(h.context, 'MFR01'), true);
  assert.equal(h.events.filter(event => event === 'delay:200').length, 10);
  assert.ok(h.events.indexOf('load:networkidle:30000') < h.events.indexOf('delay:200'));
});
test('MS reload invalid or hidden header waits, strict write check never accepts duplicates or other station', async () => {
  const h = stationPage({ headerState: (station, elapsed) => station === 'MFR01' && elapsed < 400
    ? { text: 'Loading', visible: elapsed >= 200 } : {} });
  assert.equal(await switchStation(h.context, 'MFR01'), true);
  await assert.rejects(assertCurrentStation(h.context, 'SFO01'), { name: 'StationMismatchError' });
  await assert.rejects(readCurrentStation(stationPage({ headerCount: 2 }).context), /数量为 2/);
});
test('MS old header timeout includes current and target station in diagnostics', async () => {
  const h = stationPage({ headerChanges: false });
  await assert.rejects(switchStation(h.context, 'MFR01'), error => {
    assert.match(diagnosticMessage(error), /MFR01.*SFO01/); return true;
  });
});
test('MS missed automatic list and networkidle timeout are advisory, observed HTTP failure still stops', async () => {
  const h = stationPage({ automaticListMissed: true, networkIdleTimeout: true });
  assert.equal(await switchStation(h.context, 'MFR01'), true);
  assert.equal(h.context.automaticListSeen, false);
  await assert.rejects(switchStation(stationPage({ automaticListStatus: 500 }).context, 'MFR01'), /自动列表状态码 500/);
});
test('MS switch error preserves original cause first line and specific menu/status reasons', async () => {
  const h = stationPage();
  h.page.waitForLoadState = async () => { throw new Error('reload interrupted\ncall log'); };
  await assert.rejects(switchStation(h.context, 'MFR01'), error => {
    assert.match(error.message, /等待页面重载/);
    assert.equal(diagnosticMessage(error), 'reload interrupted'); return true;
  });
  await assert.rejects(switchStation(stationPage({ menuCount: 2 }).context, 'MFR01'), /菜单项数量为 2/);
  await assert.rejects(switchStation(stationPage({ switchStatus: 403 }).context, 'MFR01'), /switch-org 状态码 403/);
});
test('MS strict header check waits for visibility with five second bound and retains timeout cause', async () => {
  const h = stationPage();
  const locator = h.page.locator;
  let ready = false;
  h.page.locator = selector => ({ ...locator(selector),
    waitFor: async options => {
      assert.deepEqual(options, { state: 'visible', timeout: 5000 });
      await h.page.waitForTimeout(200); ready = true;
    }, count: async () => { assert.equal(ready, true); return 1; } });
  assert.equal(await readCurrentStation(h.context), 'SFO01');
  const cause = Object.assign(new Error('header visibility timeout'), { name: 'TimeoutError' });
  h.page.locator = selector => ({ ...locator(selector), waitFor: async () => { throw cause; } });
  await assert.rejects(readCurrentStation(h.context), error => {
    assert.equal(error.name, 'StationSwitchError'); assert.equal(error.cause, cause); return true;
  });
});
test('MS observed automatic list unsuccessful payload stops even with HTTP 200', async () => {
  const h = stationPage({ mutateBody: value => ({ ...value, success: false }) });
  await assert.rejects(switchStation(h.context, 'MFR01'), /自动列表响应未成功/);
});
