import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotationSyncScheduler } from '../src/quotations/quotation-sync-scheduler.js';

test('quotation scheduler disabled, initial delay, serial completion, errors and stop', async () => {
  const timers = new Map(), logs = []; let next = 0, calls = 0, release;
  const options = { setTimeoutImpl: (fn, delay) => { timers.set(++next, { fn, delay }); return next; },
    clearTimeoutImpl: id => timers.delete(id), log: value => logs.push(value) };
  const disabled = createQuotationSyncScheduler({ ...options, intervalMinutes: 0, runOnce: () => assert.fail() });
  disabled.start(); disabled.stop(); assert.equal(timers.size, 0);
  const scheduler = createQuotationSyncScheduler({ ...options, intervalMinutes: 5, runOnce: async () => {
    calls++; if (calls === 1) await new Promise(resolve => { release = resolve; });
    else throw new Error('SECRET-SENTINEL');
  } });
  scheduler.start(); scheduler.start(); assert.equal(timers.size, 1);
  const tick = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); return timer.fn(); };
  assert.equal([...timers.values()][0].delay, 60000);
  const pending = tick(); assert.equal(calls, 1); assert.equal(timers.size, 0);
  scheduler.start(); assert.equal(timers.size, 0);
  release(); await pending; assert.equal([...timers.values()][0].delay, 300000);
  await tick(); assert.equal(calls, 2); assert.equal(timers.size, 1);
  assert.doesNotMatch(logs.join(''), /SECRET/);
  scheduler.stop(); assert.equal(timers.size, 0);
  const active = createQuotationSyncScheduler({ ...options, intervalMinutes: 1, initialDelayMs: 7,
    runOnce: () => new Promise(resolve => { release = resolve; }) });
  active.start(); assert.equal([...timers.values()][0].delay, 7);
  const running = tick(); active.stop(); release(); await running;
  assert.equal(timers.size, 0);
});
