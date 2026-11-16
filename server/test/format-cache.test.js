import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { formatNumber, formatUpdated } from '../../web/format.js';

const originalNumber = (value, maximumFractionDigits = 2, minimumFractionDigits = 0) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits, minimumFractionDigits }).format(value);
};
const originalUpdated = value => {
  if (typeof value !== 'string' || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute} ${fields.timeZoneName}`;
};

test('MVR-T13 number output, option combinations and exceptions match the original', () => {
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const value of [0, -1234.5678, 987654.321, null, undefined, '', '12', NaN, Infinity]) {
      for (const [max, min] of [[2, 0], [0, 0], [4, 3], [2, 2], ['2', '1'], [null, null]]) {
        assert.equal(formatNumber(value, max, min), originalNumber(value, max, min));
      }
    }
    for (const args of [[1, -1, 0], [1, 2, 3], [1, NaN, 0], [1, 101, 0]]) {
      assert.throws(() => originalNumber(...args), RangeError);
      assert.throws(() => formatNumber(...args), RangeError);
    }
  }
  let coercions = 0;
  const max = { valueOf() { coercions++; return 2; } };
  formatNumber(1, max); formatNumber(1, max);
  assert.equal(coercions, 2);
  assert.equal(formatNumber(null, -1), '—');
});

test('MVR-T13 updated output retains local timezone and invalid input handling', () => {
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const value of [null, undefined, '', 0, 'invalid', '2026-01-12T00:00:00Z',
      '2026-07-12T23:59:00Z', '2026-11-01T09:30:00Z']) {
      assert.equal(formatUpdated(value), originalUpdated(value));
    }
  }
});

test('MVR-T13 private Pacific formatter reuses its instance and retains RangeError', async () => {
  // Exercise the private helper without widening the production export surface.
  const source = await readFile(new URL('../../web/data-status.js', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('let pacificFormatter;'), source.indexOf('export function createDataStatus'));
  let constructions = 0;
  const context = { Intl: { DateTimeFormat: function (...args) {
    constructions++; return new Intl.DateTimeFormat(...args);
  } } };
  const pacificTime = vm.runInNewContext(`${helper}\npacificTime`, context);
  const original = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '—';
  assert.equal(pacificTime(null), '—'); assert.equal(constructions, 0);
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const value of [null, undefined, '', 0, false, '2026-01-12T00:00:00Z', '2026-07-12T23:59:00Z', '2026-11-01T09:30:00Z']) {
      assert.equal(pacificTime(value), original(value));
    }
    assert.throws(() => pacificTime('invalid'), { name: 'RangeError', message: 'Invalid time value' });
  }
  assert.equal(constructions, 1);
});

test('MVR-T13 format module lazily constructs one formatter per option combination', async t => {
  const NativeNumber = Intl.NumberFormat, NativeDate = Intl.DateTimeFormat;
  let numbers = 0, dates = 0;
  t.mock.method(Intl, 'NumberFormat', function (...args) { numbers++; return new NativeNumber(...args); });
  t.mock.method(Intl, 'DateTimeFormat', function (...args) { dates++; return new NativeDate(...args); });
  const fresh = await import('../../web/format.js?mvr-t13-cache-test');
  assert.equal(numbers, 0); assert.equal(dates, 0);
  fresh.formatNumber(null); fresh.formatUpdated('invalid');
  assert.equal(numbers, 0); assert.equal(dates, 0);
  for (let repeat = 0; repeat < 3; repeat++) {
    fresh.formatNumber(12.345, 2, 0); fresh.formatNumber(12.345, 4, 3);
    fresh.formatUpdated('2026-07-12T23:59:00Z');
  }
  assert.equal(numbers, 2); assert.equal(dates, 1);
});
