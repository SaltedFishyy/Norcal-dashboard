import test from 'node:test';
import assert from 'node:assert/strict';
import { readViewDate, withViewDate, apiUrl, dateOptions, formatViewDate, syncNavLinks } from '../../web/date-view.js';
import { createStaticReader, isStaticPath } from '../src/api/static-files.js';
import { fileURLToPath } from 'node:url';

test('DV shared dates validate calendar days and preserve URL context', async () => {
  for (const value of ['', '?date=no', '?date=2026-02-29', '?date=2026-11-08&date=2026-11-09']) assert.equal(readViewDate(value), null);
  assert.equal(readViewDate('?date=2024-02-29'), '2024-02-29');
  assert.equal(withViewDate('/map?station=A&date=2026-11-08#zip', null), '/map?station=A#zip');
  assert.equal(withViewDate('/?district=x', '2026-11-08'), '/?district=x&date=2026-11-08');
  assert.equal(apiUrl('/api/route-profiles', { station: 'A' }, null), '/api/route-profiles?station=A');
  assert.equal(apiUrl('/api/route-details', { route_id: 1 }, '2026-11-08'), '/api/route-details?route_id=1&date=2026-11-08');
  assert.equal(formatViewDate('2026-11-08'), '11/08');
  const year = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric' }).format(new Date());
  assert.deepEqual(dateOptions([{ day: `${year}-11-08`, has_data: false }, { day: '2000-01-01', has_data: true }]), [
    { value: '', label: '最新' }, { value: `${year}-11-08`, label: '11/08（空）' }, { value: '2000-01-01', label: '2000/01/01' }]);
  const link = { href: '/map?station=A', getAttribute() { return this.href; }, setAttribute(_, value) { this.href = value; } };
  syncNavLinks({ querySelectorAll: () => [link] }, '2026-11-08');
  assert.equal(link.href, '/map?station=A&date=2026-11-08');
  assert.ok(isStaticPath('/date-view.js'));
  const asset = await createStaticReader(fileURLToPath(new URL('../../web', import.meta.url)))('/date-view.js');
  assert.match(asset.contentType, /javascript/);
  assert.match(asset.body.toString(), /export function readViewDate/);
});
